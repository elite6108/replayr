use std::path::Path;
use std::thread;
use std::time::{Duration, Instant};

use windows::Win32::Graphics::Direct3D11::D3D11_BIND_VIDEO_ENCODER;
use windows::Win32::Media::MediaFoundation::{
    IMFMediaEventGenerator, IMFSourceReader, IMFTransform, MEError, METransformDrainComplete,
    METransformHaveOutput, METransformNeedInput, MFSampleExtension_CleanPoint,
    MFT_MESSAGE_COMMAND_DRAIN, MFT_MESSAGE_NOTIFY_END_OF_STREAM, MFT_MESSAGE_NOTIFY_END_STREAMING,
    MF_EVENT_FLAG_NO_WAIT,
};

use crate::export::audio::AacFeeder;
use crate::export::mux::H264Mp4Mux;
use crate::export::types::ComposeProgress;
use crate::overlay::OverlayLayout;

use super::BOUNDARY_LOG_FROM;
use super::SURFACE_PROBE_FRAME;
use super::GPU_ENCODER_H;
use super::GPU_ENCODER_W;
use super::HNS_PER_SECOND;
use super::decode::{log_dxgi_format, read_dxgi_sample, DxgiFrame};
use super::device::{
    create_blank_nv12, drain_d3d_debug, gpu_copy_full_nv12, gpu_copy_nv12_box, gpu_fail,
    vram_usage, SharedGpu, QUERY_WAIT,
};
use super::diagnostics::{
    compare_surface_hops, dump_complete_media_type, dump_texture, hr_u32,
    log_surface_transition, surface_probe_mode, SurfaceHop,
};
use super::encoder::{
    event_name, process_input_hr, send_lifecycle, take_encoded_output, wrap_composed_frame,
    EncodedNalu,
};
use super::video_processor::VideoCompositor;
use super::webcam::DxgiWebcam;

pub(super) const COMPOSE_TIMEOUT: Duration = Duration::from_secs(180);
pub(super) const COMPOSE_DRAIN_TIMEOUT: Duration = Duration::from_secs(15);

pub(super) struct ComposeLoopStats {
    pub(super) composed: u64,
    pub(super) encoded: u64,
    pub(super) dropped: u64,
    need_input: u64,
    have_output: u64,
    pub(super) drain: String,
}

pub(super) fn encoder_frame_duration_hns(fps: u32) -> i64 {
    HNS_PER_SECOND / i64::from(fps.max(1))
}

pub(super) fn encoder_sample_time_hns(frame_index: u64, fps: u32) -> i64 {
    let fps = i64::from(fps.max(1));
    i64::try_from(frame_index)
        .unwrap_or(i64::MAX)
        .saturating_mul(HNS_PER_SECOND)
        / fps
}

/// One second of audio lead keeps the MP4 sink's interleave queue bounded: the sink can
/// flush every video sample up to the video clock instead of holding the whole clip.
const AUDIO_LEAD_HNS: i64 = 10_000_000;

/// Writes one encoded video sample and then advances the audio stream so the mux never
/// sits with video far ahead of audio.
fn write_video_then_feed_audio(
    mux: &mut H264Mp4Mux,
    feeder: Option<&mut AacFeeder>,
    nalu: &EncodedNalu,
    telemetry: &mut MuxTelemetry,
) -> Result<(), String> {
    mux.write_video(&nalu.sample)?;
    telemetry.h264_bytes_retained = telemetry
        .h264_bytes_retained
        .saturating_add(u64::from(nalu.size));
    if nalu.hmft_owned {
        telemetry.hmft_samples_held += 1;
    }
    if let Some(time) = nalu.time {
        telemetry.video_mux_hns = time;
    }
    if let Some(feeder) = feeder {
        if mux.has_audio() {
            let target = telemetry.video_mux_hns.saturating_add(AUDIO_LEAD_HNS);
            feeder.feed_until(mux, target)?;
        }
    }
    telemetry.audio_mux_hns = mux.audio_time_hns();
    Ok(())
}

fn wait_for_free_output(
    compositor: &mut VideoCompositor,
    gpu: &SharedGpu,
    transform: &IMFTransform,
    events: &IMFMediaEventGenerator,
    mux: &mut Option<H264Mp4Mux>,
    output: &Path,
    audio_type: Option<&windows::Win32::Media::MediaFoundation::IMFMediaType>,
    stats: &mut ComposeLoopStats,
    feeder: Option<&mut AacFeeder>,
    telemetry: &mut MuxTelemetry,
) -> Result<(), String> {
    if compositor.has_free_output() {
        return Ok(());
    }
    let deadline = Instant::now() + QUERY_WAIT;
    let mut feeder = feeder;
    while !compositor.has_free_output() {
        if Instant::now() > deadline {
            let diag = compositor.diag(stats.composed, stats.encoded, true, true);
            return Err(gpu_fail(gpu, "output_ring_full", 0x887A000A, &diag));
        }
        match unsafe { events.GetEvent(MF_EVENT_FLAG_NO_WAIT) } {
            Ok(event) => {
                let ty = unsafe { event.GetType().unwrap_or(0) };
                let status = unsafe { event.GetStatus().ok() };
                if status.is_some_and(|hr| hr.is_err()) || ty == MEError.0 as u32 {
                    let hr = status
                        .map(|h| format!("{:#x}", h.0 as u32))
                        .unwrap_or_else(|| "n/a".into());
                    return Err(format!(
                        "direct MFT event {} status={hr} while waiting for a free output slot",
                        event_name(ty)
                    ));
                }
                if ty == METransformHaveOutput.0 as u32 {
                    let nalu = take_encoded_output(transform, false)?;
                    if mux.is_none() {
                        let mux_type = unsafe { transform.GetOutputCurrentType(0) }.map_err(|err| {
                            format!(
                                "GetOutputCurrentType after first H.264 hr={:#x} {err}",
                                err.code().0 as u32
                            )
                        })?;
                        *mux = Some(H264Mp4Mux::create(output, &mux_type, audio_type)?);
                    }
                    if let Some(opened) = mux.as_mut() {
                        write_video_then_feed_audio(
                            opened,
                            feeder.as_deref_mut(),
                            &nalu,
                            telemetry,
                        )?;
                    }
                    compositor.release_encoder();
                    stats.encoded += 1;
                }
            }
            Err(_) => thread::sleep(Duration::from_millis(1)),
        }
    }
    Ok(())
}

pub(super) fn run_direct_compose_loop(
    gpu: &SharedGpu,
    compositor: &mut VideoCompositor,
    transform: &IMFTransform,
    events: &IMFMediaEventGenerator,
    gameplay_reader: &IMFSourceReader,
    cam: &mut DxgiWebcam,
    first: DxgiFrame,
    layout: &OverlayLayout,
    _start_hns: i64,
    end_hns: i64,
    fps: u32,
    expected: u32,
    progress: Option<&ComposeProgress>,
    output: &Path,
    audio_type: Option<&windows::Win32::Media::MediaFoundation::IMFMediaType>,
    mut feeder: Option<&mut AacFeeder>,
) -> Result<(ComposeLoopStats, H264Mp4Mux), String> {
    let frame_duration = encoder_frame_duration_hns(fps);
    let mut stats = ComposeLoopStats {
        composed: 0,
        encoded: 0,
        dropped: 0,
        need_input: 0,
        have_output: 0,
        drain: "not_started".into(),
    };
    let mut current = Some(first);
    let mut gameplay_done = false;
    let mut draining = false;
    let mut drain_complete = false;
    let mut logged_first_blt = false;
    let mut mux = None;
    let mut prev_encoder_time = i64::MIN;
    let mut prev_source_time = i64::MIN;
    let mut last_hops: Option<(u64, Vec<SurfaceHop>)> = None;
    let mut telemetry = MuxTelemetry {
        h264_bytes_retained: 0,
        hmft_samples_held: 0,
        video_mux_hns: 0,
        audio_mux_hns: 0,
    };
    let probe = surface_probe_mode();
    if let Some(mode) = probe {
        tracing::info!(probe = %mode, frame = SURFACE_PROBE_FRAME, "surface probe armed");
    }
    let deadline = Instant::now() + COMPOSE_TIMEOUT;

    while Instant::now() < deadline && !drain_complete {
        if !draining && gameplay_done && current.is_none() {
            send_lifecycle(transform, "NOTIFY_END_OF_STREAM", MFT_MESSAGE_NOTIFY_END_OF_STREAM);
            send_lifecycle(transform, "COMMAND_DRAIN", MFT_MESSAGE_COMMAND_DRAIN);
            draining = true;
            stats.drain = "drain_sent".into();
        }
        match unsafe { events.GetEvent(MF_EVENT_FLAG_NO_WAIT) } {
            Ok(event) => {
                let ty = unsafe { event.GetType().unwrap_or(0) };
                let status = unsafe { event.GetStatus().ok() };
                if status.is_some_and(|hr| hr.is_err()) || ty == MEError.0 as u32 {
                    let hr = status
                        .map(|h| format!("{:#x}", h.0 as u32))
                        .unwrap_or_else(|| "n/a".into());
                    return Err(format!("direct MFT event {} status={hr}", event_name(ty)));
                }
                if ty == METransformNeedInput.0 as u32 && !draining {
                    stats.need_input += 1;
                    match current.take() {
                        Some(frame) => {
                            if frame.timestamp >= end_hns {
                                gameplay_done = true;
                                stats.dropped += 1;
                            } else {
                                if let Err(err) = wait_for_free_output(
                                    compositor,
                                    gpu,
                                    transform,
                                    events,
                                    &mut mux,
                                    output,
                                    audio_type,
                                    &mut stats,
                                    feeder.as_deref_mut(),
                                    &mut telemetry,
                                ) {
                                    return Err(err);
                                }
                                cam.ensure_at(frame.timestamp);
                                if stats.composed == 0 {
                                    if let Some(cam_frame) = cam.current.as_ref() {
                                        log_dxgi_format("webcam", cam_frame);
                                    }
                                }
                                let diag = compositor.diag(
                                    stats.composed,
                                    stats.encoded,
                                    current.is_some(),
                                    cam.current.is_some(),
                                );
                                let source_time = frame.timestamp;
                                let time = encoder_sample_time_hns(stats.composed, fps);
                                cam.log_sample(time, false);
                                let duration = frame_duration;
                                let time_delta = if prev_encoder_time == i64::MIN {
                                    0
                                } else {
                                    time.saturating_sub(prev_encoder_time)
                                };
                                let source_delta = if prev_source_time == i64::MIN {
                                    0
                                } else {
                                    source_time.saturating_sub(prev_source_time)
                                };
                                let monotonic = prev_encoder_time == i64::MIN || time > prev_encoder_time;
                                let at_probe = stats.composed == SURFACE_PROBE_FRAME && probe.is_some();
                                let (encoder_tex, blit, mut hops) = if at_probe && probe == Some('A') {
                                    let owned = compositor
                                        .copy_gameplay_owned(gpu, &frame, &diag, stats.composed)
                                        .map_err(|err| {
                                            let fail = compositor.diag(
                                                stats.composed,
                                                stats.encoded,
                                                false,
                                                cam.current.is_some(),
                                            );
                                            gpu_fail(gpu, "probe_A_owned_copy", hr_u32(&err), &fail)
                                        })?;
                                    drain_d3d_debug(gpu, stats.composed, "probe_A_owned_copy");
                                    let normalized = gpu_copy_nv12_box(
                                        gpu,
                                        &owned.owned_gameplay,
                                        0,
                                        GPU_ENCODER_W,
                                        GPU_ENCODER_H,
                                        &diag,
                                    )?;
                                    let mut hops = owned.hops.clone();
                                    hops.push(log_surface_transition(
                                        stats.composed,
                                        "probe_A_normalized_owned",
                                        Some(&normalized),
                                        0,
                                        owned.input_slot as i64,
                                        owned.decoder_slice,
                                        "0x0",
                                    ));
                                    drain_d3d_debug(gpu, stats.composed, "probe_A_normalize");
                                    (normalized, owned, hops)
                                } else {
                                    let blit = compositor
                                        .blit(
                                            gpu,
                                            &frame,
                                            cam.current.as_ref(),
                                            layout,
                                            &diag,
                                            stats.composed,
                                        )
                                        .map_err(|err| {
                                            let fail = compositor.diag(
                                                stats.composed,
                                                stats.encoded,
                                                false,
                                                cam.current.is_some(),
                                            );
                                            gpu_fail(gpu, "VideoProcessorBlt", hr_u32(&err), &fail)
                                        })?;
                                    drain_d3d_debug(gpu, stats.composed, "videoprocessor_blt");
                                    let mut hops = blit.hops.clone();
                                    let encoder_tex = if at_probe && probe == Some('B') {
                                        let blank = create_blank_nv12(
                                            &gpu.device,
                                            GPU_ENCODER_W,
                                            GPU_ENCODER_H,
                                            D3D11_BIND_VIDEO_ENCODER.0 as u32,
                                        )?;
                                        hops.push(log_surface_transition(
                                            stats.composed,
                                            "probe_B_blank",
                                            Some(&blank),
                                            0,
                                            blit.output_slot as i64,
                                            blit.decoder_slice,
                                            "0x0",
                                        ));
                                        blank
                                    } else if at_probe && probe == Some('C') {
                                        let fresh = gpu_copy_full_nv12(
                                            gpu,
                                            &blit.texture,
                                            GPU_ENCODER_W,
                                            GPU_ENCODER_H,
                                            &diag,
                                        )?;
                                        hops.push(log_surface_transition(
                                            stats.composed,
                                            "probe_C_fresh_copy",
                                            Some(&fresh),
                                            0,
                                            blit.output_slot as i64,
                                            blit.decoder_slice,
                                            "0x0",
                                        ));
                                        drain_d3d_debug(gpu, stats.composed, "probe_C_copy");
                                        fresh
                                    } else {
                                        blit.texture.clone()
                                    };
                                    (encoder_tex, blit, hops)
                                };
                                drop(frame);
                                if !logged_first_blt && blit.blt_hr == 0 && blit.output_slot != usize::MAX {
                                    tracing::info!(
                                        video_processor_blt_hr = format!("{:#x}", blit.blt_hr),
                                        gameplay_input = "owned_nv12_ring",
                                        dest = format!("{GPU_ENCODER_W}x{GPU_ENCODER_H}"),
                                        "VideoProcessorBlt succeeded"
                                    );
                                    dump_texture(
                                        "vp_output_first",
                                        &blit.texture,
                                        gpu,
                                        0,
                                        GPU_ENCODER_W,
                                        GPU_ENCODER_H,
                                    );
                                    logged_first_blt = true;
                                }
                                if stats.composed >= BOUNDARY_LOG_FROM {
                                    tracing::info!(
                                        frame_index = stats.composed,
                                        encoder_input_time_hns = time,
                                        sample_duration_hns = duration,
                                        source_gameplay_time_hns = source_time,
                                        normalized_output_time_hns = time,
                                        timestamp_delta_hns = time_delta,
                                        source_delta_hns = source_delta,
                                        timestamp_monotonic = monotonic,
                                        output_ring_slot = blit.output_slot,
                                        encoder_in_flight = compositor.encoder_q.len(),
                                        need_input_count = stats.need_input,
                                        have_output_count = stats.have_output,
                                        "gpu_dxgi boundary timestamp audit"
                                    );
                                }
                                hops.push(log_surface_transition(
                                    stats.composed,
                                    "encoder_imfsample",
                                    Some(&encoder_tex),
                                    0,
                                    blit.output_slot as i64,
                                    blit.decoder_slice,
                                    "0x0",
                                ));
                                let sample = wrap_composed_frame(&encoder_tex, time, duration)?;
                                drain_d3d_debug(gpu, stats.composed, "wrap_imfsample");
                                let hr = process_input_hr(transform, &sample, "compose");
                                hops.push(log_surface_transition(
                                    stats.composed,
                                    "process_input",
                                    Some(&encoder_tex),
                                    0,
                                    blit.output_slot as i64,
                                    blit.decoder_slice,
                                    &hr,
                                ));
                                drain_d3d_debug(gpu, stats.composed, "process_input");
                                if stats.composed == SURFACE_PROBE_FRAME {
                                    if let Some((prev_frame, prev)) = last_hops.as_ref() {
                                        compare_surface_hops(*prev_frame, prev, stats.composed, &hops);
                                    }
                                }
                                if stats.composed == 0 {
                                    tracing::info!(
                                        process_input_hr = %hr,
                                        "first encoder ProcessInput on VideoProcessor output"
                                    );
                                }
                                if at_probe {
                                    let mode = probe.unwrap_or('?');
                                    let result = if hr == "0x0" { "ok" } else { "FAIL" };
                                    tracing::info!(
                                        probe = %mode,
                                        result,
                                        process_input_hr = %hr,
                                        frame_index = stats.composed,
                                        "surface probe complete"
                                    );
                                    return Err(format!(
                                        "surface_probe_{mode}={result} process_input_hr={hr} frame={SURFACE_PROBE_FRAME}"
                                    ));
                                }
                                if hr != "0x0" {
                                    tracing::error!(
                                        frame_index = stats.composed,
                                        encoder_input_time_hns = time,
                                        sample_duration_hns = duration,
                                        source_gameplay_time_hns = source_time,
                                        normalized_output_time_hns = time,
                                        timestamp_delta_hns = time_delta,
                                        timestamp_monotonic = monotonic,
                                        output_ring_slot = blit.output_slot,
                                        encoder_in_flight = compositor.encoder_q.len(),
                                        need_input_count = stats.need_input,
                                        have_output_count = stats.have_output,
                                        "gpu_dxgi boundary ProcessInput failed"
                                    );
                                    let fail = compositor.diag(
                                        stats.composed,
                                        stats.encoded,
                                        false,
                                        cam.current.is_some(),
                                    );
                                    let parsed = u32::from_str_radix(hr.trim_start_matches("0x"), 16)
                                        .unwrap_or(0);
                                    return Err(gpu_fail(gpu, "ProcessInput", parsed, &fail));
                                }
                                if stats.composed >= BOUNDARY_LOG_FROM {
                                    last_hops = Some((stats.composed, hops));
                                }
                                prev_encoder_time = time;
                                prev_source_time = source_time;
                                if blit.output_slot != usize::MAX {
                                    compositor.submit_output(blit.output_slot);
                                }
                                stats.composed += 1;
                                if stats.composed % 1000 == 0 {
                                    compositor.log_long_run(gpu, stats.composed, stats.encoded, cam.current.is_some());
                                }
                                if stats.composed % 250 == 0 {
                                    log_mux_telemetry(
                                        gpu,
                                        stats.composed,
                                        stats.encoded,
                                        output,
                                        &telemetry,
                                    );
                                }
                                if let Some(progress) = progress {
                                    let composed = u32::try_from(stats.composed).unwrap_or(u32::MAX);
                                    if stats.composed == 1
                                        || stats.composed % 30 == 0
                                        || (expected > 0 && composed >= expected)
                                    {
                                        progress(composed, expected.max(composed));
                                    }
                                }
                                match read_dxgi_sample(gameplay_reader) {
                                    Ok(Some(next)) => {
                                        if next.timestamp >= end_hns {
                                            gameplay_done = true;
                                            cam.log_sample(time, true);
                                        } else {
                                            current = Some(next);
                                        }
                                    }
                                    Ok(None) => {
                                        gameplay_done = true;
                                        cam.log_sample(time, true);
                                    }
                                    Err(err) => return Err(err),
                                }
                            }
                        }
                        None => {
                            gameplay_done = true;
                        }
                    }
                }
                if ty == METransformHaveOutput.0 as u32 {
                    stats.have_output += 1;
                    let log = stats.encoded < 3 || stats.encoded % 60 == 0;
                    let nalu = take_encoded_output(transform, log)?;
                    if mux.is_none() {
                        let mux_type = unsafe { transform.GetOutputCurrentType(0) }.map_err(|err| {
                            format!(
                                "GetOutputCurrentType after first H.264 hr={:#x} {err}",
                                err.code().0 as u32
                            )
                        })?;
                        dump_complete_media_type("encoder_output_for_mux", &mux_type);
                        mux = Some(H264Mp4Mux::create(output, &mux_type, audio_type)?);
                    }
                    let keyframe = unsafe {
                        nalu.sample
                            .GetUINT32(&MFSampleExtension_CleanPoint)
                            .unwrap_or(0)
                    } != 0;
                    if stats.encoded + 1 >= BOUNDARY_LOG_FROM.saturating_sub(16) {
                        tracing::info!(
                            frame_index = stats.encoded,
                            encoder_output_time_hns = nalu.time,
                            sample_size = nalu.size,
                            keyframe,
                            need_input_count = stats.need_input,
                            have_output_count = stats.have_output,
                            "gpu_dxgi boundary encoder output"
                        );
                    }
                    let opened = mux.as_mut().expect("mux opened after first H.264 output");
                    write_video_then_feed_audio(
                        opened,
                        feeder.as_deref_mut(),
                        &nalu,
                        &mut telemetry,
                    )?;
                    if stats.encoded == 0 {
                        tracing::info!(
                            mux_write_sample_hr = "0x0",
                            sample_size = nalu.size,
                            timestamp = nalu.time,
                            "first mux WriteSample"
                        );
                    }
                    compositor.release_encoder();
                    stats.encoded += 1;
                }
                if ty == METransformDrainComplete.0 as u32 {
                    drain_complete = true;
                    stats.drain = "drain_complete".into();
                }
            }
            Err(_) => {
                if draining {
                    let drain_deadline = Instant::now() + COMPOSE_DRAIN_TIMEOUT;
                    while Instant::now() < drain_deadline && !drain_complete {
                        match unsafe { events.GetEvent(MF_EVENT_FLAG_NO_WAIT) } {
                            Ok(event) => {
                                let ty = unsafe { event.GetType().unwrap_or(0) };
                                if ty == METransformHaveOutput.0 as u32 {
                                    if let Ok(nalu) = take_encoded_output(transform, false) {
                                        if mux.is_none() {
                                            if let Ok(mux_type) =
                                                unsafe { transform.GetOutputCurrentType(0) }
                                            {
                                                mux = H264Mp4Mux::create(
                                                    output,
                                                    &mux_type,
                                                    audio_type,
                                                )
                                                .ok();
                                            }
                                        }
                                        if let Some(opened) = mux.as_mut() {
                                            let _ = write_video_then_feed_audio(
                                                opened,
                                                feeder.as_deref_mut(),
                                                &nalu,
                                                &mut telemetry,
                                            );
                                            compositor.release_encoder();
                                            stats.encoded += 1;
                                        }
                                    }
                                }
                                if ty == METransformDrainComplete.0 as u32 {
                                    drain_complete = true;
                                    stats.drain = "drain_complete".into();
                                    break;
                                }
                            }
                            Err(_) => thread::sleep(Duration::from_millis(1)),
                        }
                    }
                    break;
                }
                thread::sleep(Duration::from_millis(1));
            }
        }
    }
    send_lifecycle(transform, "NOTIFY_END_STREAMING", MFT_MESSAGE_NOTIFY_END_STREAMING);
    if draining && !drain_complete && stats.drain == "drain_sent" {
        stats.drain = "drain_timeout".into();
    }
    if stats.drain == "drain_timeout" {
        return Err("direct MFT drain timed out".into());
    }
    if stats.encoded == 0 {
        return Err("direct MFT produced no H.264 samples".into());
    }
    let mux = mux.ok_or_else(|| "H.264 mux was never opened".to_string())?;
    Ok((stats, mux))
}

struct MuxTelemetry {
    h264_bytes_retained: u64,
    hmft_samples_held: u64,
    video_mux_hns: i64,
    audio_mux_hns: i64,
}

fn log_mux_telemetry(
    gpu: &SharedGpu,
    frame: u64,
    encoded: u64,
    output: &Path,
    telemetry: &MuxTelemetry,
) {
    let (usage, budget, reservation) = vram_usage(&gpu.device).unwrap_or((0, 0, 0));
    let file_size = std::fs::metadata(output).map(|meta| meta.len()).unwrap_or(0);
    let lead_hns = telemetry.video_mux_hns - telemetry.audio_mux_hns;
    tracing::info!(
        frame_index = frame,
        encoded,
        h264_bytes_retained = telemetry.h264_bytes_retained,
        hmft_samples_held = telemetry.hmft_samples_held,
        video_mux_hns = telemetry.video_mux_hns,
        audio_mux_hns = telemetry.audio_mux_hns,
        mux_lead_hns = lead_hns,
        output_file_bytes = file_size,
        vram_current_usage = usage,
        vram_budget = budget,
        vram_reservation = reservation,
        vram_over_budget = budget > 0 && usage > budget,
        "gpu_dxgi mux/memory telemetry"
    );
}