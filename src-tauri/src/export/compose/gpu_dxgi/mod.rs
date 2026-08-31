//! Zero-copy D3D11 compose: MF DXGI decode → video processor → DXGI NV12 encode.

use std::path::Path;

use windows::core::Interface;
use windows::Win32::Media::MediaFoundation::IMFMediaEventGenerator;

use crate::export::audio::{probe_copyable_audio, AacFeeder};
use crate::export::progress::expected_compose_frames;
use crate::export::types::{ComposeMode, ComposeReport, WebcamComposeOpts};
use crate::overlay::OverlayLayout;

use crate::export::compose::sizing::fit_compose_size;

mod decode;
mod device;
mod diagnostics;
mod encoder;
mod output;
mod probes;
mod video_processor;
mod webcam;

pub(crate) use probes::run_blank_direct_mft_long_test;

use decode::{log_dxgi_format, open_dxgi_reader, read_dxgi_sample, reader_transform_name, seek_hns};
use device::SharedGpu;
use diagnostics::env_flag;
use encoder::{
    activate_named_h264_encoder, configure_direct_encoder, d3d11_aware, gpu_encoder_bitrate,
    log_nvidia_selection, pick_direct_encoder_name,
};
use output::{encoder_sample_time_hns, run_direct_compose_loop};
use video_processor::VideoCompositor;
use webcam::DxgiWebcam;

pub(super) const GPU_ENCODER_W: u32 = 1920;
pub(super) const GPU_ENCODER_H: u32 = 1080;
pub(super) const HNS_PER_SECOND: i64 = 10_000_000;
pub(super) const ENCODER_FPS: u32 = 60;
pub(super) const BOUNDARY_LOG_FROM: u64 = 10_460;
pub(super) const SURFACE_PROBE_FRAME: u64 = 10_476;

pub fn compose(
    gameplay: &Path,
    webcam: &Path,
    output: &Path,
    layout: &OverlayLayout,
    start_hns: i64,
    end_hns: i64,
    fps: u32,
    opts: WebcamComposeOpts,
) -> Result<ComposeReport, String> {
    let started = super::now();
    super::log_attempt(ComposeMode::GpuDxgi, "D3D11 video processor");
    let gpu = SharedGpu::open()?;
    let gameplay_reader = open_dxgi_reader(gameplay, &gpu.manager)?;
    if start_hns > 0 {
        seek_hns(&gameplay_reader, start_hns)?;
    }
    let mut cam = DxgiWebcam::open(webcam, &gpu.manager, start_hns, end_hns)?;
    let first =
        read_dxgi_sample(&gameplay_reader)?.ok_or_else(|| "That clip has no video.".to_string())?;
    if first.timestamp >= end_hns {
        return Err("That range did not include any video.".into());
    }
    let fps = fps.clamp(24, 60);
    let (out_w, out_h) =
        fit_compose_size(first.width, first.height, opts.max_width, opts.max_height);
    let expected = expected_compose_frames(start_hns, end_hns, fps);
    if let Some(progress) = opts.progress.as_ref() {
        progress(0, expected);
    }
    if (out_w, out_h) != (first.width, first.height) {
        tracing::info!(
            src = format!("{}x{}", first.width, first.height),
            dest = format!("{out_w}x{out_h}"),
            "gpu_dxgi scaling webcam compose for cloud upload"
        );
    }

    let decoder =
        reader_transform_name(&gameplay_reader).unwrap_or_else(|| "NV12 DXGI decoder".into());
    let mut compositor =
        VideoCompositor::open(&gpu, first.width, first.height, GPU_ENCODER_W, GPU_ENCODER_H, fps)?;
    let mux_no_audio = env_flag("REPLAYR_GPU_MUX_NO_AUDIO");
    let copy_audio = if mux_no_audio {
        tracing::warn!("REPLAYR_GPU_MUX_NO_AUDIO=1; muxing video only for isolation");
        None
    } else {
        probe_copyable_audio(gameplay)
    };
    let audio_mode = if copy_audio.is_some() {
        "aac_copy"
    } else {
        "none"
    };
    let inventory = crate::camera::encoder::log_h264_inventory();
    let encoder_name = pick_direct_encoder_name(&inventory);
    log_nvidia_selection(&inventory, &encoder_name);
    let transform = activate_named_h264_encoder(&encoder_name).ok_or_else(|| {
        format!("Could not activate the direct H.264 encoder {encoder_name}")
    })?;
    let bound_aware = d3d11_aware(&transform);
    let bitrate = gpu_encoder_bitrate(opts.quality, fps);
    configure_direct_encoder(&transform, &gpu, bound_aware, fps, bitrate)?;
    let events: IMFMediaEventGenerator = transform
        .cast()
        .map_err(|err| format!("Direct encoder has no event generator: {err}"))?;
    tracing::info!(
        fit_dest = format!("{out_w}x{out_h}"),
        encoder_dest = format!("{GPU_ENCODER_W}x{GPU_ENCODER_H}"),
        encoder = %encoder_name,
        mf_sa_d3d11_aware = bound_aware,
        quality = ?opts.quality,
        requested_bitrate = bitrate,
        "gpu_dxgi using VideoProcessor + direct async H.264 MFT + proven H.264 mux"
    );
    tracing::info!(
        mode = "gpu_dxgi",
        decoder = %decoder,
        compositor = "d3d11_video_processor",
        encoder = %encoder_name,
        adapter = %gpu.adapter,
        dxgi = true,
        hardware = true,
        audio = audio_mode,
        dest = format!("{GPU_ENCODER_W}x{GPU_ENCODER_H}"),
        overlay = %layout.shape,
        "gpu_dxgi compose encoder opened (direct MFT; dest-rect overlay)"
    );
    log_dxgi_format("gameplay", &first);
    if let Some(cam) = cam.current.as_ref() {
        log_dxgi_format("webcam", cam);
    }
    let mut feeder = if copy_audio.is_some() {
        match AacFeeder::open(gameplay, start_hns, end_hns) {
            Ok(feeder) => Some(feeder),
            Err(err) => {
                tracing::warn!(%err, "Could not open AAC for progressive mux; cloud file has video only");
                None
            }
        }
    } else {
        None
    };
    let (stats, mut mux) = run_direct_compose_loop(
        &gpu,
        &mut compositor,
        &transform,
        &events,
        &gameplay_reader,
        &mut cam,
        first,
        layout,
        start_hns,
        end_hns,
        fps,
        expected,
        opts.progress.as_ref(),
        output,
        copy_audio.as_ref(),
        feeder.as_mut(),
    )?;
    drop(gameplay_reader);
    drop(cam);

    let audio = match feeder.as_mut() {
        Some(feeder) => match feeder.finish(&mut mux) {
            Ok(()) => {
                tracing::info!(
                    aac_samples = feeder.samples_written(),
                    audio_mux_hns = mux.audio_time_hns(),
                    "progressive AAC interleave drained"
                );
                "aac_copy".to_string()
            }
            Err(err) => {
                tracing::warn!(%err, "AAC tail drain failed; cloud file keeps the audio written so far");
                "aac_copy".to_string()
            }
        },
        None => "none".into(),
    };
    let written_ms = encoder_sample_time_hns(stats.encoded, fps) / 10_000;
    mux.finish()?;
    if stats.composed == 0 || stats.encoded == 0 {
        return Err("That range did not include any video.".into());
    }
    if let Some(progress) = opts.progress.as_ref() {
        let composed = u32::try_from(stats.composed).unwrap_or(u32::MAX);
        progress(composed, expected.max(composed));
    }
    let elapsed_ms = started.elapsed().as_millis();
    let compose_fps = if elapsed_ms == 0 {
        0.0
    } else {
        stats.composed as f64 * 1000.0 / elapsed_ms as f64
    };
    let realtime = if elapsed_ms == 0 {
        0.0
    } else {
        written_ms as f64 / elapsed_ms as f64
    };
    tracing::info!(
        vp_input = "NV12",
        vp_output = "NV12 1920x1080",
        frames_composed = stats.composed,
        frames_encoded = stats.encoded,
        dropped_frames = stats.dropped,
        cpu_map_count = 0,
        elapsed_ms,
        compose_fps = format!("{compose_fps:.1}"),
        realtime_factor = format!("{realtime:.2}"),
        drain = %stats.drain,
        "gpu_dxgi VideoProcessor + direct MFT compose finished"
    );
    Ok(ComposeReport {
        mode: ComposeMode::GpuDxgi,
        decoder,
        compositor: "d3d11_video_processor".into(),
        encoder: encoder_name,
        dxgi: true,
        hardware: true,
        audio,
        frames: u32::try_from(stats.encoded).unwrap_or(u32::MAX),
        written_ms,
        elapsed_ms,
    })
}