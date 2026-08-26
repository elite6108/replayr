//! Live camera preview. Opens the device only while the settings card is
//! visible. Bounded: one converted RGB frame, one PNG, drop-oldest.

#![cfg(windows)]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use windows::Win32::Media::MediaFoundation::{
    IMFMediaType, IMFSample, IMFSourceReader, MFCreateAttributes, MFCreateMediaType,
    MFCreateSourceReaderFromMediaSource, MFMediaType_Video, MFVideoFormat_NV12, MFVideoFormat_RGB32,
    MFVideoFormat_YUY2, MF_MT_DEFAULT_STRIDE, MF_MT_FRAME_SIZE, MF_MT_MAJOR_TYPE, MF_MT_SUBTYPE,
    MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, MF_SOURCE_READERF_ENDOFSTREAM, MF_SOURCE_READERF_ERROR,
    MF_SOURCE_READER_ENABLE_ADVANCED_VIDEO_PROCESSING, MF_SOURCE_READER_FIRST_VIDEO_STREAM,
};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

use crate::audio_timeline::qpc_hns;
use crate::still::StillFrame;

use super::clock::CameraClockMap;
use super::color::{encode_png_bgra, flip_bgra_horizontal, nv12_to_bgra, rgb32_to_bgra, yuy2_to_bgra, base64_encode};
use super::device::{activate_source, ensure_mf, guid_from_subtype, list_modes, mf_error, permission_message, subtype_from_guid};
use super::format::{
    log_negotiated_mode, pick_camera_mode, CameraSubtype, NegotiatedMode, RequestedMode,
};
use super::types::{PreviewFrame, PreviewRequest};

const PREVIEW_MAX_WIDTH: u32 = 480;
const PREVIEW_MIN_INTERVAL: Duration = Duration::from_millis(80);
const QUEUE_KEEP: usize = 1;

pub struct PreviewSession {
    stop: Arc<AtomicBool>,
    thread: Mutex<Option<JoinHandle<()>>>,
    latest: Arc<Mutex<Option<PreviewFrame>>>,
    negotiated: Arc<Mutex<Option<NegotiatedMode>>>,
    timestamp_fallback: Arc<AtomicBool>,
    error: Arc<Mutex<Option<String>>>,
}

impl PreviewSession {
    pub fn start(request: PreviewRequest) -> Result<Self, String> {
        let request = request.sanitize()?;
        let stop = Arc::new(AtomicBool::new(false));
        let latest = Arc::new(Mutex::new(None));
        let negotiated = Arc::new(Mutex::new(None));
        let timestamp_fallback = Arc::new(AtomicBool::new(false));
        let error = Arc::new(Mutex::new(None));
        let thread_stop = Arc::clone(&stop);
        let thread_latest = Arc::clone(&latest);
        let thread_negotiated = Arc::clone(&negotiated);
        let thread_fallback = Arc::clone(&timestamp_fallback);
        let thread_error = Arc::clone(&error);
        let handle = std::thread::Builder::new()
            .name("camera-preview".into())
            .spawn(move || {
                if let Err(err) = run_preview(
                    request,
                    thread_stop,
                    thread_latest,
                    thread_negotiated,
                    thread_fallback,
                    Arc::clone(&thread_error),
                ) {
                    tracing::warn!("camera preview stopped: {err}");
                    if let Ok(mut slot) = thread_error.lock() {
                        *slot = Some(permission_message(&err));
                    }
                }
            })
            .map_err(|err| err.to_string())?;
        Ok(Self {
            stop,
            thread: Mutex::new(Some(handle)),
            latest,
            negotiated,
            timestamp_fallback,
            error,
        })
    }

    pub fn stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Ok(mut thread) = self.thread.lock() {
            if let Some(handle) = thread.take() {
                let _ = handle.join();
            }
        }
    }

    pub fn latest(&self) -> Option<PreviewFrame> {
        self.latest.lock().ok().and_then(|guard| guard.clone())
    }

    pub fn negotiated(&self) -> Option<NegotiatedMode> {
        self.negotiated.lock().ok().and_then(|guard| guard.clone())
    }

    pub fn timestamp_fallback(&self) -> bool {
        self.timestamp_fallback.load(Ordering::SeqCst)
    }

    pub fn error(&self) -> Option<String> {
        self.error.lock().ok().and_then(|guard| guard.clone())
    }
}

impl Drop for PreviewSession {
    fn drop(&mut self) {
        self.stop();
    }
}

fn run_preview(
    request: PreviewRequest,
    stop: Arc<AtomicBool>,
    latest: Arc<Mutex<Option<PreviewFrame>>>,
    negotiated_slot: Arc<Mutex<Option<NegotiatedMode>>>,
    timestamp_fallback: Arc<AtomicBool>,
    error: Arc<Mutex<Option<String>>>,
) -> Result<(), String> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    ensure_mf()?;
    let modes = list_modes(&request.device_id)?;
    let selected = pick_camera_mode(
        &modes,
        RequestedMode {
            width: request.width,
            height: request.height,
            fps: request.fps,
        },
    )
    .ok_or_else(|| "That camera did not report a usable video mode.".to_string())?;
    let source = unsafe { activate_source(&request.device_id)? };
    let (reader, reader_subtype) = open_preview_reader(&source, selected.width, selected.height)?;
    let negotiated = NegotiatedMode::from_native(selected.clone(), reader_subtype);
    log_negotiated_mode(&request.device_id, &negotiated);
    if let Ok(mut slot) = negotiated_slot.lock() {
        *slot = Some(negotiated.clone());
    }

    let mut clock = CameraClockMap::new(qpc_hns(), selected.fps.max(1));
    let mut last_emit = Instant::now()
        .checked_sub(PREVIEW_MIN_INTERVAL)
        .unwrap_or_else(Instant::now);
    let mut nv12_scratch = Vec::new();

    while !stop.load(Ordering::SeqCst) {
        let sample = match read_preview_sample(&reader, reader_subtype, selected.width, selected.height, &mut nv12_scratch)
        {
            Ok(Some(sample)) => sample,
            Ok(None) => continue,
            Err(err) => {
                if stop.load(Ordering::SeqCst) {
                    break;
                }
                return Err(err);
            }
        };
        let mapped = clock.map_sample(sample.time_hns, sample.duration_hns, qpc_hns());
        timestamp_fallback.store(mapped.fallback, Ordering::SeqCst);
        if last_emit.elapsed() < PREVIEW_MIN_INTERVAL {
            continue;
        }
        last_emit = Instant::now();
        let mut bgra = sample.bgra;
        if request.mirror {
            flip_bgra_horizontal(&mut bgra, sample.width, sample.height);
        }
        let frame = crate::still::scale_bgra(
            &StillFrame {
                bgra,
                width: sample.width,
                height: sample.height,
                pitch: sample.width * 4,
            },
            PREVIEW_MAX_WIDTH,
        );
        let png = encode_png_bgra(&frame.bgra, frame.width, frame.height)?;
        let preview = PreviewFrame {
            png_base64: base64_encode(&png),
            width: frame.width,
            height: frame.height,
            mirrored: request.mirror,
        };
        if let Ok(mut slot) = latest.lock() {
            *slot = Some(preview);
        }
        let _ = QUEUE_KEEP;
        let _ = error;
    }
    Ok(())
}

struct PreviewSample {
    bgra: Vec<u8>,
    width: u32,
    height: u32,
    time_hns: Option<i64>,
    duration_hns: Option<i64>,
}

fn open_preview_reader(
    source: &windows::Win32::Media::MediaFoundation::IMFMediaSource,
    width: u32,
    height: u32,
) -> Result<(IMFSourceReader, CameraSubtype), String> {
    let reader = create_reader(source, true, true)?;
    let stream = MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32;
    unsafe {
        reader
            .SetStreamSelection(stream, true)
            .map_err(|err| permission_message(&err.to_string()))?;
    }
    for subtype in [CameraSubtype::Nv12, CameraSubtype::Yuy2, CameraSubtype::Rgb32] {
        if let Ok(()) = set_reader_type(&reader, width, height, subtype) {
            tracing::info!(
                reader = subtype.as_label(),
                width,
                height,
                "camera preview reader output set"
            );
            return Ok((reader, subtype));
        }
    }
    Err("Could not negotiate a preview format for that camera.".into())
}

fn create_reader(
    source: &windows::Win32::Media::MediaFoundation::IMFMediaSource,
    hardware: bool,
    video_processing: bool,
) -> Result<IMFSourceReader, String> {
    unsafe {
        let mut attrs = None;
        MFCreateAttributes(&mut attrs, 2).map_err(mf_error)?;
        let attrs = attrs.ok_or_else(|| "Could not create Media Foundation attributes.".to_string())?;
        if video_processing {
            let _ = attrs.SetUINT32(&MF_SOURCE_READER_ENABLE_ADVANCED_VIDEO_PROCESSING, 1);
        }
        if hardware {
            let _ = attrs.SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1);
        }
        MFCreateSourceReaderFromMediaSource(source, Some(&attrs)).map_err(|err| permission_message(&err.to_string()))
    }
}

fn set_reader_type(reader: &IMFSourceReader, width: u32, height: u32, subtype: CameraSubtype) -> Result<(), String> {
    let guid = guid_from_subtype(subtype).ok_or_else(|| "Unsupported preview subtype.".to_string())?;
    unsafe {
        let media_type: IMFMediaType = MFCreateMediaType().map_err(mf_error)?;
        media_type
            .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
            .map_err(mf_error)?;
        media_type.SetGUID(&MF_MT_SUBTYPE, &guid).map_err(mf_error)?;
        media_type
            .SetUINT64(&MF_MT_FRAME_SIZE, pack(width, height))
            .map_err(mf_error)?;
        reader
            .SetCurrentMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32, None, &media_type)
            .map_err(mf_error)
    }
}

fn read_preview_sample(
    reader: &IMFSourceReader,
    subtype: CameraSubtype,
    fallback_width: u32,
    fallback_height: u32,
    nv12_scratch: &mut Vec<u8>,
) -> Result<Option<PreviewSample>, String> {
    let mut flags = 0u32;
    let mut timestamp = 0i64;
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
            .map_err(|err| permission_message(&err.to_string()))?;
    }
    if flags & MF_SOURCE_READERF_ERROR.0 as u32 != 0 {
        return Err("The camera disconnected.".into());
    }
    if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
        return Ok(None);
    }
    let Some(sample) = sample else {
        return Ok(None);
    };
    let sample_time = unsafe { sample.GetSampleTime().ok() };
    let sample_duration = unsafe { sample.GetSampleDuration().ok() };
    let (width, height) = reader_frame_size(reader).unwrap_or((fallback_width, fallback_height));
    let buffer = unsafe { sample.ConvertToContiguousBuffer().map_err(mf_error)? };
    let mut data = std::ptr::null_mut();
    let mut length = 0u32;
    let mut max_length = 0u32;
    unsafe {
        buffer
            .Lock(&mut data, Some(&mut max_length), Some(&mut length))
            .map_err(mf_error)?;
    }
    if data.is_null() || length == 0 {
        let _ = unsafe { buffer.Unlock() };
        return Ok(None);
    }
    let bytes = unsafe { std::slice::from_raw_parts(data, length as usize) };
    let stride = reader_stride(reader, width, subtype);
    let bgra = match subtype {
        CameraSubtype::Nv12 => {
            nv12_scratch.clear();
            nv12_scratch.extend_from_slice(bytes);
            let _ = unsafe { buffer.Unlock() };
            nv12_to_bgra(nv12_scratch, width, height, stride as usize)
        }
        CameraSubtype::Yuy2 => {
            let converted = yuy2_to_bgra(bytes, width, height, stride as usize);
            let _ = unsafe { buffer.Unlock() };
            converted
        }
        CameraSubtype::Rgb32 => {
            let converted = rgb32_to_bgra(bytes, width, height, stride as usize);
            let _ = unsafe { buffer.Unlock() };
            converted
        }
        _ => {
            let _ = unsafe { buffer.Unlock() };
            None
        }
    };
    let Some(bgra) = bgra else {
        return Ok(None);
    };
    let _ = timestamp;
    Ok(Some(PreviewSample {
        bgra,
        width,
        height,
        time_hns: sample_time.filter(|value| *value >= 0),
        duration_hns: sample_duration.filter(|value| *value > 0),
    }))
}

fn reader_frame_size(reader: &IMFSourceReader) -> Option<(u32, u32)> {
    unsafe {
        let media_type = reader
            .GetCurrentMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32)
            .ok()?;
        let packed = media_type.GetUINT64(&MF_MT_FRAME_SIZE).ok()?;
        Some(((packed >> 32) as u32, packed as u32))
    }
}

fn reader_stride(reader: &IMFSourceReader, width: u32, subtype: CameraSubtype) -> u32 {
    unsafe {
        if let Ok(media_type) = reader.GetCurrentMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32) {
            if let Ok(stride) = media_type.GetUINT32(&MF_MT_DEFAULT_STRIDE) {
                if stride > 0 {
                    return stride;
                }
            }
        }
    }
    match subtype {
        CameraSubtype::Nv12 => width,
        CameraSubtype::Yuy2 => width.saturating_mul(2),
        CameraSubtype::Rgb32 => width.saturating_mul(4),
        _ => width,
    }
}

fn pack(high: u32, low: u32) -> u64 {
    (u64::from(high) << 32) | u64::from(low)
}
