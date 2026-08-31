use std::path::Path;
use std::thread;
use std::time::{Duration, Instant};

use windows::core::{Interface, GUID, PCWSTR};
use windows::Win32::Graphics::Direct3D11::{ID3D11Texture2D, D3D11_BIND_VIDEO_ENCODER};
use windows::Win32::Media::MediaFoundation::{
    IMFMediaEventGenerator, IMFSample, IMFTransform, MEError, METransformDrainComplete,
    METransformHaveOutput, METransformNeedInput, MFCreateSourceReaderFromURL,
    MFSampleExtension_CleanPoint, MFT_MESSAGE_COMMAND_DRAIN, MFT_MESSAGE_NOTIFY_BEGIN_STREAMING,
    MFT_MESSAGE_NOTIFY_END_OF_STREAM, MFT_MESSAGE_NOTIFY_END_STREAMING,
    MFT_MESSAGE_NOTIFY_START_OF_STREAM, MFT_MESSAGE_SET_D3D_MANAGER, MF_EVENT_FLAG_NO_WAIT,
    MF_PD_DURATION, MF_SOURCE_READER_FIRST_AUDIO_STREAM, MF_SOURCE_READER_FIRST_VIDEO_STREAM,
    MF_SOURCE_READER_MEDIASOURCE, MF_TRANSFORM_ASYNC, MF_TRANSFORM_ASYNC_UNLOCK,
};

use crate::encode::MfWriter;
use crate::export::mux::H264Mp4Mux;
use crate::export::types::{ComposeQuality, ComposeReport};

use super::BOUNDARY_LOG_FROM;
use super::decode::wide_path;
use super::device::{
    create_blank_nv12, device_removed_reason, log_shared_device, raw_ptr, SharedGpu,
};
use super::diagnostics::{
    dump_complete_media_type, dump_texture, dump_wrapped_sample, hr_from_detail, stop_boundary,
};
use super::encoder::{
    activate_named_h264_encoder, configure_direct_encoder, d3d11_aware, event_name,
    gpu_encoder_bitrate, h264_output_type, log_nvidia_selection, nv12_input_type,
    pick_direct_encoder_name, process_input_hr, send_lifecycle, take_encoded_output,
    wrap_blank_frame, wrap_composed_frame, wrap_video_sample_from_surface, ASYNC_EVENT_TIMEOUT,
    BOUNDARY_ENCODER, BOUNDARY_MISSING_MANAGER, BOUNDARY_NOT_D3D11, PROBE_DURATION_HNS,
};
use super::output::{encoder_frame_duration_hns, encoder_sample_time_hns, COMPOSE_DRAIN_TIMEOUT, COMPOSE_TIMEOUT};
use super::{ENCODER_FPS, GPU_ENCODER_H, GPU_ENCODER_W};

const DIRECT_LOOP_FRAMES: u32 = 90;
const DIRECT_LOOP_TIMEOUT: Duration = Duration::from_secs(15);
const DIRECT_DRAIN_TIMEOUT: Duration = Duration::from_secs(5);

#[allow(dead_code)]
const BLANK_LONG_FRAMES: u64 = 12_000;

#[allow(unused_assignments)]
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

#[allow(dead_code)]
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

struct AsyncMftProbe {
    need_input: bool,
    have_output: bool,
    process_hr: Option<String>,
    events: Vec<String>,
}

#[allow(dead_code)]
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

#[allow(dead_code)]
struct ProbeWrite {
    ok: bool,
    wrap_hr: String,
    write_hr: String,
}

#[allow(dead_code)]
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

#[allow(dead_code)]
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