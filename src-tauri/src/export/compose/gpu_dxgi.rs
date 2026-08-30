//! Zero-copy D3D11 compose: MF DXGI decode → video processor → DXGI NV12 encode.

use std::collections::VecDeque;
use std::mem::ManuallyDrop;
use std::path::Path;
use std::thread;
use std::time::{Duration, Instant};

use windows::core::{Interface, BOOL, GUID, PCWSTR};
use windows::Win32::Foundation::RECT;
use windows::Win32::Graphics::Direct3D::{
    D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_11_1,
};
use windows::Win32::Graphics::Direct3D10::ID3D10Multithread;
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Asynchronous, ID3D11Device, ID3D11DeviceContext, ID3D11InfoQueue,
    ID3D11Query, ID3D11Resource, ID3D11Texture2D, ID3D11VideoContext, ID3D11VideoDevice,
    ID3D11VideoProcessor, ID3D11VideoProcessorEnumerator, ID3D11VideoProcessorInputView,
    ID3D11VideoProcessorOutputView, D3D11_ASYNC_GETDATA_DONOTFLUSH, D3D11_BIND_RENDER_TARGET,
    D3D11_BIND_SHADER_RESOURCE, D3D11_BIND_VIDEO_ENCODER, D3D11_BOX,
    D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_CREATE_DEVICE_DEBUG, D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
    D3D11_MESSAGE, D3D11_QUERY_DESC, D3D11_QUERY_EVENT, D3D11_SDK_VERSION,
    D3D11_TEX2D_VPIV, D3D11_TEX2D_VPOV, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT,
    D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE, D3D11_VIDEO_PROCESSOR_CAPS,
    D3D11_VIDEO_PROCESSOR_CONTENT_DESC, D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_INPUT,
    D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_OUTPUT, D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC,
    D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0, D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC,
    D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0, D3D11_VIDEO_PROCESSOR_STREAM,
    D3D11_VIDEO_USAGE_PLAYBACK_NORMAL, D3D11_VPIV_DIMENSION_TEXTURE2D,
    D3D11_VPOV_DIMENSION_TEXTURE2D,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_NV12, DXGI_RATIONAL, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::{
    IDXGIAdapter3, IDXGIDevice, DXGI_MEMORY_SEGMENT_GROUP_LOCAL, DXGI_QUERY_VIDEO_MEMORY_INFO,
};
use windows::Win32::Media::MediaFoundation::{
    IMFActivate, IMFDXGIBuffer, IMFDXGIDeviceManager, IMFMediaBuffer, IMFMediaEventGenerator,
    IMFSample, IMFSourceReader, IMFSourceReaderEx, IMFTransform, MEError, METransformDrainComplete,
    METransformHaveOutput, METransformNeedInput, MFCreateAttributes, MFCreateDXGIDeviceManager,
    MFCreateDXGISurfaceBuffer, MFCreateMediaType, MFCreateMemoryBuffer, MFCreateSample,
    MFCreateSourceReaderFromURL, MFCreateVideoSampleFromSurface, MFMediaType_Video,
    MFSampleExtension_CleanPoint, MFTEnumEx, MFT_CATEGORY_VIDEO_ENCODER, MFT_ENUM_FLAG_ALL,
    MFT_FRIENDLY_NAME_Attribute, MFT_MESSAGE_COMMAND_DRAIN, MFT_MESSAGE_NOTIFY_BEGIN_STREAMING,
    MFT_MESSAGE_NOTIFY_END_OF_STREAM, MFT_MESSAGE_NOTIFY_END_STREAMING,
    MFT_MESSAGE_NOTIFY_START_OF_STREAM, MFT_MESSAGE_SET_D3D_MANAGER, MFT_OUTPUT_DATA_BUFFER,
    MFT_OUTPUT_STREAM_PROVIDES_SAMPLES, MFT_REGISTER_TYPE_INFO, MFVideoFormat_H264,
    MFVideoFormat_NV12, MF_EVENT_FLAG_NO_WAIT,
    MFVideoInterlace_Progressive, MF_MT_FRAME_RATE, MF_MT_FRAME_SIZE, MF_MT_INTERLACE_MODE,
    MF_MT_AVG_BITRATE, MF_MT_MAJOR_TYPE, MF_MT_MPEG2_LEVEL, MF_MT_MPEG2_PROFILE,
    MF_MT_MPEG4_CURRENT_SAMPLE_ENTRY, MF_MT_MPEG4_SAMPLE_DESCRIPTION, MF_MT_MPEG_SEQUENCE_HEADER,
    MF_MT_PIXEL_ASPECT_RATIO, MF_MT_SUBTYPE, MF_MT_USER_DATA, MF_PD_DURATION,
    MF_SOURCE_READER_MEDIASOURCE,
    MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, MF_SA_D3D11_AWARE, MF_SOURCE_READERF_ENDOFSTREAM,
    MF_SOURCE_READER_D3D_MANAGER, MF_SOURCE_READER_FIRST_AUDIO_STREAM,
    MF_SOURCE_READER_FIRST_VIDEO_STREAM, MF_TRANSFORM_ASYNC, MF_TRANSFORM_ASYNC_UNLOCK,
};
use windows::Win32::System::Com::CoTaskMemFree;
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;

use crate::encode::{MfWriter, VideoInput, WriterAudio};
use crate::overlay::{overlay_box, overlay_cover_source, OverlayLayout};

use super::super::audio::{probe_copyable_audio, AacFeeder};
use super::super::mux::H264Mp4Mux;
use super::super::progress::expected_compose_frames;
use super::super::types::{ComposeMode, ComposeQuality, ComposeReport, WebcamComposeOpts};
use super::super::webcam::{decide_webcam_advance, FollowTimeline, WebcamAdvance};
use super::sizing::fit_compose_size;

const BOUNDARY_ENCODER: &str = "dxgi_sample_to_encoder";
const BOUNDARY_MISSING_MANAGER: &str = "sinkwriter_missing_d3d_manager";
const BOUNDARY_SW_PLUMBING: &str = "sinkwriter_dxgi_plumbing";
const BOUNDARY_NOT_D3D11: &str = "encoder_not_d3d11_compatible";
const BOUNDARY_ENCODER_REJECTS: &str = "encoder_rejects_dxgi_sample";
const BOUNDARY_ENCODER_ACCEPTS: &str = "encoder_accepts_dxgi_sample";
const BOUNDARY_ENCODER_NOT_READY: &str = "encoder_still_not_ready";
const BOUNDARY_ENCODER_OTHER: &str = "encoder_process_input_other_failure";
const BOUNDARY_ASYNC_STARTUP: &str = "async_encoder_startup_failure";
const ASYNC_EVENT_TIMEOUT: Duration = Duration::from_secs(3);
const DIRECT_LOOP_FRAMES: u32 = 90;
const DIRECT_LOOP_TIMEOUT: Duration = Duration::from_secs(15);
const DIRECT_DRAIN_TIMEOUT: Duration = Duration::from_secs(5);
#[allow(dead_code)]
const BOUNDARY_VP: &str = "video_processor_output";
#[allow(dead_code)]
const BOUNDARY_BLT: &str = "video_processor_blt";
const GPU_ENCODER_W: u32 = 1920;
const GPU_ENCODER_H: u32 = 1080;
const PROBE_DURATION_HNS: i64 = 166_666;
const HNS_PER_SECOND: i64 = 10_000_000;
const ENCODER_FPS: u32 = 60;
const BLANK_LONG_FRAMES: u64 = 12_000;
const BOUNDARY_LOG_FROM: u64 = 10_460;
const SURFACE_PROBE_FRAME: u64 = 10_476;
const VP_OUTPUT_RING: usize = 16;
const VP_INPUT_RING: usize = 4;
const QUERY_WAIT: Duration = Duration::from_secs(2);
const QUERY_POLL: Duration = Duration::from_micros(200);
const COMPOSE_TIMEOUT: Duration = Duration::from_secs(180);
const COMPOSE_DRAIN_TIMEOUT: Duration = Duration::from_secs(15);

struct SharedGpu {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    video: ID3D11VideoDevice,
    video_ctx: ID3D11VideoContext,
    manager: IMFDXGIDeviceManager,
    adapter: String,
    reset_token: u32,
    info_queue: Option<ID3D11InfoQueue>,
}

struct DxgiFrame {
    /// Keeps the decoder array slice allocated until the owned-ring copy completes.
    #[allow(dead_code)]
    sample: IMFSample,
    texture: ID3D11Texture2D,
    subresource: u32,
    width: u32,
    height: u32,
    timestamp: i64,
    duration: i64,
}

struct DxgiWebcam {
    reader: IMFSourceReader,
    current: Option<DxgiFrame>,
    pending: Option<DxgiFrame>,
    timeline: FollowTimeline,
    frames: u64,
}

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

struct ComposeLoopStats {
    composed: u64,
    encoded: u64,
    dropped: u64,
    need_input: u64,
    have_output: u64,
    drain: String,
}

fn encoder_frame_duration_hns(fps: u32) -> i64 {
    HNS_PER_SECOND / i64::from(fps.max(1))
}

fn encoder_sample_time_hns(frame_index: u64, fps: u32) -> i64 {
    let fps = i64::from(fps.max(1));
    i64::try_from(frame_index)
        .unwrap_or(i64::MAX)
        .saturating_mul(HNS_PER_SECOND)
        / fps
}

pub(crate) fn run_blank_direct_mft_long_test(frames: u64) -> Result<String, String> {
    let frames = frames.max(1);
    let started = Instant::now();
    let gpu = SharedGpu::open()?;
    let inventory = crate::camera::encoder::log_h264_inventory();
    let encoder_name = pick_direct_encoder_name(&inventory);
    log_nvidia_selection(&inventory, &encoder_name);
    let transform = activate_named_h264_encoder(&encoder_name)
        .ok_or_else(|| format!("Could not activate the direct H.264 encoder {encoder_name}"))?;
    let bound_aware = d3d11_aware(&transform);
    configure_direct_encoder(
        &transform,
        &gpu,
        bound_aware,
        ENCODER_FPS,
        gpu_encoder_bitrate(ComposeQuality::Cloud, ENCODER_FPS),
    )?;
    let events: IMFMediaEventGenerator = transform
        .cast()
        .map_err(|err| format!("Direct encoder has no event generator: {err}"))?;
    let blank = create_blank_nv12(
        &gpu.device,
        GPU_ENCODER_W,
        GPU_ENCODER_H,
        D3D11_BIND_VIDEO_ENCODER.0 as u32,
    )?;
    dump_texture(
        "blank_long_mft",
        &blank,
        &gpu,
        0,
        GPU_ENCODER_W,
        GPU_ENCODER_H,
    );
    let duration = encoder_frame_duration_hns(ENCODER_FPS);
    let mut submitted: u64 = 0;
    let mut encoded: u64 = 0;
    let mut need_input: u64 = 0;
    let mut have_output: u64 = 0;
    let mut prev_time = i64::MIN;
    let mut draining = false;
    let mut drain_complete = false;
    let deadline = Instant::now() + COMPOSE_TIMEOUT;
    tracing::info!(
        frames,
        encoder = %encoder_name,
        time_base = "i64 N * 10_000_000 / 60",
        duration_hns = duration,
        "blank direct-MFT long run starting"
    );

    while Instant::now() < deadline && !drain_complete {
        if !draining && submitted >= frames {
            send_lifecycle(&transform, "NOTIFY_END_OF_STREAM", MFT_MESSAGE_NOTIFY_END_OF_STREAM);
            send_lifecycle(&transform, "COMMAND_DRAIN", MFT_MESSAGE_COMMAND_DRAIN);
            draining = true;
        }
        match unsafe { events.GetEvent(MF_EVENT_FLAG_NO_WAIT) } {
            Ok(event) => {
                let ty = unsafe { event.GetType().unwrap_or(0) };
                let status = unsafe { event.GetStatus().ok() };
                if status.is_some_and(|hr| hr.is_err()) || ty == MEError.0 as u32 {
                    let hr = status
                        .map(|h| h.0 as u32)
                        .unwrap_or(0);
                    let (removed, name) = device_removed_reason(&gpu);
                    return Err(format!(
                        "blank_mft event {} hr={hr:#x} device_removed={removed:#x} ({name}) submitted={submitted} encoded={encoded}",
                        event_name(ty)
                    ));
                }
                if ty == METransformNeedInput.0 as u32 && !draining && submitted < frames {
                    need_input += 1;
                    let time = encoder_sample_time_hns(submitted, ENCODER_FPS);
                    let delta = if prev_time == i64::MIN {
                        0
                    } else {
                        time.saturating_sub(prev_time)
                    };
                    let monotonic = prev_time == i64::MIN || time > prev_time;
                    if submitted >= BOUNDARY_LOG_FROM {
                        tracing::info!(
                            frame_index = submitted,
                            encoder_input_time_hns = time,
                            sample_duration_hns = duration,
                            timestamp_delta_hns = delta,
                            timestamp_monotonic = monotonic,
                            encoder_in_flight = submitted.saturating_sub(encoded),
                            need_input_count = need_input,
                            have_output_count = have_output,
                            "blank_mft boundary timestamp audit"
                        );
                    }
                    let sample = wrap_composed_frame(&blank, time, duration)?;
                    let hr = process_input_hr(&transform, &sample, "blank_long");
                    if hr != "0x0" {
                        let (removed, name) = device_removed_reason(&gpu);
                        tracing::error!(
                            frame_index = submitted,
                            encoder_input_time_hns = time,
                            sample_duration_hns = duration,
                            timestamp_delta_hns = delta,
                            timestamp_monotonic = monotonic,
                            process_input_hr = %hr,
                            device_removed_hr = format!("{removed:#x}"),
                            device_removed_name = name,
                            encoded,
                            need_input_count = need_input,
                            have_output_count = have_output,
                            "blank_mft ProcessInput failed"
                        );
                        return Err(format!(
                            "blank_mft ProcessInput hr={hr} device_removed={removed:#x} ({name}) frame={submitted} encoded={encoded}"
                        ));
                    }
                    prev_time = time;
                    submitted += 1;
                    if submitted % 1000 == 0 {
                        let (removed, name) = device_removed_reason(&gpu);
                        tracing::info!(
                            submitted,
                            encoded,
                            in_flight = submitted.saturating_sub(encoded),
                            device_removed_hr = format!("{removed:#x}"),
                            device_removed_name = name,
                            "blank_mft long-run progress"
                        );
                    }
                }
                if ty == METransformHaveOutput.0 as u32 {
                    have_output += 1;
                    let log = encoded < 3 || encoded % 60 == 0 || encoded + 1 >= BOUNDARY_LOG_FROM;
                    let nalu = take_encoded_output(&transform, log)?;
                    let keyframe = unsafe {
                        nalu.sample
                            .GetUINT32(&MFSampleExtension_CleanPoint)
                            .unwrap_or(0)
                    } != 0;
                    if encoded + 1 >= BOUNDARY_LOG_FROM.saturating_sub(16) {
                        tracing::info!(
                            frame_index = encoded,
                            encoder_output_time_hns = nalu.time,
                            sample_size = nalu.size,
                            keyframe,
                            need_input_count = need_input,
                            have_output_count = have_output,
                            "blank_mft boundary encoder output"
                        );
                    }
                    encoded += 1;
                    drop(nalu.sample);
                }
                if ty == METransformDrainComplete.0 as u32 {
                    drain_complete = true;
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
                                    if let Ok(nalu) = take_encoded_output(&transform, false) {
                                        encoded += 1;
                                        have_output += 1;
                                        drop(nalu.sample);
                                    }
                                }
                                if ty == METransformDrainComplete.0 as u32 {
                                    drain_complete = true;
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
    send_lifecycle(&transform, "NOTIFY_END_STREAMING", MFT_MESSAGE_NOTIFY_END_STREAMING);
    let elapsed_ms = started.elapsed().as_millis();
    if encoded == 0 {
        return Err("blank_mft produced no H.264 samples".into());
    }
    if submitted < frames {
        return Err(format!(
            "blank_mft stopped early submitted={submitted} encoded={encoded} elapsed_ms={elapsed_ms}"
        ));
    }
    let summary = format!(
        "blank_mft_ok submitted={submitted} encoded={encoded} elapsed_ms={elapsed_ms}"
    );
    tracing::info!(
        submitted,
        encoded,
        elapsed_ms,
        "blank direct-MFT long run finished"
    );
    Ok(summary)
}

fn pick_direct_encoder_name(inventory: &[crate::camera::encoder::EncoderInfo]) -> String {
    inventory
        .iter()
        .find(|item| {
            let name = item.name.to_ascii_lowercase();
            name.contains("dx12") || name.contains("nvidia") || name.contains("nvenc")
        })
        .map(|item| item.name.clone())
        .unwrap_or_else(|| "Microsoft AVC DX12 Encoder".into())
}

fn log_dxgi_format(label: &str, frame: &DxgiFrame) {
    let mut desc = D3D11_TEXTURE2D_DESC::default();
    unsafe { frame.texture.GetDesc(&mut desc) };
    tracing::info!(
        stream = label,
        format = format_name(desc.Format),
        width = frame.width,
        height = frame.height,
        "VP input surface"
    );
}

fn wrap_composed_frame(
    texture: &ID3D11Texture2D,
    time: i64,
    duration: i64,
) -> Result<IMFSample, String> {
    let (_buffer, sample) = wrap_video_sample_from_surface(texture, 0)?;
    unsafe {
        sample
            .SetSampleTime(time)
            .map_err(|err| format!("SetSampleTime hr={:#x}", err.code().0 as u32))?;
        sample
            .SetSampleDuration(duration.max(1))
            .map_err(|err| format!("SetSampleDuration hr={:#x}", err.code().0 as u32))?;
    }
    Ok(sample)
}

struct GpuEvent {
    query: ID3D11Query,
}

impl GpuEvent {
    fn create(device: &ID3D11Device) -> Result<Self, String> {
        let desc = D3D11_QUERY_DESC {
            Query: D3D11_QUERY_EVENT,
            MiscFlags: 0,
        };
        let mut query = None;
        unsafe {
            device
                .CreateQuery(&desc, Some(&mut query))
                .map_err(|err| format!("Could not create a D3D11 event query: {err}"))?;
        }
        Ok(Self {
            query: query.ok_or_else(|| "D3D11 event query was empty.".to_string())?,
        })
    }

    fn end(&self, context: &ID3D11DeviceContext) -> Result<(), String> {
        let async_q: ID3D11Asynchronous = self
            .query
            .cast()
            .map_err(|err| format!("event query is not ID3D11Asynchronous: {err}"))?;
        unsafe { context.End(&async_q) };
        Ok(())
    }

    fn ready(&self, gpu: &SharedGpu) -> Result<bool, String> {
        let async_q: ID3D11Asynchronous = self
            .query
            .cast()
            .map_err(|err| format!("event query is not ID3D11Asynchronous: {err}"))?;
        match unsafe {
            gpu.context
                .GetData(&async_q, None, 0, D3D11_ASYNC_GETDATA_DONOTFLUSH.0 as u32)
        } {
            Ok(()) => Ok(true),
            Err(err) => {
                let hr = err.code().0 as u32;
                if hr == 1 || hr == 0x887A000A {
                    Ok(false)
                } else {
                    Err(gpu_fail(
                        gpu,
                        "GetData",
                        hr,
                        &GpuFailDiag::default(),
                    ))
                }
            }
        }
    }

    fn wait(&self, gpu: &SharedGpu, diag: &GpuFailDiag) -> Result<(), String> {
        let started = Instant::now();
        loop {
            if self.ready(gpu)? {
                return Ok(());
            }
            if started.elapsed() > QUERY_WAIT {
                return Err(gpu_fail(gpu, "query_wait_timeout", 0x887A0006, diag));
            }
            thread::sleep(QUERY_POLL);
        }
    }
}

#[derive(Clone, Default)]
struct GpuFailDiag {
    frame: u64,
    encoded: u64,
    in_flight: u64,
    input_slot: usize,
    output_slot: usize,
    decoder_slice: u32,
    input_ring_busy: u32,
    output_ring_busy: u32,
    decoder_slices_referenced: u32,
    encoder_in_flight: u32,
    vp_input_views: u32,
    vp_output_views: u32,
    outstanding_input_samples: u32,
    outstanding_output_samples: u32,
}

fn dxgi_reason_name(hr: u32) -> &'static str {
    match hr {
        0x00000000 => "S_OK",
        0x00000001 => "S_FALSE",
        0x8007000E => "E_OUTOFMEMORY",
        0x80070057 => "E_INVALIDARG",
        0x887A0001 => "DXGI_ERROR_INVALID_CALL",
        0x887A0005 => "DXGI_ERROR_DEVICE_REMOVED",
        0x887A0006 => "DXGI_ERROR_DEVICE_HUNG",
        0x887A0007 => "DXGI_ERROR_DEVICE_RESET",
        0x887A000A => "DXGI_ERROR_WAS_STILL_DRAWING",
        0x887A0020 => "DXGI_ERROR_DRIVER_INTERNAL_ERROR",
        _ => "UNKNOWN",
    }
}

fn device_removed_reason(gpu: &SharedGpu) -> (u32, &'static str) {
    match unsafe { gpu.device.GetDeviceRemovedReason() } {
        Ok(()) => (0, "S_OK"),
        Err(err) => {
            let hr = err.code().0 as u32;
            (hr, dxgi_reason_name(hr))
        }
    }
}

fn gpu_fail(gpu: &SharedGpu, op: &str, original_hr: u32, diag: &GpuFailDiag) -> String {
    let (removed_hr, removed_name) = device_removed_reason(gpu);
    tracing::error!(
        op,
        original_hr = format!("{original_hr:#x}"),
        original_name = dxgi_reason_name(original_hr),
        device_removed_hr = format!("{removed_hr:#x}"),
        device_removed_name = removed_name,
        frame_index = diag.frame,
        input_ring_slot = diag.input_slot,
        output_ring_slot = diag.output_slot,
        decoder_array_slice = diag.decoder_slice,
        encoded = diag.encoded,
        in_flight = diag.in_flight,
        outstanding_input_samples = diag.outstanding_input_samples,
        outstanding_output_samples = diag.outstanding_output_samples,
        input_ring_busy = diag.input_ring_busy,
        output_ring_busy = diag.output_ring_busy,
        decoder_slices_referenced = diag.decoder_slices_referenced,
        encoder_in_flight = diag.encoder_in_flight,
        vp_input_views_alive = diag.vp_input_views,
        vp_output_views_alive = diag.vp_output_views,
        cpu_map_count = 0,
        "gpu_dxgi device-removal diagnostics"
    );
    format!(
        "gpu_dxgi {op} hr={original_hr:#x} ({}) device_removed={removed_hr:#x} ({removed_name}) frame={} in={} out={} slice={} encoded={} in_flight={}",
        dxgi_reason_name(original_hr),
        diag.frame,
        diag.input_slot,
        diag.output_slot,
        diag.decoder_slice,
        diag.encoded,
        diag.in_flight
    )
}

#[derive(Clone)]
struct SurfaceHop {
    hop: String,
    texture: String,
    subresource: u32,
    format: String,
    width: u32,
    height: u32,
    bind_flags: String,
    array_size: u32,
    mip_levels: u32,
    device: String,
    ring_slot: i64,
    decoder_slice: u32,
    hr: String,
}

struct BlitResult {
    texture: ID3D11Texture2D,
    owned_gameplay: ID3D11Texture2D,
    blt_hr: i32,
    input_slot: usize,
    output_slot: usize,
    decoder_slice: u32,
    hops: Vec<SurfaceHop>,
}

fn hr_u32(detail: &str) -> u32 {
    if let Some(start) = detail.find("hr=0x") {
        let hex: String = detail[start + 5..]
            .chars()
            .take_while(|c| c.is_ascii_hexdigit())
            .collect();
        return u32::from_str_radix(&hex, 16).unwrap_or(0);
    }
    0
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

fn run_direct_compose_loop(
    gpu: &SharedGpu,
    compositor: &mut VideoCompositor,
    transform: &IMFTransform,
    events: &IMFMediaEventGenerator,
    gameplay_reader: &IMFSourceReader,
    cam: &mut DxgiWebcam,
    first: DxgiFrame,
    layout: &OverlayLayout,
    start_hns: i64,
    end_hns: i64,
    fps: u32,
    expected: u32,
    progress: Option<&super::super::types::ComposeProgress>,
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

impl SharedGpu {
    fn open() -> Result<Self, String> {
        unsafe {
            let mut device = None;
            let mut context = None;
            let levels = [D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0];
            let flags = D3D11_CREATE_DEVICE_VIDEO_SUPPORT | D3D11_CREATE_DEVICE_BGRA_SUPPORT;
            let debug_hr = D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_HARDWARE,
                Default::default(),
                flags | D3D11_CREATE_DEVICE_DEBUG,
                Some(&levels),
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            );
            let debug_layer = debug_hr.is_ok() && device.is_some() && context.is_some();
            if !debug_layer {
                device = None;
                context = None;
                D3D11CreateDevice(
                    None,
                    D3D_DRIVER_TYPE_HARDWARE,
                    Default::default(),
                    flags,
                    Some(&levels),
                    D3D11_SDK_VERSION,
                    Some(&mut device),
                    None,
                    Some(&mut context),
                )
                .map_err(|err| format!("Could not create a D3D11 compose device: {err}"))?;
            }
            let device = device.ok_or_else(|| "D3D11 compose device was empty.".to_string())?;
            let context = context.ok_or_else(|| "D3D11 compose context was empty.".to_string())?;
            let info_queue = device.cast::<ID3D11InfoQueue>().ok();
            if let Some(queue) = &info_queue {
                let _ = queue.SetMessageCountLimit(4096);
            }
            tracing::info!(
                d3d11_debug_layer = debug_layer,
                info_queue = info_queue.is_some(),
                "D3D11 device created"
            );
            if let Ok(mt) = device.cast::<ID3D10Multithread>() {
                let _ = mt.SetMultithreadProtected(true);
            }
            let video: ID3D11VideoDevice = device
                .cast()
                .map_err(|err| format!("This GPU has no D3D11 video processor: {err}"))?;
            let video_ctx: ID3D11VideoContext = context
                .cast()
                .map_err(|err| format!("This GPU has no D3D11 video context: {err}"))?;
            let mut reset_token = 0_u32;
            let mut manager = None;
            MFCreateDXGIDeviceManager(&mut reset_token, &mut manager)
                .map_err(|err| format!("Could not create the DXGI device manager: {err}"))?;
            let manager = manager.ok_or_else(|| "DXGI device manager was empty.".to_string())?;
            manager
                .ResetDevice(&device, reset_token)
                .map_err(|err| format!("Could not bind the DXGI device manager: {err}"))?;
            tracing::info!(
                reset_token,
                reset_device_hr = "0x0",
                device = format!("{:#x}", device.as_raw() as usize),
                manager = format!("{:#x}", manager.as_raw() as usize),
                "IMFDXGIDeviceManager ResetDevice succeeded"
            );
            let adapter = adapter_name(&device);
            Ok(Self {
                device,
                context,
                video,
                video_ctx,
                manager,
                adapter,
                reset_token,
                info_queue,
            })
        }
    }
}

struct VpOutput {
    texture: ID3D11Texture2D,
    view: ID3D11VideoProcessorOutputView,
    gpu_done: GpuEvent,
    encoder_busy: bool,
}

struct VpInputSlot {
    texture: ID3D11Texture2D,
    view: ID3D11VideoProcessorInputView,
    copy_done: GpuEvent,
    width: u32,
    height: u32,
}

struct VideoCompositor {
    enumerator: ID3D11VideoProcessorEnumerator,
    processor: ID3D11VideoProcessor,
    outputs: Vec<VpOutput>,
    gameplay_inputs: Vec<VpInputSlot>,
    webcam_inputs: Vec<VpInputSlot>,
    next_output: usize,
    next_gameplay: usize,
    next_webcam: usize,
    encoder_q: VecDeque<usize>,
    last_input_slot: usize,
    last_output_slot: usize,
    last_decoder_slice: u32,
    sync_tex: ID3D11Texture2D,
    out_w: u32,
    out_h: u32,
}

impl VideoCompositor {
    fn open(
        gpu: &SharedGpu,
        in_w: u32,
        in_h: u32,
        out_w: u32,
        out_h: u32,
        fps: u32,
    ) -> Result<Self, String> {
        let desc = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
            InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
            InputFrameRate: DXGI_RATIONAL {
                Numerator: fps,
                Denominator: 1,
            },
            InputWidth: in_w.max(2),
            InputHeight: in_h.max(2),
            OutputFrameRate: DXGI_RATIONAL {
                Numerator: fps,
                Denominator: 1,
            },
            OutputWidth: out_w,
            OutputHeight: out_h,
            Usage: D3D11_VIDEO_USAGE_PLAYBACK_NORMAL,
        };
        unsafe {
            let enumerator = gpu
                .video
                .CreateVideoProcessorEnumerator(&desc)
                .map_err(|err| format!("Could not create the video processor enumerator: {err}"))?;
            let input_ok = enumerator
                .CheckVideoProcessorFormat(DXGI_FORMAT_NV12)
                .unwrap_or(0)
                & D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_INPUT.0 as u32
                != 0;
            let output_ok = enumerator
                .CheckVideoProcessorFormat(DXGI_FORMAT_NV12)
                .unwrap_or(0)
                & D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_OUTPUT.0 as u32
                != 0;
            if !input_ok || !output_ok {
                return Err("D3D11 video processor cannot take NV12 in and out.".into());
            }
            let mut caps = D3D11_VIDEO_PROCESSOR_CAPS::default();
            enumerator
                .GetVideoProcessorCaps(&mut caps)
                .map_err(|err| format!("Could not query video processor caps: {err}"))?;
            if caps.MaxInputStreams < 2 {
                return Err("D3D11 video processor cannot composite two streams.".into());
            }
            let processor = gpu
                .video
                .CreateVideoProcessor(&enumerator, 0)
                .map_err(|err| format!("Could not create the video processor: {err}"))?;
            let bind_flags = (D3D11_BIND_RENDER_TARGET.0
                | D3D11_BIND_SHADER_RESOURCE.0
                | D3D11_BIND_VIDEO_ENCODER.0) as u32;
            let tex_desc = D3D11_TEXTURE2D_DESC {
                Width: out_w,
                Height: out_h,
                MipLevels: 1,
                ArraySize: 1,
                Format: DXGI_FORMAT_NV12,
                SampleDesc: DXGI_SAMPLE_DESC {
                    Count: 1,
                    Quality: 0,
                },
                Usage: D3D11_USAGE_DEFAULT,
                BindFlags: bind_flags,
                CPUAccessFlags: 0,
                MiscFlags: 0,
            };
            let view_desc = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
                ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
                Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 {
                    Texture2D: D3D11_TEX2D_VPOV { MipSlice: 0 },
                },
            };
            let mut outputs = Vec::with_capacity(VP_OUTPUT_RING);
            for _ in 0..VP_OUTPUT_RING {
                let mut output = None;
                gpu.device
                    .CreateTexture2D(&tex_desc, None, Some(&mut output))
                    .map_err(|err| format!("Could not create the NV12 compose target: {err}"))?;
                let output = output.ok_or_else(|| "NV12 compose target was empty.".to_string())?;
                let mut output_view = None;
                gpu.video
                    .CreateVideoProcessorOutputView(
                        &output,
                        &enumerator,
                        &view_desc,
                        Some(&mut output_view),
                    )
                    .map_err(|err| {
                        format!("Could not create the video processor output view: {err}")
                    })?;
                let view = output_view
                    .ok_or_else(|| "Video processor output view was empty.".to_string())?;
                outputs.push(VpOutput {
                    texture: output,
                    view,
                    gpu_done: GpuEvent::create(&gpu.device)?,
                    encoder_busy: false,
                });
            }
            gpu.video_ctx.VideoProcessorSetStreamFrameFormat(
                &processor,
                0,
                D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
            );
            gpu.video_ctx.VideoProcessorSetStreamFrameFormat(
                &processor,
                1,
                D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
            );
            gpu.video_ctx
                .VideoProcessorSetStreamAutoProcessingMode(&processor, 0, false);
            gpu.video_ctx
                .VideoProcessorSetStreamAutoProcessingMode(&processor, 1, false);
            tracing::info!(
                vp_input = "NV12",
                vp_output = "NV12",
                output = format!("{out_w}x{out_h}"),
                gameplay_input = format!("{in_w}x{in_h}"),
                ring = VP_OUTPUT_RING,
                bind_flags = format!("{bind_flags:#x}"),
                "D3D11 VideoProcessor formats"
            );
            Ok(Self {
                enumerator,
                processor,
                outputs,
                gameplay_inputs: Vec::new(),
                webcam_inputs: Vec::new(),
                next_output: 0,
                next_gameplay: 0,
                next_webcam: 0,
                encoder_q: VecDeque::new(),
                last_input_slot: 0,
                last_output_slot: 0,
                last_decoder_slice: 0,
                sync_tex: {
                    let mut sync = None;
                    gpu.device
                        .CreateTexture2D(&tex_desc, None, Some(&mut sync))
                        .map_err(|err| format!("Could not create the VP/encode sync surface: {err}"))?;
                    sync.ok_or_else(|| "VP/encode sync surface was empty.".to_string())?
                },
                out_w,
                out_h,
            })
        }
    }

    fn blit(
        &mut self,
        gpu: &SharedGpu,
        gameplay: &DxgiFrame,
        webcam: Option<&DxgiFrame>,
        layout: &OverlayLayout,
        diag: &GpuFailDiag,
        frame_index: u64,
    ) -> Result<BlitResult, String> {
        self.ensure_input_ring(gpu, gameplay, false, diag)?;
        if let Some(cam) = webcam {
            self.ensure_input_ring(gpu, cam, true, diag)?;
        }

        let mut hops = Vec::new();
        if frame_index >= BOUNDARY_LOG_FROM {
            hops.push(log_surface_transition(
                frame_index,
                "decoder_dxgi_slice",
                Some(&gameplay.texture),
                gameplay.subresource,
                -1,
                gameplay.subresource,
                "0x0",
            ));
        }

        let gp_slot = self.next_gameplay;
        self.next_gameplay = (self.next_gameplay + 1) % self.gameplay_inputs.len();
        copy_decoder_to_owned(gpu, &self.gameplay_inputs[gp_slot], gameplay, diag)?;
        self.gameplay_inputs[gp_slot].copy_done.end(&gpu.context)?;
        unsafe { gpu.context.Flush() };
        self.gameplay_inputs[gp_slot]
            .copy_done
            .wait(gpu, diag)?;
        if frame_index >= BOUNDARY_LOG_FROM {
            hops.push(log_surface_transition(
                frame_index,
                "owned_gameplay_ring",
                Some(&self.gameplay_inputs[gp_slot].texture),
                0,
                gp_slot as i64,
                gameplay.subresource,
                "0x0",
            ));
        }

        let cam_slot = if let Some(cam) = webcam {
            let slot = self.next_webcam;
            self.next_webcam = (self.next_webcam + 1) % self.webcam_inputs.len();
            copy_decoder_to_owned(gpu, &self.webcam_inputs[slot], cam, diag)?;
            self.webcam_inputs[slot].copy_done.end(&gpu.context)?;
            unsafe { gpu.context.Flush() };
            self.webcam_inputs[slot].copy_done.wait(gpu, diag)?;
            Some(slot)
        } else {
            None
        };

        let out_slot = self
            .outputs
            .iter()
            .enumerate()
            .cycle()
            .skip(self.next_output)
            .take(self.outputs.len())
            .find(|(_, slot)| !slot.encoder_busy)
            .map(|(idx, _)| idx)
            .ok_or_else(|| "output_ring_full".to_string())?;
        self.next_output = (out_slot + 1) % self.outputs.len();
        self.last_input_slot = gp_slot;
        self.last_output_slot = out_slot;
        self.last_decoder_slice = gameplay.subresource;

        let gameplay_view = self.gameplay_inputs[gp_slot].view.clone();
        let cam_view = cam_slot.map(|slot| self.webcam_inputs[slot].view.clone());
        let output_view = self.outputs[out_slot].view.clone();
        let output_tex = self.outputs[out_slot].texture.clone();
        let owned_gameplay = self.gameplay_inputs[gp_slot].texture.clone();
        if frame_index >= BOUNDARY_LOG_FROM {
            hops.push(log_surface_transition(
                frame_index,
                "vp_input_view",
                Some(&owned_gameplay),
                0,
                gp_slot as i64,
                gameplay.subresource,
                "0x0",
            ));
            tracing::info!(
                frame_index,
                hop = "vp_input_view",
                view_ptr = format!("{:#x}", raw_ptr(&gameplay_view)),
                texture_ptr = format!("{:#x}", raw_ptr(&owned_gameplay)),
                subresource = 0,
                ring_slot = gp_slot,
                decoder_slice = gameplay.subresource,
                "surface transition view"
            );
        }

        unsafe {
            let gameplay_dest = gameplay_dest_rect(
                gameplay.width,
                gameplay.height,
                self.out_w,
                self.out_h,
            );
            gpu.video_ctx
                .VideoProcessorSetStreamSourceRect(&self.processor, 0, false, None);
            gpu.video_ctx.VideoProcessorSetStreamDestRect(
                &self.processor,
                0,
                true,
                Some(&gameplay_dest),
            );

            let mut streams = [
                D3D11_VIDEO_PROCESSOR_STREAM {
                    Enable: BOOL(1),
                    pInputSurface: ManuallyDrop::new(Some(gameplay_view)),
                    ..Default::default()
                },
                D3D11_VIDEO_PROCESSOR_STREAM::default(),
            ];
            if let (Some(cam), Some(view)) = (webcam, cam_view.as_ref()) {
                let aspect = cam.width as f32 / cam.height.max(1) as f32;
                let (ox, oy, box_w, box_h) = overlay_box(self.out_w, self.out_h, aspect, layout);
                if box_w > 0 && box_h > 0 {
                    let dest = even_rect(ox, oy, box_w, box_h, self.out_w, self.out_h);
                    let (sx, sy, sw, sh) =
                        overlay_cover_source(cam.width, cam.height, box_w, box_h);
                    let src = even_rect(sx, sy, sw, sh, cam.width, cam.height);
                    gpu.video_ctx.VideoProcessorSetStreamSourceRect(
                        &self.processor,
                        1,
                        true,
                        Some(&src),
                    );
                    gpu.video_ctx.VideoProcessorSetStreamDestRect(
                        &self.processor,
                        1,
                        true,
                        Some(&dest),
                    );
                    streams[1] = D3D11_VIDEO_PROCESSOR_STREAM {
                        Enable: BOOL(1),
                        pInputSurface: ManuallyDrop::new(Some(view.clone())),
                        ..Default::default()
                    };
                }
            }
            let blt = gpu
                .video_ctx
                .VideoProcessorBlt(&self.processor, &output_view, 0, &streams);
            drop(ManuallyDrop::into_inner(std::ptr::read(
                &streams[0].pInputSurface,
            )));
            drop(ManuallyDrop::into_inner(std::ptr::read(
                &streams[1].pInputSurface,
            )));
            match blt {
                Ok(()) => {
                    // VideoProcessor writes on the video engine. An immediate-context
                    // EVENT query does not wait for that engine. A 3D copy after Blt
                    // creates a dependency the query can actually wait on.
                    let src: ID3D11Resource = output_tex.cast().map_err(|err| {
                        format!("VP output cast hr={:#x}", err.code().0 as u32)
                    })?;
                    let dst: ID3D11Resource = self.sync_tex.cast().map_err(|err| {
                        format!("sync surface cast hr={:#x}", err.code().0 as u32)
                    })?;
                    gpu.context.CopySubresourceRegion(&dst, 0, 0, 0, 0, &src, 0, None);
                    self.outputs[out_slot].gpu_done.end(&gpu.context)?;
                    gpu.context.Flush();
                    self.outputs[out_slot].gpu_done.wait(gpu, diag)?;
                    if frame_index >= BOUNDARY_LOG_FROM {
                        hops.push(log_surface_transition(
                            frame_index,
                            "videoprocessor_blt",
                            Some(&output_tex),
                            0,
                            out_slot as i64,
                            gameplay.subresource,
                            "0x0",
                        ));
                        hops.push(log_surface_transition(
                            frame_index,
                            "vp_output",
                            Some(&output_tex),
                            0,
                            out_slot as i64,
                            gameplay.subresource,
                            "0x0",
                        ));
                        hops.push(log_surface_transition(
                            frame_index,
                            "sync_output_ring",
                            Some(&self.sync_tex),
                            0,
                            out_slot as i64,
                            gameplay.subresource,
                            "0x0",
                        ));
                    }
                    Ok(BlitResult {
                        texture: output_tex,
                        owned_gameplay,
                        blt_hr: 0,
                        input_slot: gp_slot,
                        output_slot: out_slot,
                        decoder_slice: gameplay.subresource,
                        hops,
                    })
                }
                Err(err) => Err(format!(
                    "VideoProcessorBlt hr={:#x} {err}",
                    err.code().0 as u32
                )),
            }
        }
    }

    fn copy_gameplay_owned(
        &mut self,
        gpu: &SharedGpu,
        gameplay: &DxgiFrame,
        diag: &GpuFailDiag,
        frame_index: u64,
    ) -> Result<BlitResult, String> {
        self.ensure_input_ring(gpu, gameplay, false, diag)?;
        let mut hops = Vec::new();
        hops.push(log_surface_transition(
            frame_index,
            "decoder_dxgi_slice",
            Some(&gameplay.texture),
            gameplay.subresource,
            -1,
            gameplay.subresource,
            "0x0",
        ));
        let gp_slot = self.next_gameplay;
        self.next_gameplay = (self.next_gameplay + 1) % self.gameplay_inputs.len();
        copy_decoder_to_owned(gpu, &self.gameplay_inputs[gp_slot], gameplay, diag)?;
        self.gameplay_inputs[gp_slot].copy_done.end(&gpu.context)?;
        unsafe { gpu.context.Flush() };
        self.gameplay_inputs[gp_slot].copy_done.wait(gpu, diag)?;
        self.last_input_slot = gp_slot;
        self.last_decoder_slice = gameplay.subresource;
        let owned_gameplay = self.gameplay_inputs[gp_slot].texture.clone();
        hops.push(log_surface_transition(
            frame_index,
            "owned_gameplay_ring",
            Some(&owned_gameplay),
            0,
            gp_slot as i64,
            gameplay.subresource,
            "0x0",
        ));
        Ok(BlitResult {
            texture: owned_gameplay.clone(),
            owned_gameplay,
            blt_hr: 0,
            input_slot: gp_slot,
            output_slot: usize::MAX,
            decoder_slice: gameplay.subresource,
            hops,
        })
    }

    fn ensure_input_ring(
        &mut self,
        gpu: &SharedGpu,
        template: &DxgiFrame,
        webcam: bool,
        _diag: &GpuFailDiag,
    ) -> Result<(), String> {
        let ready = if webcam {
            !self.webcam_inputs.is_empty()
                && self.webcam_inputs[0].width == template.width
                && self.webcam_inputs[0].height == template.height
        } else {
            !self.gameplay_inputs.is_empty()
                && self.gameplay_inputs[0].width == template.width
                && self.gameplay_inputs[0].height == template.height
        };
        if ready {
            return Ok(());
        }
        let created = create_owned_input_ring(gpu, &self.enumerator, template, webcam)?;
        if webcam {
            self.webcam_inputs = created;
            self.next_webcam = 0;
        } else {
            self.gameplay_inputs = created;
            self.next_gameplay = 0;
        }
        Ok(())
    }

    fn has_free_output(&self) -> bool {
        self.outputs.iter().any(|slot| !slot.encoder_busy)
    }

    fn submit_output(&mut self, slot: usize) {
        self.outputs[slot].encoder_busy = true;
        self.encoder_q.push_back(slot);
    }

    fn release_encoder(&mut self) {
        if let Some(slot) = self.encoder_q.pop_front() {
            self.outputs[slot].encoder_busy = false;
        }
    }

    fn input_ring_busy(&self) -> u32 {
        0
    }

    fn output_ring_busy(&self) -> u32 {
        self.outputs.iter().filter(|slot| slot.encoder_busy).count() as u32
    }

    fn diag(
        &self,
        frame: u64,
        encoded: u64,
        gameplay_held: bool,
        webcam_held: bool,
    ) -> GpuFailDiag {
        let decoder_slices = u32::from(gameplay_held) + u32::from(webcam_held);
        GpuFailDiag {
            frame,
            encoded,
            in_flight: frame.saturating_sub(encoded),
            input_slot: self.last_input_slot,
            output_slot: self.last_output_slot,
            decoder_slice: self.last_decoder_slice,
            input_ring_busy: self.input_ring_busy(),
            output_ring_busy: self.output_ring_busy(),
            decoder_slices_referenced: decoder_slices,
            encoder_in_flight: self.encoder_q.len() as u32,
            vp_input_views: (self.gameplay_inputs.len() + self.webcam_inputs.len()) as u32,
            vp_output_views: self.outputs.len() as u32,
            outstanding_input_samples: decoder_slices,
            outstanding_output_samples: self.encoder_q.len() as u32,
        }
    }

    fn log_long_run(&self, gpu: &SharedGpu, frame: u64, encoded: u64, webcam_held: bool) {
        let (removed_hr, removed_name) = device_removed_reason(gpu);
        let diag = self.diag(frame, encoded, true, webcam_held);
        tracing::info!(
            frame_index = frame,
            encoded,
            in_flight = diag.in_flight,
            input_ring_busy = diag.input_ring_busy,
            output_ring_busy = diag.output_ring_busy,
            decoder_slices_referenced = diag.decoder_slices_referenced,
            encoder_in_flight = diag.encoder_in_flight,
            vp_input_views_alive = diag.vp_input_views,
            vp_output_views_alive = diag.vp_output_views,
            cpu_map_count = 0,
            device_removed_hr = format!("{removed_hr:#x}"),
            device_removed_name = removed_name,
            "gpu_dxgi long-run resource diagnostics"
        );
    }
}

fn gameplay_dest_rect(src_w: u32, src_h: u32, dst_w: u32, dst_h: u32) -> RECT {
    let (fit_w, fit_h) = fit_compose_size(src_w, src_h, dst_w, dst_h);
    let x = dst_w.saturating_sub(fit_w) / 2;
    let y = dst_h.saturating_sub(fit_h) / 2;
    even_rect(x, y, fit_w, fit_h, dst_w, dst_h)
}

fn create_owned_input_ring(
    gpu: &SharedGpu,
    enumerator: &ID3D11VideoProcessorEnumerator,
    template: &DxgiFrame,
    webcam: bool,
) -> Result<Vec<VpInputSlot>, String> {
    let mut desc = D3D11_TEXTURE2D_DESC::default();
    unsafe { template.texture.GetDesc(&mut desc) };
    tracing::info!(
        stream = if webcam { "webcam" } else { "gameplay" },
        format = format_name(desc.Format),
        width = template.width,
        height = template.height,
        decoder_bind = format!("{:#x}", desc.BindFlags),
        decoder_array = desc.ArraySize,
        "owned VideoProcessor input ring template"
    );
    desc.Width = template.width.max(2);
    desc.Height = template.height.max(2);
    desc.MipLevels = 1;
    desc.ArraySize = 1;
    desc.Usage = D3D11_USAGE_DEFAULT;
    desc.CPUAccessFlags = 0;
    desc.MiscFlags = 0;
    desc.SampleDesc = DXGI_SAMPLE_DESC {
        Count: 1,
        Quality: 0,
    };
    let bind_attempts = [
        (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0 | D3D11_BIND_VIDEO_ENCODER.0)
            as u32,
        (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
        D3D11_BIND_SHADER_RESOURCE.0 as u32,
        D3D11_BIND_VIDEO_ENCODER.0 as u32,
        0,
    ];
    let mut last_err = "no bind-flag attempt ran".to_string();
    for bind in bind_attempts {
        desc.BindFlags = bind;
        match create_owned_input_slot(gpu, enumerator, &desc, template.width, template.height) {
            Ok(first) => {
                let mut ring = Vec::with_capacity(VP_INPUT_RING);
                ring.push(first);
                for _ in 1..VP_INPUT_RING {
                    ring.push(create_owned_input_slot(
                        gpu,
                        enumerator,
                        &desc,
                        template.width,
                        template.height,
                    )?);
                }
                tracing::info!(
                    stream = if webcam { "webcam" } else { "gameplay" },
                    bind_flags = format!("{bind:#x}"),
                    slots = ring.len(),
                    "owned VideoProcessor input ring created"
                );
                return Ok(ring);
            }
            Err(err) => last_err = err,
        }
    }
    Err(last_err)
}

fn create_owned_input_slot(
    gpu: &SharedGpu,
    enumerator: &ID3D11VideoProcessorEnumerator,
    desc: &D3D11_TEXTURE2D_DESC,
    width: u32,
    height: u32,
) -> Result<VpInputSlot, String> {
    let mut texture = None;
    unsafe {
        gpu.device
            .CreateTexture2D(desc, None, Some(&mut texture))
            .map_err(|err| format!("Could not create owned VP input hr={:#x} {err}", err.code().0 as u32))?;
    }
    let texture = texture.ok_or_else(|| "owned VP input surface was empty.".to_string())?;
    let view = input_view(gpu, enumerator, &texture, 0)?;
    Ok(VpInputSlot {
        texture,
        view,
        copy_done: GpuEvent::create(&gpu.device)?,
        width,
        height,
    })
}

fn copy_decoder_to_owned(
    gpu: &SharedGpu,
    dest: &VpInputSlot,
    src: &DxgiFrame,
    diag: &GpuFailDiag,
) -> Result<(), String> {
    let dst: ID3D11Resource = dest.texture.cast().map_err(|err| {
        gpu_fail(gpu, "owned_input_cast", err.code().0 as u32, diag)
    })?;
    let source: ID3D11Resource = src.texture.cast().map_err(|err| {
        gpu_fail(gpu, "decoder_surface_cast", err.code().0 as u32, diag)
    })?;
    unsafe {
        gpu.context
            .CopySubresourceRegion(&dst, 0, 0, 0, 0, &source, src.subresource, None);
    }
    Ok(())
}

fn input_view(
    gpu: &SharedGpu,
    enumerator: &ID3D11VideoProcessorEnumerator,
    texture: &ID3D11Texture2D,
    subresource: u32,
) -> Result<ID3D11VideoProcessorInputView, String> {
    let desc = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
        FourCC: 0,
        ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
        Anonymous: D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0 {
            Texture2D: D3D11_TEX2D_VPIV {
                MipSlice: 0,
                ArraySlice: subresource,
            },
        },
    };
    let mut view = None;
    unsafe {
        gpu.video
            .CreateVideoProcessorInputView(texture, enumerator, &desc, Some(&mut view))
            .map_err(|err| format!("Could not create a video processor input view: {err}"))?;
    }
    view.ok_or_else(|| "Video processor input view was empty.".into())
}

fn even_rect(x: u32, y: u32, w: u32, h: u32, max_w: u32, max_h: u32) -> RECT {
    let x = x & !1;
    let y = y & !1;
    let w = w.max(2) & !1;
    let h = h.max(2) & !1;
    let right = (x + w).min(max_w) as i32;
    let bottom = (y + h).min(max_h) as i32;
    RECT {
        left: x.min(max_w.saturating_sub(2)) as i32,
        top: y.min(max_h.saturating_sub(2)) as i32,
        right: right.max(2),
        bottom: bottom.max(2),
    }
}

fn open_dxgi_reader(
    path: &Path,
    manager: &IMFDXGIDeviceManager,
) -> Result<IMFSourceReader, String> {
    let wide = wide_path(path);
    unsafe {
        let mut attrs = None;
        MFCreateAttributes(&mut attrs, 4).map_err(|err| err.to_string())?;
        let attrs = attrs.ok_or_else(|| "Could not create DXGI reader attributes.".to_string())?;
        attrs
            .SetUnknown(&MF_SOURCE_READER_D3D_MANAGER, manager)
            .map_err(|err| format!("Could not attach DXGI to the decoder: {err}"))?;
        let _ = attrs.SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1);
        let reader = MFCreateSourceReaderFromURL(PCWSTR(wide.as_ptr()), Some(&attrs))
            .map_err(|err| format!("Could not open {}: {err}", path.display()))?;
        let _ = reader.SetStreamSelection(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32, true);
        let _ = reader.SetStreamSelection(MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32, false);
        let output = MFCreateMediaType().map_err(|err| err.to_string())?;
        output
            .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
            .map_err(|err| err.to_string())?;
        output
            .SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12)
            .map_err(|err| err.to_string())?;
        reader
            .SetCurrentMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32, None, &output)
            .map_err(|err| format!("DXGI decoder rejected NV12 for {}: {err}", path.display()))?;
        Ok(reader)
    }
}

fn seek_hns(reader: &IMFSourceReader, position_hns: i64) -> Result<(), String> {
    unsafe {
        let position = PROPVARIANT::from(position_hns.max(0));
        reader
            .SetCurrentPosition(&GUID::zeroed(), &position)
            .map_err(|err| format!("Could not seek the DXGI reader: {err}"))?;
    }
    Ok(())
}

fn read_dxgi_sample(reader: &IMFSourceReader) -> Result<Option<DxgiFrame>, String> {
    let mut flags = 0_u32;
    let mut timestamp = 0_i64;
    let mut sample: Option<IMFSample> = None;
    unsafe {
        reader
            .ReadSample(
                MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32,
                0,
                None,
                Some(&mut flags),
                Some(&mut timestamp),
                Some(&mut sample),
            )
            .map_err(|err| format!("Could not read a DXGI sample: {err}"))?;
    }
    if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
        return Ok(None);
    }
    if flags != 0 {
        tracing::info!(flags = format!("{flags:#x}"), timestamp, "DXGI reader flags");
    }
    let Some(sample) = sample else {
        return Ok(None);
    };
    let duration = unsafe { sample.GetSampleDuration().unwrap_or(0) }.max(10_000);
    let buffer = unsafe { sample.GetBufferByIndex(0).map_err(|err| err.to_string())? };
    let dxgi: IMFDXGIBuffer = buffer.cast().map_err(|_| {
        "Decoder did not return a DXGI surface; GPU compose cannot map the frame.".to_string()
    })?;
    let texture = dxgi_texture(&dxgi)?;
    let subresource = unsafe { dxgi.GetSubresourceIndex().unwrap_or(0) };
    let mut desc = D3D11_TEXTURE2D_DESC::default();
    unsafe { texture.GetDesc(&mut desc) };
    if desc.Width == 0 || desc.Height == 0 {
        if let Ok(packed) = unsafe {
            reader
                .GetCurrentMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32)
                .and_then(|media| media.GetUINT64(&MF_MT_FRAME_SIZE))
        } {
            desc.Width = (packed >> 32) as u32;
            desc.Height = packed as u32;
        }
    }
    Ok(Some(DxgiFrame {
        sample,
        texture,
        subresource,
        width: desc.Width,
        height: desc.Height,
        timestamp,
        duration,
    }))
}

fn dxgi_texture(dxgi: &IMFDXGIBuffer) -> Result<ID3D11Texture2D, String> {
    unsafe {
        let mut raw = std::ptr::null_mut();
        dxgi.GetResource(&ID3D11Texture2D::IID, &mut raw)
            .map_err(|err| format!("Could not get the DXGI texture: {err}"))?;
        if raw.is_null() {
            return Err("DXGI buffer had no texture.".into());
        }
        Ok(ID3D11Texture2D::from_raw(raw as *mut _))
    }
}

impl DxgiWebcam {
    fn open(
        path: &Path,
        manager: &IMFDXGIDeviceManager,
        start_hns: i64,
        end_hns: i64,
    ) -> Result<Self, String> {
        let reader = open_dxgi_reader(path, manager)?;
        if start_hns > 0 {
            seek_hns(&reader, start_hns)?;
        }
        Ok(Self {
            reader,
            current: None,
            pending: None,
            timeline: FollowTimeline::new(start_hns, end_hns),
            frames: 0,
        })
    }

    fn ensure_at(&mut self, gameplay_source: i64) {
        let target = self
            .timeline
            .gameplay_pts(gameplay_source)
            .saturating_add(crate::camera::WEBCAM_FOLLOW_LEAD_HNS);
        let mut last_ts = self.current.as_ref().map(|frame| frame.timestamp);
        loop {
            let Some(frame) = self.take_sample() else {
                return;
            };
            let ts = frame.timestamp;
            let next_norm = self.timeline.webcam_pts(ts);
            match decide_webcam_advance(self.current.is_some(), last_ts, ts, next_norm, target) {
                WebcamAdvance::Adopt => {
                    let non_monotonic = last_ts.is_some_and(|previous| ts <= previous);
                    last_ts = Some(ts);
                    self.current = Some(frame);
                    if non_monotonic {
                        return;
                    }
                }
                WebcamAdvance::KeepCurrent | WebcamAdvance::RejectFuture => {
                    self.pending = Some(frame);
                    return;
                }
            }
        }
    }

    fn take_sample(&mut self) -> Option<DxgiFrame> {
        if let Some(pending) = self.pending.take() {
            return Some(pending);
        }
        read_dxgi_sample(&self.reader).ok().flatten()
    }

    fn log_sample(&mut self, output_pts: i64, at_end: bool) {
        self.timeline.note_output_pts(output_pts);
        let webcam_source = self.current.as_ref().map(|frame| frame.timestamp);
        let webcam_norm = webcam_source.map(|ts| self.timeline.webcam_pts(ts));
        self.timeline.log_follow(
            self.frames,
            self.timeline.last_gameplay_source(),
            self.timeline.last_gameplay_norm(),
            webcam_source,
            webcam_norm,
            at_end,
        );
        self.frames = self.frames.saturating_add(1);
    }
}

fn reader_transform_name(reader: &IMFSourceReader) -> Option<String> {
    unsafe {
        let ex: IMFSourceReaderEx = reader.cast().ok()?;
        let mut category = GUID::zeroed();
        let mut transform: Option<IMFTransform> = None;
        ex.GetTransformForStream(
            MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32,
            0,
            Some(&mut category as *mut _),
            &mut transform,
        )
        .ok()?;
        let transform = transform?;
        let attrs = transform.GetAttributes().ok()?;
        let mut pwstr = windows::core::PWSTR::null();
        let mut len = 0u32;
        attrs
            .GetAllocatedString(&MFT_FRIENDLY_NAME_Attribute, &mut pwstr, &mut len)
            .ok()?;
        if pwstr.is_null() {
            return None;
        }
        let value = pwstr.to_string().unwrap_or_default();
        CoTaskMemFree(Some(pwstr.0 as *const std::ffi::c_void));
        if value.is_empty() {
            None
        } else {
            Some(value)
        }
    }
}

fn adapter_name(device: &ID3D11Device) -> String {
    unsafe {
        let Ok(dxgi) = device.cast::<IDXGIDevice>() else {
            return "D3D11".into();
        };
        let Ok(adapter) = dxgi.GetAdapter() else {
            return "D3D11".into();
        };
        let Ok(desc) = adapter.GetDesc() else {
            return "D3D11".into();
        };
        let end = desc
            .Description
            .iter()
            .position(|ch| *ch == 0)
            .unwrap_or(desc.Description.len());
        String::from_utf16_lossy(&desc.Description[..end])
    }
}

fn wide_path(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

#[allow(dead_code)]
fn isolate_first_gpu_frame(
    gpu: &SharedGpu,
    writer: &mut MfWriter,
    selected_encoder: &str,
) -> Result<(), String> {
    let inventory = crate::camera::encoder::log_h264_inventory();
    log_nvidia_selection(&inventory, selected_encoder);
    writer.log_video_input_media_type("live_writer");
    log_shared_device(gpu);
    tracing::info!(
        reset_token = gpu.reset_token,
        shared_device = format!("{:#x}", raw_ptr(&gpu.device)),
        manager = format!("{:#x}", raw_ptr(&gpu.manager)),
        sinkwriter_d3d_manager_set = writer.d3d_manager_set(),
        "SinkWriter D3D manager wiring vs shared compose device"
    );
    if !writer.d3d_manager_set() {
        return Err(stop_boundary(
            BOUNDARY_MISSING_MANAGER,
            "MF_SINK_WRITER_D3D_MANAGER was not set on SinkWriter attributes",
        ));
    }

    let Some(bound) = writer.h264_transform() else {
        return Err(stop_boundary(
            BOUNDARY_ENCODER,
            "SinkWriter has no bound H.264 transform to query",
        ));
    };
    let bound_aware = d3d11_aware(&bound);
    tracing::info!(
        selected = selected_encoder,
        mf_sa_d3d11_aware = bound_aware,
        transform = format!("{:#x}", raw_ptr(&bound)),
        "selected SinkWriter encoder MFT D3D11 awareness"
    );
    if bound_aware == Some(false) {
        return Err(stop_boundary(
            BOUNDARY_NOT_D3D11,
            "selected encoder advertised MF_SA_D3D11_AWARE=FALSE; D3D11 DXGI samples are not expected to work",
        ));
    }

    let bind_encoder = D3D11_BIND_VIDEO_ENCODER.0 as u32;
    let blank = create_blank_nv12(&gpu.device, GPU_ENCODER_W, GPU_ENCODER_H, bind_encoder)
        .map_err(|err| stop_boundary(BOUNDARY_ENCODER, &format!("blank texture create: {err}")))?;
    dump_texture(
        "direct_mft_blank",
        &blank,
        gpu,
        0,
        GPU_ENCODER_W,
        GPU_ENCODER_H,
    );
    let _ = writer;
    let report = probe_direct_encode_loop(gpu, selected_encoder, &blank, bound_aware);
    let boundary = if report.ok {
        "direct_mft_loop_ok"
    } else {
        "direct_mft_loop_failed"
    };
    Err(stop_boundary(boundary, &report.summary()))
}

fn isolate_h264_mp4_mux(gpu: &SharedGpu, output: &Path) -> Result<ComposeReport, String> {
    let inventory = crate::camera::encoder::log_h264_inventory();
    let encoder_name = pick_direct_encoder_name(&inventory);
    log_nvidia_selection(&inventory, &encoder_name);
    let transform = activate_named_h264_encoder(&encoder_name)
        .ok_or_else(|| format!("Could not activate the direct H.264 encoder {encoder_name}"))?;
    let bound_aware = d3d11_aware(&transform);
    configure_direct_encoder(
        &transform,
        gpu,
        bound_aware,
        60,
        gpu_encoder_bitrate(ComposeQuality::Cloud, 60),
    )?;
    match unsafe { transform.GetOutputCurrentType(0) } {
        Ok(media) => dump_complete_media_type("encoder_output_after_configure", &media),
        Err(err) => tracing::error!(
            hr = format!("{:#x}", err.code().0 as u32),
            %err,
            "GetOutputCurrentType failed after configure"
        ),
    }
    let bind_encoder = D3D11_BIND_VIDEO_ENCODER.0 as u32;
    let blank = create_blank_nv12(&gpu.device, GPU_ENCODER_W, GPU_ENCODER_H, bind_encoder)
        .map_err(|err| stop_boundary("h264_mp4_mux_failed", &format!("blank texture: {err}")))?;
    let report = encode_blank_samples(&transform, &blank);
    match unsafe { transform.GetOutputCurrentType(0) } {
        Ok(media) => dump_complete_media_type("encoder_output_after_encode", &media),
        Err(err) => tracing::error!(
            hr = format!("{:#x}", err.code().0 as u32),
            %err,
            "GetOutputCurrentType failed after encode"
        ),
    }
    if !report.ok {
        return Err(stop_boundary(
            "h264_mp4_mux_failed",
            &format!("blank encode failed {}", report.summary()),
        ));
    }
    let mux_type = unsafe { transform.GetOutputCurrentType(0) }.map_err(|err| {
        stop_boundary(
            "h264_mp4_mux_failed",
            &format!(
                "no negotiated encoder output type hr={:#x} {err}",
                err.code().0 as u32
            ),
        )
    })?;
    dump_complete_media_type("mux_input_from_encoder", &mux_type);
    let probe_path = output.with_file_name("h264-mux-probe.mp4");
    let _ = std::fs::remove_file(&probe_path);
    let mux = match H264Mp4Mux::create(&probe_path, &mux_type, None) {
        Ok(mux) => mux,
        Err(err) => {
            dump_complete_media_type("mux_input_rejected", &mux_type);
            return Err(stop_boundary("h264_mp4_mux_failed", &err));
        }
    };
    for (index, sample) in report.samples.iter().enumerate() {
        if let Err(err) = mux.write_video(sample) {
            return Err(stop_boundary(
                "h264_mp4_mux_failed",
                &format!("WriteSample {index}: {err}"),
            ));
        }
    }
    mux.finish()
        .map_err(|err| stop_boundary("h264_mp4_mux_failed", &err))?;
    let probe = probe_muxed_mp4(&probe_path)?;
    tracing::info!(
        path = %probe_path.display(),
        encoded = report.encoded,
        written = report.samples.len(),
        file_bytes = probe.bytes,
        duration_hns = probe.duration_hns,
        duration_ms = probe.duration_hns / 10_000,
        first_sample = probe.first_sample,
        "H.264 mux probe finished"
    );
    Err(stop_boundary(
        "h264_mp4_mux_ok",
        &format!(
            "encoded={} written={} file_bytes={} duration_ms={} first_sample={}",
            report.encoded,
            report.samples.len(),
            probe.bytes,
            probe.duration_hns / 10_000,
            probe.first_sample
        ),
    ))
}

fn encode_blank_samples(transform: &IMFTransform, blank: &ID3D11Texture2D) -> DirectLoopReport {
    let started = Instant::now();
    let mut report = DirectLoopReport {
        ok: false,
        submitted: 0,
        encoded: 0,
        first_output_after: None,
        sizes: Vec::new(),
        samples: Vec::new(),
        elapsed_ms: 0,
        events: Vec::new(),
        drain: "not_started".into(),
        fatal: None,
    };
    let Ok(events) = transform.cast::<IMFMediaEventGenerator>() else {
        report.fatal = Some("no_event_generator".into());
        report.elapsed_ms = started.elapsed().as_millis();
        return report;
    };
    let mut draining = false;
    let mut drain_complete = false;
    let deadline = Instant::now() + DIRECT_LOOP_TIMEOUT;
    while Instant::now() < deadline && !drain_complete {
        if !draining && report.submitted >= DIRECT_LOOP_FRAMES {
            send_lifecycle(transform, "NOTIFY_END_OF_STREAM", MFT_MESSAGE_NOTIFY_END_OF_STREAM);
            send_lifecycle(transform, "COMMAND_DRAIN", MFT_MESSAGE_COMMAND_DRAIN);
            draining = true;
            report.drain = "drain_sent".into();
        }
        match unsafe { events.GetEvent(MF_EVENT_FLAG_NO_WAIT) } {
            Ok(event) => {
                let ty = unsafe { event.GetType().unwrap_or(0) };
                let status = unsafe { event.GetStatus().ok() };
                if status.is_some_and(|hr| hr.is_err()) || ty == MEError.0 as u32 {
                    report.fatal = Some(format!("{} status={:?}", event_name(ty), status));
                    break;
                }
                if ty == METransformNeedInput.0 as u32 && !draining && report.submitted < DIRECT_LOOP_FRAMES
                {
                    let time = i64::from(report.submitted) * PROBE_DURATION_HNS;
                    match wrap_blank_frame(blank, time) {
                        Ok(sample) => {
                            let hr = process_input_hr(transform, &sample, "mux_probe");
                            if hr != "0x0" {
                                report.fatal = Some(format!("ProcessInput {hr}"));
                                break;
                            }
                            report.submitted += 1;
                        }
                        Err(err) => {
                            report.fatal = Some(err);
                            break;
                        }
                    }
                }
                if ty == METransformHaveOutput.0 as u32 {
                    match take_encoded_output(transform, report.encoded < 3) {
                        Ok(nalu) => {
                            if report.first_output_after.is_none() {
                                report.first_output_after = Some(report.submitted);
                                if let Ok(media) = unsafe { transform.GetOutputCurrentType(0) } {
                                    dump_complete_media_type(
                                        "encoder_output_after_first_sample",
                                        &media,
                                    );
                                }
                            }
                            report.encoded += 1;
                            report.sizes.push(nalu.size);
                            report.samples.push(nalu.sample);
                        }
                        Err(err) => {
                            report.fatal = Some(err);
                            break;
                        }
                    }
                }
                if ty == METransformDrainComplete.0 as u32 {
                    drain_complete = true;
                    report.drain = "drain_complete".into();
                }
            }
            Err(_) => {
                if draining {
                    let drain_deadline = Instant::now() + DIRECT_DRAIN_TIMEOUT;
                    while Instant::now() < drain_deadline && !drain_complete {
                        match unsafe { events.GetEvent(MF_EVENT_FLAG_NO_WAIT) } {
                            Ok(event) => {
                                let ty = unsafe { event.GetType().unwrap_or(0) };
                                if ty == METransformHaveOutput.0 as u32 {
                                    if let Ok(nalu) = take_encoded_output(transform, false) {
                                        report.encoded += 1;
                                        report.sizes.push(nalu.size);
                                        report.samples.push(nalu.sample);
                                    }
                                }
                                if ty == METransformDrainComplete.0 as u32 {
                                    drain_complete = true;
                                    report.drain = "drain_complete".into();
                                    break;
                                }
                            }
                            Err(_) => thread::sleep(Duration::from_millis(20)),
                        }
                    }
                    break;
                }
                thread::sleep(Duration::from_millis(20));
            }
        }
    }
    send_lifecycle(transform, "NOTIFY_END_STREAMING", MFT_MESSAGE_NOTIFY_END_STREAMING);
    if draining && !drain_complete && report.drain == "drain_sent" {
        report.drain = "drain_timeout".into();
    }
    report.ok = report.submitted >= DIRECT_LOOP_FRAMES
        && report.encoded >= 1
        && report.fatal.is_none()
        && report.drain != "drain_timeout";
    report.elapsed_ms = started.elapsed().as_millis();
    tracing::info!(
        submitted = report.submitted,
        encoded = report.encoded,
        elapsed_ms = report.elapsed_ms,
        drain = %report.drain,
        ok = report.ok,
        "mux probe blank encode finished"
    );
    report
}

struct MuxProbe {
    bytes: u64,
    duration_hns: i64,
    first_sample: u32,
}

fn probe_muxed_mp4(path: &Path) -> Result<MuxProbe, String> {
    let bytes = std::fs::metadata(path)
        .map_err(|err| format!("mux probe file missing: {err}"))?
        .len();
    if bytes < 1_000 {
        return Err(stop_boundary(
            "h264_mp4_mux_failed",
            &format!("mux probe file too small: {bytes} bytes"),
        ));
    }
    let wide = wide_path(path);
    unsafe {
        let reader = MFCreateSourceReaderFromURL(PCWSTR(wide.as_ptr()), None).map_err(|err| {
            format!("mux probe SourceReader hr={:#x} {err}", err.code().0 as u32)
        })?;
        let _ = reader.SetStreamSelection(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32, true);
        let _ = reader.SetStreamSelection(MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32, false);
        let duration_hns = reader
            .GetPresentationAttribute(MF_SOURCE_READER_MEDIASOURCE.0 as u32, &MF_PD_DURATION)
            .ok()
            .map(|value| value.Anonymous.Anonymous.Anonymous.hVal)
            .unwrap_or(0);
        let mut flags = 0u32;
        let mut sample = None;
        reader
            .ReadSample(
                MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32,
                0,
                None,
                Some(&mut flags),
                None,
                Some(&mut sample),
            )
            .map_err(|err| format!("mux probe ReadSample hr={:#x} {err}", err.code().0 as u32))?;
        let first_sample = sample
            .as_ref()
            .and_then(|item| item.GetTotalLength().ok())
            .unwrap_or(0);
        if sample.is_none() {
            return Err(stop_boundary(
                "h264_mp4_mux_failed",
                "mux probe MP4 has no video sample",
            ));
        }
        Ok(MuxProbe {
            bytes,
            duration_hns,
            first_sample,
        })
    }
}

fn dump_complete_media_type(label: &str, media: &windows::Win32::Media::MediaFoundation::IMFMediaType) {
    unsafe {
        let major = guid_name(media.GetGUID(&MF_MT_MAJOR_TYPE).ok());
        let subtype = guid_name(media.GetGUID(&MF_MT_SUBTYPE).ok());
        let frame_size = media.GetUINT64(&MF_MT_FRAME_SIZE).ok();
        let frame_rate = media.GetUINT64(&MF_MT_FRAME_RATE).ok();
        let par = media.GetUINT64(&MF_MT_PIXEL_ASPECT_RATIO).ok();
        let interlace = media.GetUINT32(&MF_MT_INTERLACE_MODE).ok();
        let profile = media.GetUINT32(&MF_MT_MPEG2_PROFILE).ok();
        let level = media.GetUINT32(&MF_MT_MPEG2_LEVEL).ok();
        let bitrate = media.GetUINT32(&MF_MT_AVG_BITRATE).ok();
        let seq = blob_summary(media, &MF_MT_MPEG_SEQUENCE_HEADER);
        let user = blob_summary(media, &MF_MT_USER_DATA);
        let mpeg4_desc = blob_summary(media, &MF_MT_MPEG4_SAMPLE_DESCRIPTION);
        let mpeg4_entry = media.GetUINT32(&MF_MT_MPEG4_CURRENT_SAMPLE_ENTRY).ok();
        let (width, height) = frame_size
            .map(|packed| ((packed >> 32) as u32, packed as u32))
            .unwrap_or((0, 0));
        let (rate_n, rate_d) = frame_rate
            .map(|packed| ((packed >> 32) as u32, packed as u32))
            .unwrap_or((0, 0));
        let (par_n, par_d) = par
            .map(|packed| ((packed >> 32) as u32, packed as u32))
            .unwrap_or((0, 0));
        tracing::info!(
            label,
            major,
            subtype,
            width,
            height,
            frame_rate = format!("{rate_n}/{rate_d}"),
            par = format!("{par_n}/{par_d}"),
            interlace,
            mpeg2_profile = profile,
            mpeg2_level = level,
            avg_bitrate = bitrate,
            mpeg_sequence_header = seq.as_str(),
            user_data = user.as_str(),
            mpeg4_sample_description = mpeg4_desc.as_str(),
            mpeg4_current_sample_entry = mpeg4_entry,
            "complete IMFMediaType"
        );
        if let Ok(count) = media.GetCount() {
            for index in 0..count {
                let mut key = GUID::zeroed();
                if media.GetItemByIndex(index, &mut key, None).is_err() {
                    continue;
                }
                let name = known_mt_name(&key);
                if let Ok(guid) = media.GetGUID(&key) {
                    tracing::info!(label, index, attr = name, kind = "guid", value = guid_name(Some(guid)), "media type attribute");
                } else if let Ok(value) = media.GetUINT64(&key) {
                    tracing::info!(label, index, attr = name, kind = "uint64", value, "media type attribute");
                } else if let Ok(value) = media.GetUINT32(&key) {
                    tracing::info!(label, index, attr = name, kind = "uint32", value, "media type attribute");
                } else {
                    tracing::info!(
                        label,
                        index,
                        attr = name,
                        kind = "other",
                        blob = blob_summary(media, &key).as_str(),
                        "media type attribute"
                    );
                }
            }
        }
    }
}

fn known_mt_name(guid: &GUID) -> String {
    if *guid == MF_MT_MAJOR_TYPE {
        "MF_MT_MAJOR_TYPE".into()
    } else if *guid == MF_MT_SUBTYPE {
        "MF_MT_SUBTYPE".into()
    } else if *guid == MF_MT_FRAME_SIZE {
        "MF_MT_FRAME_SIZE".into()
    } else if *guid == MF_MT_FRAME_RATE {
        "MF_MT_FRAME_RATE".into()
    } else if *guid == MF_MT_PIXEL_ASPECT_RATIO {
        "MF_MT_PIXEL_ASPECT_RATIO".into()
    } else if *guid == MF_MT_INTERLACE_MODE {
        "MF_MT_INTERLACE_MODE".into()
    } else if *guid == MF_MT_MPEG2_PROFILE {
        "MF_MT_MPEG2_PROFILE".into()
    } else if *guid == MF_MT_MPEG2_LEVEL {
        "MF_MT_MPEG2_LEVEL".into()
    } else if *guid == MF_MT_AVG_BITRATE {
        "MF_MT_AVG_BITRATE".into()
    } else if *guid == MF_MT_MPEG_SEQUENCE_HEADER {
        "MF_MT_MPEG_SEQUENCE_HEADER".into()
    } else if *guid == MF_MT_USER_DATA {
        "MF_MT_USER_DATA".into()
    } else if *guid == MF_MT_MPEG4_SAMPLE_DESCRIPTION {
        "MF_MT_MPEG4_SAMPLE_DESCRIPTION".into()
    } else if *guid == MF_MT_MPEG4_CURRENT_SAMPLE_ENTRY {
        "MF_MT_MPEG4_CURRENT_SAMPLE_ENTRY".into()
    } else {
        format!("{guid:?}")
    }
}

fn guid_name(guid: Option<GUID>) -> String {
    match guid {
        Some(value) if value == MFMediaType_Video => "MFMediaType_Video".into(),
        Some(value) if value == MFVideoFormat_H264 => "MFVideoFormat_H264".into(),
        Some(value) if value == MFVideoFormat_NV12 => "MFVideoFormat_NV12".into(),
        Some(value) => format!("{value:?}"),
        None => "missing".into(),
    }
}

fn blob_summary(
    media: &windows::Win32::Media::MediaFoundation::IMFMediaType,
    key: &GUID,
) -> String {
    unsafe {
        let mut ptr = std::ptr::null_mut();
        let mut len = 0u32;
        if media.GetAllocatedBlob(key, &mut ptr, &mut len).is_err() || ptr.is_null() {
            return "missing".into();
        }
        let bytes = std::slice::from_raw_parts(ptr, len as usize);
        let preview: String = bytes
            .iter()
            .take(16)
            .map(|byte| format!("{byte:02x}"))
            .collect::<Vec<_>>()
            .join(" ");
        CoTaskMemFree(Some(ptr as *const std::ffi::c_void));
        format!("len={len} head={preview}")
    }
}

struct DirectLoopReport {
    ok: bool,
    submitted: u32,
    encoded: u32,
    first_output_after: Option<u32>,
    sizes: Vec<u32>,
    samples: Vec<IMFSample>,
    elapsed_ms: u128,
    events: Vec<String>,
    drain: String,
    fatal: Option<String>,
}

impl DirectLoopReport {
    fn summary(&self) -> String {
        format!(
            "submitted={} encoded={} first_output_after={:?} sizes={:?} elapsed_ms={} drain={} fatal={:?} events={:?}",
            self.submitted,
            self.encoded,
            self.first_output_after,
            self.sizes,
            self.elapsed_ms,
            self.drain,
            self.fatal,
            self.events
        )
    }
}

fn probe_direct_encode_loop(
    gpu: &SharedGpu,
    selected_encoder: &str,
    blank: &ID3D11Texture2D,
    bound_aware: Option<bool>,
) -> DirectLoopReport {
    let started = Instant::now();
    let mut report = DirectLoopReport {
        ok: false,
        submitted: 0,
        encoded: 0,
        first_output_after: None,
        sizes: Vec::new(),
        samples: Vec::new(),
        elapsed_ms: 0,
        events: Vec::new(),
        drain: "not_started".into(),
        fatal: None,
    };
    let Some(transform) = activate_named_h264_encoder(selected_encoder) else {
        report.fatal = Some("activate_failed".into());
        report.elapsed_ms = started.elapsed().as_millis();
        return report;
    };
    if let Err(err) = configure_direct_encoder(
        &transform,
        gpu,
        bound_aware,
        60,
        gpu_encoder_bitrate(ComposeQuality::Cloud, 60),
    ) {
        report.fatal = Some(err);
        report.elapsed_ms = started.elapsed().as_millis();
        return report;
    }
    let Ok(events) = transform.cast::<IMFMediaEventGenerator>() else {
        report.fatal = Some("no_event_generator".into());
        report.elapsed_ms = started.elapsed().as_millis();
        return report;
    };

    let mut draining = false;
    let mut drain_complete = false;
    let mut order = 0u32;
    let deadline = Instant::now() + DIRECT_LOOP_TIMEOUT;
    while Instant::now() < deadline && !drain_complete {
        if !draining && report.submitted >= DIRECT_LOOP_FRAMES {
            send_lifecycle(&transform, "NOTIFY_END_OF_STREAM", MFT_MESSAGE_NOTIFY_END_OF_STREAM);
            send_lifecycle(&transform, "COMMAND_DRAIN", MFT_MESSAGE_COMMAND_DRAIN);
            draining = true;
            report.drain = "drain_sent".into();
        }
        match unsafe { events.GetEvent(MF_EVENT_FLAG_NO_WAIT) } {
            Ok(event) => {
                let ty = unsafe { event.GetType().unwrap_or(0) };
                let status = unsafe { event.GetStatus().ok() };
                let status_hr = status
                    .map(|hr| format!("{:#x}", hr.0 as u32))
                    .unwrap_or_else(|| "n/a".into());
                let name = event_name(ty);
                order += 1;
                let line = format!("#{order} {name} type={ty} status={status_hr}");
                tracing::info!(
                    order,
                    event = name,
                    event_type = ty,
                    status_hr,
                    submitted = report.submitted,
                    encoded = report.encoded,
                    "direct encode loop event"
                );
                report.events.push(line);
                if status.is_some_and(|hr| hr.is_err()) || ty == MEError.0 as u32 {
                    report.fatal = Some(format!("{name} status={status_hr}"));
                    break;
                }
                if ty == METransformNeedInput.0 as u32 && !draining && report.submitted < DIRECT_LOOP_FRAMES {
                    let time = i64::from(report.submitted) * PROBE_DURATION_HNS;
                    match wrap_blank_frame(blank, time) {
                        Ok(sample) => {
                            let hr = process_input_hr(&transform, &sample, "direct_loop");
                            if hr != "0x0" {
                                report.fatal = Some(format!("ProcessInput {hr} at frame {}", report.submitted));
                                break;
                            }
                            report.submitted += 1;
                        }
                        Err(err) => {
                            report.fatal = Some(err);
                            break;
                        }
                    }
                }
                if ty == METransformHaveOutput.0 as u32 {
                    match take_encoded_output(&transform, report.encoded < 3) {
                        Ok(nalu) => {
                            if report.first_output_after.is_none() {
                                report.first_output_after = Some(report.submitted);
                            }
                            report.encoded += 1;
                            report.sizes.push(nalu.size);
                            report.samples.push(nalu.sample);
                            tracing::info!(
                                encoded = report.encoded,
                                submitted = report.submitted,
                                sample_size = nalu.size,
                                "direct encode loop ProcessOutput"
                            );
                        }
                        Err(err) => {
                            report.fatal = Some(err);
                            break;
                        }
                    }
                }
                if ty == METransformDrainComplete.0 as u32 {
                    drain_complete = true;
                    report.drain = "drain_complete".into();
                }
            }
            Err(_) => {
                if draining {
                    let drain_deadline = Instant::now() + DIRECT_DRAIN_TIMEOUT;
                    while Instant::now() < drain_deadline && !drain_complete {
                        match unsafe { events.GetEvent(MF_EVENT_FLAG_NO_WAIT) } {
                            Ok(event) => {
                                let ty = unsafe { event.GetType().unwrap_or(0) };
                                order += 1;
                                let name = event_name(ty);
                                report.events.push(format!("#{order} {name} type={ty}"));
                                tracing::info!(order, event = name, "direct encode drain event");
                                if ty == METransformHaveOutput.0 as u32 {
                                    if let Ok(nalu) = take_encoded_output(&transform, false) {
                                        if report.first_output_after.is_none() {
                                            report.first_output_after = Some(report.submitted);
                                        }
                                        report.encoded += 1;
                                        report.sizes.push(nalu.size);
                                        report.samples.push(nalu.sample);
                                    }
                                }
                                if ty == METransformDrainComplete.0 as u32 {
                                    drain_complete = true;
                                    report.drain = "drain_complete".into();
                                    break;
                                }
                            }
                            Err(_) => thread::sleep(Duration::from_millis(20)),
                        }
                    }
                    break;
                }
                thread::sleep(Duration::from_millis(20));
            }
        }
    }
    send_lifecycle(&transform, "NOTIFY_END_STREAMING", MFT_MESSAGE_NOTIFY_END_STREAMING);
    if draining && !drain_complete && report.drain == "drain_sent" {
        report.drain = "drain_timeout".into();
    }
    report.ok = report.submitted >= DIRECT_LOOP_FRAMES
        && report.encoded >= 1
        && report.fatal.is_none()
        && report.drain != "drain_timeout";
    report.elapsed_ms = started.elapsed().as_millis();
    tracing::info!(
        submitted = report.submitted,
        encoded = report.encoded,
        first_output_after = report.first_output_after,
        sizes = ?report.sizes,
        elapsed_ms = report.elapsed_ms,
        drain = %report.drain,
        fatal = report.fatal.as_deref(),
        events = report.events.len(),
        ok = report.ok,
        "direct H.264 MFT encode loop finished"
    );
    report
}

fn configure_direct_encoder(
    transform: &IMFTransform,
    gpu: &SharedGpu,
    bound_aware: Option<bool>,
    fps: u32,
    bitrate: u32,
) -> Result<(), String> {
    unsafe {
        if let Ok(attrs) = transform.GetAttributes() {
            if attrs.GetUINT32(&MF_TRANSFORM_ASYNC).unwrap_or(0) != 0 {
                attrs
                    .SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1)
                    .map_err(|err| format!("MF_TRANSFORM_ASYNC_UNLOCK hr={:#x}", err.code().0 as u32))?;
            }
        }
        if bound_aware != Some(false) {
            transform
                .ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, raw_ptr(&gpu.manager))
                .map_err(|err| format!("SET_D3D_MANAGER hr={:#x}", err.code().0 as u32))?;
        }
        let output_type = h264_output_type(fps, bitrate)?;
        let input_type = nv12_input_type(fps)?;
        transform
            .SetOutputType(0, &output_type, 0)
            .map_err(|err| format!("SetOutputType hr={:#x}", err.code().0 as u32))?;
        transform
            .SetInputType(0, &input_type, 0)
            .map_err(|err| format!("SetInputType hr={:#x}", err.code().0 as u32))?;
        send_lifecycle(transform, "NOTIFY_BEGIN_STREAMING", MFT_MESSAGE_NOTIFY_BEGIN_STREAMING);
        send_lifecycle(transform, "NOTIFY_START_OF_STREAM", MFT_MESSAGE_NOTIFY_START_OF_STREAM);
    }
    Ok(())
}

fn send_lifecycle(transform: &IMFTransform, name: &str, message: windows::Win32::Media::MediaFoundation::MFT_MESSAGE_TYPE) {
    match unsafe { transform.ProcessMessage(message, 0) } {
        Ok(()) => tracing::info!(message = name, hr = "0x0", "direct encoder lifecycle message"),
        Err(err) => tracing::warn!(
            message = name,
            hr = format!("{:#x}", err.code().0 as u32),
            %err,
            "direct encoder lifecycle message failed"
        ),
    }
}

fn wrap_blank_frame(texture: &ID3D11Texture2D, time: i64) -> Result<IMFSample, String> {
    let (_buffer, sample) = wrap_video_sample_from_surface(texture, 0)?;
    unsafe {
        sample
            .SetSampleTime(time)
            .map_err(|err| format!("SetSampleTime hr={:#x}", err.code().0 as u32))?;
        sample
            .SetSampleDuration(PROBE_DURATION_HNS)
            .map_err(|err| format!("SetSampleDuration hr={:#x}", err.code().0 as u32))?;
    }
    Ok(sample)
}

struct EncodedNalu {
    sample: IMFSample,
    size: u32,
    time: Option<i64>,
    duration: Option<i64>,
    /// True while the sample still belongs to the HMFT's own output allocator.
    hmft_owned: bool,
}

fn process_one_output(transform: &IMFTransform) -> Result<u32, String> {
    Ok(take_encoded_output(transform, true)?.size)
}

/// Copies the compressed H.264 payload into a Replayr-owned sample so the HMFT can
/// recycle its own output allocation immediately. Compressed bytes only; raw video
/// surfaces are never mapped.
fn own_encoded_sample(src: &IMFSample) -> Result<IMFSample, String> {
    unsafe {
        let src_buffer = src.ConvertToContiguousBuffer().map_err(|err| {
            format!(
                "ConvertToContiguousBuffer hr={:#x} {err}",
                err.code().0 as u32
            )
        })?;
        let mut src_ptr = std::ptr::null_mut();
        let mut src_len = 0_u32;
        src_buffer
            .Lock(&mut src_ptr, None, Some(&mut src_len))
            .map_err(|err| format!("encoded Lock hr={:#x} {err}", err.code().0 as u32))?;
        let copy = (|| -> Result<IMFMediaBuffer, String> {
            let dest_buffer = MFCreateMemoryBuffer(src_len.max(1))
                .map_err(|err| format!("MFCreateMemoryBuffer hr={:#x}", err.code().0 as u32))?;
            let mut dest_ptr = std::ptr::null_mut();
            dest_buffer
                .Lock(&mut dest_ptr, None, None)
                .map_err(|err| format!("owned Lock hr={:#x}", err.code().0 as u32))?;
            std::ptr::copy_nonoverlapping(src_ptr, dest_ptr, src_len as usize);
            let _ = dest_buffer.Unlock();
            dest_buffer
                .SetCurrentLength(src_len)
                .map_err(|err| format!("SetCurrentLength hr={:#x}", err.code().0 as u32))?;
            Ok(dest_buffer)
        })();
        let _ = src_buffer.Unlock();
        let dest_buffer = copy?;
        let dest = MFCreateSample()
            .map_err(|err| format!("MFCreateSample hr={:#x}", err.code().0 as u32))?;
        dest.AddBuffer(&dest_buffer)
            .map_err(|err| format!("owned AddBuffer hr={:#x}", err.code().0 as u32))?;
        // Carries CleanPoint, Discontinuity and every other encoder attribute across.
        src.CopyAllItems(&dest)
            .map_err(|err| format!("CopyAllItems hr={:#x}", err.code().0 as u32))?;
        if let Ok(time) = src.GetSampleTime() {
            let _ = dest.SetSampleTime(time);
        }
        if let Ok(duration) = src.GetSampleDuration() {
            let _ = dest.SetSampleDuration(duration);
        }
        if let Ok(flags) = src.GetSampleFlags() {
            let _ = dest.SetSampleFlags(flags);
        }
        Ok(dest)
    }
}

fn take_encoded_output(transform: &IMFTransform, log: bool) -> Result<EncodedNalu, String> {
    unsafe {
        let info = transform
            .GetOutputStreamInfo(0)
            .map_err(|err| format!("GetOutputStreamInfo hr={:#x}", err.code().0 as u32))?;
        let provides = info.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32 != 0;
        let sample = if provides {
            None
        } else {
            let sample = MFCreateSample().map_err(|err| err.to_string())?;
            if info.cbSize > 0 {
                let buffer = MFCreateMemoryBuffer(info.cbSize).map_err(|err| err.to_string())?;
                sample.AddBuffer(&buffer).map_err(|err| err.to_string())?;
            }
            Some(sample)
        };
        let mut buffers = [MFT_OUTPUT_DATA_BUFFER {
            dwStreamID: 0,
            pSample: ManuallyDrop::new(sample),
            dwStatus: 0,
            pEvents: ManuallyDrop::new(None),
        }];
        let mut status = 0u32;
        let result = transform.ProcessOutput(0, &mut buffers, &mut status);
        let out = ManuallyDrop::take(&mut buffers[0].pSample);
        let _ = ManuallyDrop::take(&mut buffers[0].pEvents);
        match result {
            Ok(()) => {
                let hmft_sample =
                    out.ok_or_else(|| "ProcessOutput returned no sample".to_string())?;
                // Release the HMFT's own output allocation before returning, otherwise the
                // MP4 sink retains it for the whole clip and the encoder runs dry.
                let encoded = if provides {
                    let owned = own_encoded_sample(&hmft_sample)?;
                    drop(hmft_sample);
                    owned
                } else {
                    hmft_sample
                };
                let size = encoded.GetTotalLength().unwrap_or(0);
                let time = encoded.GetSampleTime().ok();
                let duration = encoded.GetSampleDuration().ok();
                let flags = encoded.GetSampleFlags().ok();
                if log {
                    tracing::info!(
                        process_output_hr = "0x0",
                        sample_size = size,
                        timestamp = time,
                        duration,
                        flags,
                        stream_status = status,
                        "direct encode ProcessOutput sample"
                    );
                }
                Ok(EncodedNalu {
                    sample: encoded,
                    size,
                    time,
                    duration,
                    hmft_owned: false,
                })
            }
            Err(err) => Err(format!(
                "ProcessOutput hr={:#x} {err}",
                err.code().0 as u32
            )),
        }
    }
}

fn d3d11_aware(transform: &IMFTransform) -> Option<bool> {
    unsafe {
        let attrs = transform.GetAttributes().ok()?;
        match attrs.GetUINT32(&MF_SA_D3D11_AWARE) {
            Ok(value) => Some(value != 0),
            Err(_) => None,
        }
    }
}

struct AsyncMftProbe {
    need_input: bool,
    have_output: bool,
    process_hr: Option<String>,
    events: Vec<String>,
}

fn probe_async_mft_process_input(
    gpu: &SharedGpu,
    selected_encoder: &str,
    sample: &IMFSample,
    bound_aware: Option<bool>,
) -> AsyncMftProbe {
    let Some(transform) = activate_named_h264_encoder(selected_encoder) else {
        tracing::warn!(
            selected = selected_encoder,
            "could not activate a fresh copy of the selected encoder"
        );
        return AsyncMftProbe {
            need_input: false,
            have_output: false,
            process_hr: None,
            events: vec!["activate_failed".into()],
        };
    };
    let fresh_aware = d3d11_aware(&transform);
    tracing::info!(
        selected = selected_encoder,
        bound_mf_sa_d3d11_aware = bound_aware,
        fresh_mf_sa_d3d11_aware = fresh_aware,
        "fresh encoder MFT D3D11 awareness"
    );

    unsafe {
        if let Ok(attrs) = transform.GetAttributes() {
            if attrs.GetUINT32(&MF_TRANSFORM_ASYNC).unwrap_or(0) != 0 {
                if let Err(err) = attrs.SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1) {
                    tracing::warn!(
                        hr = format!("{:#x}", err.code().0 as u32),
                        %err,
                        "MF_TRANSFORM_ASYNC_UNLOCK failed"
                    );
                } else {
                    tracing::info!("MF_TRANSFORM_ASYNC_UNLOCK set");
                }
            }
        }
        if fresh_aware == Some(true) || bound_aware == Some(true) {
            if let Err(err) = transform.ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, raw_ptr(&gpu.manager))
            {
                tracing::error!(
                    set_d3d_manager_hr = format!("{:#x}", err.code().0 as u32),
                    %err,
                    "MFT_MESSAGE_SET_D3D_MANAGER failed"
                );
                return AsyncMftProbe {
                    need_input: false,
                    have_output: false,
                    process_hr: Some(format!("{:#x}", err.code().0 as u32)),
                    events: vec!["set_d3d_manager_failed".into()],
                };
            }
            tracing::info!(
                set_d3d_manager_hr = "0x0",
                manager = format!("{:#x}", raw_ptr(&gpu.manager)),
                "MFT_MESSAGE_SET_D3D_MANAGER sent to fresh encoder"
            );
        }

        let Ok(output_type) = h264_output_type(60, gpu_encoder_bitrate(ComposeQuality::Cloud, 60))
        else {
            return AsyncMftProbe {
                need_input: false,
                have_output: false,
                process_hr: None,
                events: vec!["output_type_failed".into()],
            };
        };
        let Ok(input_type) = nv12_input_type(60) else {
            return AsyncMftProbe {
                need_input: false,
                have_output: false,
                process_hr: None,
                events: vec!["input_type_failed".into()],
            };
        };
        if let Err(err) = transform.SetOutputType(0, &output_type, 0) {
            tracing::error!(
                hr = format!("{:#x}", err.code().0 as u32),
                %err,
                "fresh encoder SetOutputType(H264 1920x1080) failed"
            );
            return AsyncMftProbe {
                need_input: false,
                have_output: false,
                process_hr: Some(format!("{:#x}", err.code().0 as u32)),
                events: vec!["set_output_type_failed".into()],
            };
        }
        if let Err(err) = transform.SetInputType(0, &input_type, 0) {
            tracing::error!(
                hr = format!("{:#x}", err.code().0 as u32),
                %err,
                "fresh encoder SetInputType(NV12 1920x1080) failed"
            );
            return AsyncMftProbe {
                need_input: false,
                have_output: false,
                process_hr: Some(format!("{:#x}", err.code().0 as u32)),
                events: vec!["set_input_type_failed".into()],
            };
        }

        for (name, message) in [
            ("NOTIFY_BEGIN_STREAMING", MFT_MESSAGE_NOTIFY_BEGIN_STREAMING),
            ("NOTIFY_START_OF_STREAM", MFT_MESSAGE_NOTIFY_START_OF_STREAM),
        ] {
            match transform.ProcessMessage(message, 0) {
                Ok(()) => tracing::info!(message = name, hr = "0x0", "async encoder lifecycle message"),
                Err(err) => tracing::warn!(
                    message = name,
                    hr = format!("{:#x}", err.code().0 as u32),
                    %err,
                    "async encoder lifecycle message failed"
                ),
            }
        }

        let Ok(events) = transform.cast::<IMFMediaEventGenerator>() else {
            tracing::error!("selected encoder is not an IMFMediaEventGenerator");
            return AsyncMftProbe {
                need_input: false,
                have_output: false,
                process_hr: None,
                events: vec!["no_event_generator".into()],
            };
        };

        drain_async_encoder(&transform, &events, sample)
    }
}

fn drain_async_encoder(
    transform: &IMFTransform,
    events: &IMFMediaEventGenerator,
    sample: &IMFSample,
) -> AsyncMftProbe {
    let mut probe = AsyncMftProbe {
        need_input: false,
        have_output: false,
        process_hr: None,
        events: Vec::new(),
    };
    let deadline = Instant::now() + ASYNC_EVENT_TIMEOUT;
    let mut order = 0u32;
    while Instant::now() < deadline {
        match unsafe { events.GetEvent(MF_EVENT_FLAG_NO_WAIT) } {
            Ok(event) => {
                let ty = unsafe { event.GetType().unwrap_or(0) };
                let status = unsafe { event.GetStatus().ok() };
                let status_hr = status
                    .map(|hr| format!("{:#x}", hr.0 as u32))
                    .unwrap_or_else(|| "n/a".into());
                let ext = unsafe { event.GetExtendedType().ok() }
                    .filter(|guid| *guid != GUID::zeroed())
                    .map(|guid| format!("{guid:?}"));
                let name = event_name(ty);
                order += 1;
                let line = format!("#{order} {name} type={ty} status={status_hr}");
                tracing::info!(
                    order,
                    event = name,
                    event_type = ty,
                    status_hr,
                    extended = ext.as_deref(),
                    "async encoder event"
                );
                probe.events.push(line);
                if status.is_some_and(|hr| hr.is_err()) || ty == MEError.0 as u32 {
                    tracing::error!(order, event = name, status_hr, "async encoder error event");
                    break;
                }
                if ty == METransformNeedInput.0 as u32 && probe.process_hr.is_none() {
                    probe.need_input = true;
                    probe.process_hr = Some(process_input_hr(transform, sample, "after_need_input"));
                    if probe.process_hr.as_deref() != Some("0x0") {
                        break;
                    }
                }
                if ty == METransformHaveOutput.0 as u32 {
                    probe.have_output = true;
                    break;
                }
            }
            Err(_) => {
                if probe.process_hr.is_some() && Instant::now() + Duration::from_millis(200) >= deadline
                {
                    break;
                }
                thread::sleep(Duration::from_millis(40));
            }
        }
    }
    if !probe.need_input {
        tracing::error!(
            events = ?probe.events,
            "METransformNeedInput did not arrive before the diagnostic timeout"
        );
    }
    probe
}

fn event_name(ty: u32) -> &'static str {
    if ty == METransformNeedInput.0 as u32 {
        "METransformNeedInput"
    } else if ty == METransformHaveOutput.0 as u32 {
        "METransformHaveOutput"
    } else if ty == METransformDrainComplete.0 as u32 {
        "METransformDrainComplete"
    } else if ty == MEError.0 as u32 {
        "MEError"
    } else {
        "other"
    }
}

fn process_input_hr(transform: &IMFTransform, sample: &IMFSample, which: &str) -> String {
    unsafe {
        match transform.ProcessInput(0, sample, 0) {
            Ok(()) => {
                if which != "compose" && which != "blank_long" {
                    tracing::info!(
                        which,
                        process_input_hr = "0x0",
                        "IMFTransform::ProcessInput succeeded"
                    );
                }
                "0x0".into()
            }
            Err(err) => {
                let hr = format!("{:#x}", err.code().0 as u32);
                tracing::error!(
                    which,
                    process_input_hr = %hr,
                    %err,
                    "IMFTransform::ProcessInput failed"
                );
                hr
            }
        }
    }
}

fn activate_named_h264_encoder(selected: &str) -> Option<IMFTransform> {
    let output = MFT_REGISTER_TYPE_INFO {
        guidMajorType: MFMediaType_Video,
        guidSubtype: MFVideoFormat_H264,
    };
    let mut raw: *mut Option<IMFActivate> = std::ptr::null_mut();
    let mut count = 0u32;
    let result = unsafe {
        MFTEnumEx(
            MFT_CATEGORY_VIDEO_ENCODER,
            MFT_ENUM_FLAG_ALL,
            None,
            Some(&output),
            &mut raw,
            &mut count,
        )
    };
    if result.is_err() || raw.is_null() || count == 0 {
        if !raw.is_null() {
            unsafe { CoTaskMemFree(Some(raw as *const std::ffi::c_void)) };
        }
        return None;
    }
    let slice = unsafe { std::slice::from_raw_parts(raw, count as usize) };
    let mut names = Vec::new();
    let mut chosen = None;
    for item in slice {
        let Some(activate) = item else {
            continue;
        };
        let name = unsafe {
            let mut pwstr = windows::core::PWSTR::null();
            let mut len = 0u32;
            if activate
                .GetAllocatedString(&MFT_FRIENDLY_NAME_Attribute, &mut pwstr, &mut len)
                .is_ok()
                && !pwstr.is_null()
            {
                let value = pwstr.to_string().unwrap_or_default();
                CoTaskMemFree(Some(pwstr.0 as *const std::ffi::c_void));
                value
            } else {
                String::new()
            }
        };
        if !name.is_empty() {
            names.push(name.clone());
        }
        if chosen.is_none() && (name.eq_ignore_ascii_case(selected) || selected.contains(&name) || name.contains(selected))
        {
            chosen = Some(activate.clone());
        }
    }
    tracing::info!(
        all_enum_flag = MFT_ENUM_FLAG_ALL.0,
        candidates = ?names,
        selected,
        matched = chosen.is_some(),
        "H.264 MFTEnumEx(ALL) candidates for direct ProcessInput"
    );
    let transform = chosen.and_then(|activate| unsafe { activate.ActivateObject::<IMFTransform>().ok() });
    unsafe { CoTaskMemFree(Some(raw as *const std::ffi::c_void)) };
    transform
}

/// The direct encoder always emits [`GPU_ENCODER_W`]x[`GPU_ENCODER_H`], so the
/// tier resolves against that rather than the source frame size.
fn gpu_encoder_bitrate(quality: ComposeQuality, fps: u32) -> u32 {
    quality.bitrate_for(GPU_ENCODER_W, GPU_ENCODER_H, fps)
}

fn h264_output_type(
    fps: u32,
    bitrate: u32,
) -> Result<windows::Win32::Media::MediaFoundation::IMFMediaType, String> {
    let fps = fps.max(1) as u64;
    unsafe {
        let media = MFCreateMediaType().map_err(|err| err.to_string())?;
        media
            .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
            .map_err(|err| err.to_string())?;
        media
            .SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264)
            .map_err(|err| err.to_string())?;
        media
            .SetUINT64(
                &MF_MT_FRAME_SIZE,
                (u64::from(GPU_ENCODER_W) << 32) | u64::from(GPU_ENCODER_H),
            )
            .map_err(|err| err.to_string())?;
        media
            .SetUINT64(&MF_MT_FRAME_RATE, (fps << 32) | 1)
            .map_err(|err| err.to_string())?;
        media
            .SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)
            .map_err(|err| err.to_string())?;
        media
            .SetUINT32(&MF_MT_AVG_BITRATE, bitrate)
            .map_err(|err| err.to_string())?;
        Ok(media)
    }
}

fn nv12_input_type(
    fps: u32,
) -> Result<windows::Win32::Media::MediaFoundation::IMFMediaType, String> {
    let fps = fps.max(1) as u64;
    unsafe {
        let media = MFCreateMediaType().map_err(|err| err.to_string())?;
        media
            .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
            .map_err(|err| err.to_string())?;
        media
            .SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12)
            .map_err(|err| err.to_string())?;
        media
            .SetUINT64(
                &MF_MT_FRAME_SIZE,
                (u64::from(GPU_ENCODER_W) << 32) | u64::from(GPU_ENCODER_H),
            )
            .map_err(|err| err.to_string())?;
        media
            .SetUINT64(&MF_MT_FRAME_RATE, (fps << 32) | 1)
            .map_err(|err| err.to_string())?;
        media
            .SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)
            .map_err(|err| err.to_string())?;
        media
            .SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, (1u64 << 32) | 1)
            .map_err(|err| err.to_string())?;
        Ok(media)
    }
}

fn stop_boundary(boundary: &str, detail: &str) -> String {
    tracing::error!(
        gpu_dxgi_first_failing_boundary = boundary,
        detail,
        "gpu_dxgi first failing boundary isolated; GPU compose stopping"
    );
    format!("gpu_dxgi_first_failing_boundary={boundary} {detail}")
}

fn log_nvidia_selection(inventory: &[crate::camera::encoder::EncoderInfo], selected: &str) {
    let hardware: Vec<&str> = inventory
        .iter()
        .filter(|item| item.hardware)
        .map(|item| item.name.as_str())
        .collect();
    let software: Vec<&str> = inventory
        .iter()
        .filter(|item| !item.hardware)
        .map(|item| item.name.as_str())
        .collect();
    tracing::info!(
        hardware = ?hardware,
        software = ?software,
        selected,
        "H.264 encoder MFT candidates and selected transform"
    );
    let nvidia: Vec<&str> = inventory
        .iter()
        .filter(|item| {
            let name = item.name.to_ascii_lowercase();
            name.contains("nvidia") || name.contains("nvenc")
        })
        .map(|item| item.name.as_str())
        .collect();
    let selected_nvidia = {
        let name = selected.to_ascii_lowercase();
        name.contains("nvidia") || name.contains("nvenc")
    };
    if nvidia.is_empty() {
        tracing::info!(
            selected,
            "NVIDIA H.264 MFT was not selected because it was not enumerated"
        );
    } else if selected_nvidia {
        tracing::info!(selected, nvidia = ?nvidia, "NVIDIA H.264 MFT was selected");
    } else {
        tracing::info!(
            selected,
            nvidia = ?nvidia,
            "NVIDIA MFT was enumerated but SinkWriter bound a different transform; MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS does not pin a vendor"
        );
    }
}

fn log_shared_device(gpu: &SharedGpu) {
    let device_ptr = raw_ptr(&gpu.device);
    let manager_ptr = manager_device_ptr(&gpu.manager);
    let luid = adapter_luid(&gpu.device);
    tracing::info!(
        adapter = %gpu.adapter,
        adapter_luid = %luid,
        shared_device = format!("{device_ptr:#x}"),
        manager_device = manager_ptr.map(|ptr| format!("{ptr:#x}")).unwrap_or_else(|| "unavailable".into()),
        same_device = manager_ptr == Some(device_ptr),
        "shared D3D device identity"
    );
}

fn create_blank_nv12(
    device: &ID3D11Device,
    width: u32,
    height: u32,
    bind_flags: u32,
) -> Result<ID3D11Texture2D, String> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: width,
        Height: height,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_NV12,
        SampleDesc: DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: bind_flags,
        CPUAccessFlags: 0,
        MiscFlags: 0,
    };
    let mut texture = None;
    unsafe {
        device
            .CreateTexture2D(&desc, None, Some(&mut texture))
            .map_err(|err| {
                format!("Could not create blank {width}x{height} NV12 texture: {err}")
            })?;
    }
    texture.ok_or_else(|| format!("Blank {width}x{height} NV12 texture was empty."))
}

struct ProbeWrite {
    ok: bool,
    wrap_hr: String,
    write_hr: String,
}

fn probe_write_dxgi(
    label: &str,
    writer: &mut MfWriter,
    texture: &ID3D11Texture2D,
    subresource: u32,
    duration_hns: i64,
    force_keyframe: bool,
    gpu: &SharedGpu,
    dest_w: u32,
    dest_h: u32,
) -> ProbeWrite {
    match writer.wrap_dxgi_nv12_sample(texture, subresource, duration_hns, force_keyframe) {
        Ok((buffer, sample)) => {
            tracing::info!(
                label,
                wrap_hr = "0x0",
                sample_path = "MFCreateSample",
                "DXGI surface wrap succeeded"
            );
            dump_wrapped_sample(
                label,
                &buffer,
                &sample,
                texture,
                subresource,
                gpu,
                dest_w,
                dest_h,
            );
            match writer.write_video_sample(&sample, duration_hns) {
                Ok(()) => {
                    tracing::info!(label, write_hr = "0x0", "SinkWriter WriteSample succeeded");
                    ProbeWrite {
                        ok: true,
                        wrap_hr: "0x0".into(),
                        write_hr: "0x0".into(),
                    }
                }
                Err(err) => {
                    let write_hr = hr_from_detail(&err);
                    tracing::error!(label, %err, write_hr, "SinkWriter WriteSample failed");
                    ProbeWrite {
                        ok: false,
                        wrap_hr: "0x0".into(),
                        write_hr,
                    }
                }
            }
        }
        Err(err) => {
            let wrap_hr = hr_from_detail(&err);
            tracing::error!(label, %err, wrap_hr, "DXGI surface wrap failed");
            ProbeWrite {
                ok: false,
                wrap_hr,
                write_hr: "n/a".into(),
            }
        }
    }
}

fn probe_write_video_sample(
    writer: &mut MfWriter,
    texture: &ID3D11Texture2D,
    gpu: &SharedGpu,
) -> ProbeWrite {
    match wrap_video_sample_from_surface(texture, 0) {
        Ok((buffer, sample)) => {
            tracing::info!(
                probe = 2,
                wrap_hr = "0x0",
                sample_path = "MFCreateVideoSampleFromSurface",
                "DXGI video sample wrap succeeded"
            );
            dump_wrapped_sample(
                "probe2_video_sample",
                &buffer,
                &sample,
                texture,
                0,
                gpu,
                GPU_ENCODER_W,
                GPU_ENCODER_H,
            );
            match writer.write_video_sample(&sample, PROBE_DURATION_HNS) {
                Ok(()) => {
                    tracing::info!(
                        probe = 2,
                        write_hr = "0x0",
                        "SinkWriter WriteSample succeeded"
                    );
                    ProbeWrite {
                        ok: true,
                        wrap_hr: "0x0".into(),
                        write_hr: "0x0".into(),
                    }
                }
                Err(err) => {
                    let write_hr = hr_from_detail(&err);
                    tracing::error!(probe = 2, %err, write_hr, "SinkWriter WriteSample failed");
                    ProbeWrite {
                        ok: false,
                        wrap_hr: "0x0".into(),
                        write_hr,
                    }
                }
            }
        }
        Err(err) => {
            let wrap_hr = hr_from_detail(&err);
            tracing::error!(probe = 2, %err, wrap_hr, "MFCreateVideoSampleFromSurface wrap failed");
            ProbeWrite {
                ok: false,
                wrap_hr,
                write_hr: "n/a".into(),
            }
        }
    }
}

fn wrap_video_sample_from_surface(
    texture: &ID3D11Texture2D,
    subresource: u32,
) -> Result<(IMFMediaBuffer, IMFSample), String> {
    unsafe {
        let media_buffer = MFCreateDXGISurfaceBuffer(
            &ID3D11Texture2D::IID,
            texture,
            subresource,
            false,
        )
        .map_err(|err| {
            format!(
                "wrap_hr={:#x} MFCreateDXGISurfaceBuffer failed: {err}",
                err.code().0 as u32
            )
        })?;
        let sample = MFCreateVideoSampleFromSurface(None).map_err(|err| {
            format!(
                "wrap_hr={:#x} MFCreateVideoSampleFromSurface failed: {err}",
                err.code().0 as u32
            )
        })?;
        sample.AddBuffer(&media_buffer).map_err(|err| {
            format!(
                "wrap_hr={:#x} IMFSample::AddBuffer failed: {err}",
                err.code().0 as u32
            )
        })?;
        sample
            .SetSampleTime(0)
            .map_err(|err| format!("wrap_hr={:#x} SetSampleTime failed: {err}", err.code().0 as u32))?;
        sample.SetSampleDuration(PROBE_DURATION_HNS).map_err(|err| {
            format!(
                "wrap_hr={:#x} SetSampleDuration failed: {err}",
                err.code().0 as u32
            )
        })?;
        let _ = sample.SetUINT32(&MFSampleExtension_CleanPoint, 1);
        Ok((media_buffer, sample))
    }
}

fn hr_from_detail(detail: &str) -> String {
    detail
        .split_whitespace()
        .find(|part| part.starts_with("wrap_hr=") || part.starts_with("write_hr="))
        .map(|part| part.split('=').nth(1).unwrap_or(part).to_string())
        .unwrap_or_else(|| detail.to_string())
}

fn dump_texture(
    label: &str,
    texture: &ID3D11Texture2D,
    gpu: &SharedGpu,
    subresource: u32,
    dest_w: u32,
    dest_h: u32,
) {
    let mut desc = D3D11_TEXTURE2D_DESC::default();
    unsafe { texture.GetDesc(&mut desc) };
    let tex_device = texture_device(texture);
    let tex_device_ptr = tex_device.as_ref().map(raw_ptr);
    let shared_ptr = raw_ptr(&gpu.device);
    let format_nv12 = desc.Format == DXGI_FORMAT_NV12;
    let same_device = tex_device_ptr == Some(shared_ptr);
    let same_dims = desc.Width == dest_w && desc.Height == dest_h;
    let encoder_bind = desc.BindFlags == 0 && desc.Usage == D3D11_USAGE_DEFAULT;
    let vp_bind =
        desc.BindFlags == (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32;
    tracing::info!(
        label,
        format = format_name(desc.Format),
        format_nv12,
        width = desc.Width,
        height = desc.Height,
        dest = format!("{dest_w}x{dest_h}"),
        same_dimensions = same_dims,
        mips = desc.MipLevels,
        array = desc.ArraySize,
        usage = desc.Usage.0,
        bind_flags = format!("{:#x}", desc.BindFlags),
        cpu_access = desc.CPUAccessFlags,
        misc_flags = desc.MiscFlags,
        sample_count = desc.SampleDesc.Count,
        subresource,
        subresource_ok = subresource == 0,
        texture = format!("{:#x}", raw_ptr(texture)),
        texture_device = tex_device_ptr.map(|ptr| format!("{ptr:#x}")).unwrap_or_else(|| "unavailable".into()),
        shared_device = format!("{shared_ptr:#x}"),
        same_device,
        encoder_typical_bind = encoder_bind,
        vp_output_bind = vp_bind,
        assert_format_nv12 = format_nv12,
        assert_dims_match_encoder = same_dims,
        assert_same_d3d_device = same_device,
        assert_no_cpu_map = desc.CPUAccessFlags == 0,
        adapter = %gpu.adapter,
        adapter_luid = %adapter_luid(&gpu.device),
        "DXGI texture dump"
    );
}

fn dump_wrapped_sample(
    label: &str,
    buffer: &IMFMediaBuffer,
    sample: &IMFSample,
    texture: &ID3D11Texture2D,
    expected_subresource: u32,
    gpu: &SharedGpu,
    dest_w: u32,
    dest_h: u32,
) {
    let time = unsafe { sample.GetSampleTime().ok() };
    let duration = unsafe { sample.GetSampleDuration().ok() };
    let buffer_count = unsafe { sample.GetBufferCount().ok() };
    let keyframe = unsafe { sample.GetUINT32(&MFSampleExtension_CleanPoint).unwrap_or(0) } != 0;
    let time_ok = time.is_some_and(|value| value >= 0);
    let duration_ok = duration.is_some_and(|value| value > 0);
    let dxgi = buffer.cast::<IMFDXGIBuffer>();
    let (wrapped_tex, wrapped_sub, wrap_ok) = match &dxgi {
        Ok(dxgi) => match dxgi_texture(dxgi) {
            Ok(wrapped) => {
                let sub = unsafe { dxgi.GetSubresourceIndex().unwrap_or(u32::MAX) };
                let same_tex = raw_ptr(&wrapped) == raw_ptr(texture);
                tracing::info!(
                    label,
                    wrapped_texture = format!("{:#x}", raw_ptr(&wrapped)),
                    source_texture = format!("{:#x}", raw_ptr(texture)),
                    same_texture = same_tex,
                    wrapped_subresource = sub,
                    expected_subresource,
                    subresource_ok = sub == expected_subresource,
                    "IMFDXGIBuffer wrap"
                );
                dump_texture(
                    &format!("{label}_wrapped"),
                    &wrapped,
                    gpu,
                    sub,
                    dest_w,
                    dest_h,
                );
                (
                    Some(raw_ptr(&wrapped)),
                    Some(sub),
                    same_tex && sub == expected_subresource,
                )
            }
            Err(err) => {
                tracing::warn!(label, %err, "IMFDXGIBuffer GetResource failed");
                (None, None, false)
            }
        },
        Err(err) => {
            tracing::warn!(
                label,
                hr = format!("{:#x}", err.code().0 as u32),
                %err,
                "wrapped buffer is not IMFDXGIBuffer"
            );
            (None, None, false)
        }
    };
    tracing::info!(
        label,
        sample_time = time,
        sample_duration = duration,
        buffer_count,
        keyframe,
        assert_time_non_negative = time_ok,
        assert_duration_positive = duration_ok,
        assert_imfdxgi_buffer = dxgi.is_ok(),
        assert_no_cpu_map = true,
        wrapped_ok = wrap_ok,
        wrapped_texture = wrapped_tex.map(|ptr| format!("{ptr:#x}")),
        wrapped_subresource = wrapped_sub,
        "DXGI sample timestamp and duration"
    );
}

fn texture_device(texture: &ID3D11Texture2D) -> Option<ID3D11Device> {
    unsafe { texture.GetDevice().ok() }
}

fn manager_device_ptr(manager: &IMFDXGIDeviceManager) -> Option<usize> {
    unsafe {
        let handle = manager.OpenDeviceHandle().ok()?;
        let mut raw = std::ptr::null_mut();
        let locked = manager
            .LockDevice(handle, &ID3D11Device::IID, &mut raw, false)
            .ok();
        let ptr = if locked.is_some() && !raw.is_null() {
            let device = ID3D11Device::from_raw(raw as *mut _);
            let ptr = raw_ptr(&device);
            Some(ptr)
        } else {
            None
        };
        let _ = manager.UnlockDevice(handle, false);
        let _ = manager.CloseDeviceHandle(handle);
        ptr
    }
}

fn adapter_luid(device: &ID3D11Device) -> String {
    unsafe {
        let Ok(dxgi) = device.cast::<IDXGIDevice>() else {
            return "unknown".into();
        };
        let Ok(adapter) = dxgi.GetAdapter() else {
            return "unknown".into();
        };
        let Ok(desc) = adapter.GetDesc() else {
            return "unknown".into();
        };
        format!(
            "{:08x}:{:08x}",
            desc.AdapterLuid.HighPart as u32, desc.AdapterLuid.LowPart
        )
    }
}

fn vram_usage(device: &ID3D11Device) -> Option<(u64, u64, u64)> {
    unsafe {
        let dxgi = device.cast::<IDXGIDevice>().ok()?;
        let adapter = dxgi.GetAdapter().ok()?;
        let adapter3 = adapter.cast::<IDXGIAdapter3>().ok()?;
        let mut info = DXGI_QUERY_VIDEO_MEMORY_INFO::default();
        adapter3
            .QueryVideoMemoryInfo(0, DXGI_MEMORY_SEGMENT_GROUP_LOCAL, &mut info)
            .ok()?;
        Some((info.CurrentUsage, info.Budget, info.CurrentReservation))
    }
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

fn env_flag(name: &str) -> bool {
    std::env::var(name).is_ok_and(|value| value.trim() == "1")
}

fn surface_probe_mode() -> Option<char> {
    match std::env::var("REPLAYR_GPU_SURFACE_PROBE")
        .ok()
        .as_deref()
        .map(str::trim)
    {
        Some("A") | Some("a") => Some('A'),
        Some("B") | Some("b") => Some('B'),
        Some("C") | Some("c") => Some('C'),
        _ => None,
    }
}

fn log_surface_transition(
    frame: u64,
    hop: &str,
    texture: Option<&ID3D11Texture2D>,
    subresource: u32,
    ring_slot: i64,
    decoder_slice: u32,
    hr: &str,
) -> SurfaceHop {
    let mut desc = D3D11_TEXTURE2D_DESC::default();
    let (ptr, format, width, height, bind, array, mips, device) = if let Some(tex) = texture {
        unsafe { tex.GetDesc(&mut desc) };
        let device = texture_device(tex)
            .as_ref()
            .map(|dev| format!("{:#x}", raw_ptr(dev)))
            .unwrap_or_else(|| "unavailable".into());
        (
            format!("{:#x}", raw_ptr(tex)),
            format_name(desc.Format),
            desc.Width,
            desc.Height,
            format!("{:#x}", desc.BindFlags),
            desc.ArraySize,
            desc.MipLevels,
            device,
        )
    } else {
        (
            "none".into(),
            "n/a".into(),
            0,
            0,
            "n/a".into(),
            0,
            0,
            "n/a".into(),
        )
    };
    tracing::info!(
        frame_index = frame,
        hop,
        texture_ptr = %ptr,
        subresource,
        dxgi_format = %format,
        width,
        height,
        bind_flags = %bind,
        array_size = array,
        mip_levels = mips,
        device_ptr = %device,
        ring_slot,
        decoder_slice,
        hr,
        "surface transition"
    );
    SurfaceHop {
        hop: hop.into(),
        texture: ptr,
        subresource,
        format,
        width,
        height,
        bind_flags: bind,
        array_size: array,
        mip_levels: mips,
        device,
        ring_slot,
        decoder_slice,
        hr: hr.into(),
    }
}

fn compare_surface_hops(prev_frame: u64, prev: &[SurfaceHop], curr_frame: u64, curr: &[SurfaceHop]) {
    let mut first_diff: Option<String> = None;
    for hop in curr {
        let Some(was) = prev.iter().find(|p| p.hop == hop.hop) else {
            tracing::info!(
                hop = %hop.hop,
                curr_frame,
                "surface hop missing on known-good frame"
            );
            if first_diff.is_none() {
                first_diff = Some(format!("{} (missing on frame {prev_frame})", hop.hop));
            }
            continue;
        };
        let mut diffs = Vec::new();
        if hop.subresource != was.subresource {
            diffs.push(format!(
                "subresource {} -> {}",
                was.subresource, hop.subresource
            ));
        }
        if hop.format != was.format {
            diffs.push(format!("format {} -> {}", was.format, hop.format));
        }
        if hop.width != was.width || hop.height != was.height {
            diffs.push(format!(
                "size {}x{} -> {}x{}",
                was.width, was.height, hop.width, hop.height
            ));
        }
        if hop.bind_flags != was.bind_flags {
            diffs.push(format!("bind {} -> {}", was.bind_flags, hop.bind_flags));
        }
        if hop.array_size != was.array_size {
            diffs.push(format!("array {} -> {}", was.array_size, hop.array_size));
        }
        if hop.mip_levels != was.mip_levels {
            diffs.push(format!("mips {} -> {}", was.mip_levels, hop.mip_levels));
        }
        if hop.device != was.device {
            diffs.push(format!("device {} -> {}", was.device, hop.device));
        }
        if hop.hr != was.hr {
            diffs.push(format!("hr {} -> {}", was.hr, hop.hr));
        }
        let ptr_changed = hop.texture != was.texture;
        let slot_changed = hop.ring_slot != was.ring_slot;
        let slice_changed = hop.decoder_slice != was.decoder_slice;
        if !diffs.is_empty() && first_diff.is_none() {
            first_diff = Some(format!("{} [{}]", hop.hop, diffs.join(", ")));
        }
        tracing::info!(
            hop = %hop.hop,
            prev_frame,
            curr_frame,
            texture_changed = ptr_changed,
            prev_texture = %was.texture,
            curr_texture = %hop.texture,
            ring_slot_changed = slot_changed,
            prev_ring_slot = was.ring_slot,
            curr_ring_slot = hop.ring_slot,
            decoder_slice_changed = slice_changed,
            prev_decoder_slice = was.decoder_slice,
            curr_decoder_slice = hop.decoder_slice,
            metadata_diffs = diffs.join("; "),
            "surface hop compare vs known-good"
        );
    }
    match first_diff {
        Some(diff) => tracing::warn!(
            first_differing_surface = %diff,
            prev_frame,
            curr_frame,
            "first surface that differs from known-good frame"
        ),
        None => tracing::info!(
            prev_frame,
            curr_frame,
            "no metadata difference vs known-good frame (texture/slot/slice rotation expected)"
        ),
    }
}

fn drain_d3d_debug(gpu: &SharedGpu, frame: u64, at: &str) {
    let Some(queue) = &gpu.info_queue else {
        return;
    };
    unsafe {
        if frame < BOUNDARY_LOG_FROM {
            queue.ClearStoredMessages();
            return;
        }
        let count = queue.GetNumStoredMessages();
        if count == 0 {
            return;
        }
        for i in 0..count {
            let mut len = 0usize;
            let _ = queue.GetMessage(i, None, &mut len);
            if len == 0 {
                continue;
            }
            let mut buf = vec![0u8; len];
            let msg = buf.as_mut_ptr() as *mut D3D11_MESSAGE;
            if queue.GetMessage(i, Some(msg), &mut len).is_err() {
                continue;
            }
            let message = &*msg;
            let desc = if !message.pDescription.is_null() && message.DescriptionByteLength > 0 {
                let n = message.DescriptionByteLength.saturating_sub(1);
                std::string::String::from_utf8_lossy(std::slice::from_raw_parts(
                    message.pDescription,
                    n,
                ))
                .into_owned()
            } else {
                String::new()
            };
            tracing::warn!(
                frame_index = frame,
                at,
                severity = message.Severity.0,
                category = message.Category.0,
                id = message.ID.0,
                description = %desc,
                "D3D11 debug layer"
            );
        }
        queue.ClearStoredMessages();
    }
}

fn gpu_copy_nv12_box(
    gpu: &SharedGpu,
    src: &ID3D11Texture2D,
    src_subresource: u32,
    dst_w: u32,
    dst_h: u32,
    diag: &GpuFailDiag,
) -> Result<ID3D11Texture2D, String> {
    let bind = (D3D11_BIND_RENDER_TARGET.0
        | D3D11_BIND_SHADER_RESOURCE.0
        | D3D11_BIND_VIDEO_ENCODER.0) as u32;
    let dest = create_blank_nv12(&gpu.device, dst_w, dst_h, bind)?;
    let dst: ID3D11Resource = dest
        .cast()
        .map_err(|err| format!("probe dest cast hr={:#x}", err.code().0 as u32))?;
    let source: ID3D11Resource = src
        .cast()
        .map_err(|err| format!("probe src cast hr={:#x}", err.code().0 as u32))?;
    let region = D3D11_BOX {
        left: 0,
        top: 0,
        front: 0,
        right: dst_w,
        bottom: dst_h,
        back: 1,
    };
    unsafe {
        gpu.context
            .CopySubresourceRegion(&dst, 0, 0, 0, 0, &source, src_subresource, Some(&region));
    }
    let done = GpuEvent::create(&gpu.device)?;
    done.end(&gpu.context)?;
    unsafe { gpu.context.Flush() };
    done.wait(gpu, diag)?;
    Ok(dest)
}

fn gpu_copy_full_nv12(
    gpu: &SharedGpu,
    src: &ID3D11Texture2D,
    dst_w: u32,
    dst_h: u32,
    diag: &GpuFailDiag,
) -> Result<ID3D11Texture2D, String> {
    let bind = (D3D11_BIND_RENDER_TARGET.0
        | D3D11_BIND_SHADER_RESOURCE.0
        | D3D11_BIND_VIDEO_ENCODER.0) as u32;
    let dest = create_blank_nv12(&gpu.device, dst_w, dst_h, bind)?;
    let dst: ID3D11Resource = dest
        .cast()
        .map_err(|err| format!("probe dest cast hr={:#x}", err.code().0 as u32))?;
    let source: ID3D11Resource = src
        .cast()
        .map_err(|err| format!("probe src cast hr={:#x}", err.code().0 as u32))?;
    unsafe {
        gpu.context.CopyResource(&dst, &source);
    }
    let done = GpuEvent::create(&gpu.device)?;
    done.end(&gpu.context)?;
    unsafe { gpu.context.Flush() };
    done.wait(gpu, diag)?;
    Ok(dest)
}

fn raw_ptr<T: Interface>(value: &T) -> usize {
    value.as_raw() as usize
}

fn format_name(format: windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT) -> String {
    if format == DXGI_FORMAT_NV12 {
        "NV12".into()
    } else {
        format!("{:#x}", format.0)
    }
}
