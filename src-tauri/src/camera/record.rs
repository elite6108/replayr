//! Standalone webcam MP4 encode. Not wired into Instant Replay.
//!
//! Camera samples keep IMFSample timestamps (mapped through CameraClockMap).
//! Encode uses NV12. Hardware H.264 is preferred; software is a warned
//! fallback. Failure here never touches gameplay capture.

#![cfg(windows)]

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use windows::Win32::Media::MediaFoundation::{
    IMFMediaType, IMFSample, IMFSourceReader, MFCreateAttributes, MFCreateMediaType,
    MFCreateSourceReaderFromMediaSource, MFMediaType_Video, MF_MT_DEFAULT_STRIDE, MF_MT_FRAME_SIZE,
    MF_MT_MAJOR_TYPE, MF_MT_SUBTYPE, MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS,
    MF_SOURCE_READERF_ENDOFSTREAM, MF_SOURCE_READERF_ERROR,
    MF_SOURCE_READER_ENABLE_ADVANCED_VIDEO_PROCESSING, MF_SOURCE_READER_FIRST_VIDEO_STREAM,
};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

use crate::audio_timeline::qpc_hns;
use crate::encode::MfWriter;

use super::clock::{CameraClockMap, SessionClock};
use super::color::{bgra_to_nv12, compact_nv12, flip_nv12_horizontal, yuy2_to_nv12};
use super::device::{
    activate_source, ensure_mf, guid_from_subtype, list_modes, mf_error, permission_message,
};
use super::encoder::open_webcam_writer;
use super::format::{log_negotiated_mode, pick_camera_mode, CameraSubtype, NegotiatedMode, RequestedMode};
use super::safety::{
    webcam_encode_should_abort, QUEUE_CAP, SOFTWARE_STALL_LIMIT, SOFTWARE_WRITE_BUDGET, TEST_RECORD_SECONDS,
};
use super::types::sanitize_device_id;

pub struct RecordRequest {
    pub device_id: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub mirror: bool,
    pub bitrate: u32,
    pub path: PathBuf,
    pub max_duration: Duration,
    pub session_origin_hns: Option<i64>,
}

impl RecordRequest {
    pub fn sanitize(self) -> Result<Self, String> {
        let device_id = sanitize_device_id(&self.device_id)?;
        if device_id.is_empty() {
            return Err("Choose a camera first.".into());
        }
        let max_duration = self
            .max_duration
            .min(Duration::from_secs(u64::from(TEST_RECORD_SECONDS) + 4))
            .max(Duration::from_secs(2));
        Ok(Self {
            device_id,
            width: self.width.clamp(160, 1920) & !1,
            height: self.height.clamp(120, 1080) & !1,
            fps: match self.fps {
                60 => 60,
                24 => 24,
                _ => 30,
            },
            mirror: self.mirror,
            bitrate: self.bitrate.clamp(2_000_000, 10_000_000),
            path: self.path,
            max_duration,
            session_origin_hns: self.session_origin_hns,
        })
    }
}

#[derive(Debug, Clone, Default)]
pub struct RecordSnapshot {
    pub recording: bool,
    pub finished: bool,
    pub path: String,
    pub encoder_name: String,
    pub software_fallback: bool,
    pub encoder_hardware: bool,
    pub dropped_frames: u32,
    pub written_frames: u32,
    pub message: String,
    pub native_subtype: Option<CameraSubtype>,
    pub reader_subtype: Option<CameraSubtype>,
    pub conversion_path: bool,
    pub timestamp_fallback: bool,
    pub session_skew_hns: i64,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
}

pub struct RecordSession {
    stop: Arc<AtomicBool>,
    thread: Mutex<Option<JoinHandle<()>>>,
    snapshot: Arc<Mutex<RecordSnapshot>>,
}

impl RecordSession {
    pub fn start(request: RecordRequest) -> Result<Self, String> {
        let request = request.sanitize()?;
        let stop = Arc::new(AtomicBool::new(false));
        let snapshot = Arc::new(Mutex::new(RecordSnapshot {
            recording: true,
            path: request.path.to_string_lossy().into_owned(),
            ..RecordSnapshot::default()
        }));
        let thread_stop = Arc::clone(&stop);
        let thread_snapshot = Arc::clone(&snapshot);
        let handle = std::thread::Builder::new()
            .name("camera-record".into())
            .spawn(move || {
                let result = run_record(request, thread_stop, Arc::clone(&thread_snapshot));
                if let Ok(mut slot) = thread_snapshot.lock() {
                    slot.recording = false;
                    slot.finished = true;
                    if let Err(err) = result {
                        slot.message = permission_message(&err);
                    }
                }
            })
            .map_err(|err| err.to_string())?;
        Ok(Self {
            stop,
            thread: Mutex::new(Some(handle)),
            snapshot,
        })
    }

    pub fn stop(self) -> RecordSnapshot {
        self.stop.store(true, Ordering::SeqCst);
        if let Ok(mut thread) = self.thread.lock() {
            if let Some(handle) = thread.take() {
                let _ = handle.join();
            }
        }
        self.snapshot
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default()
    }

    pub fn request_stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
    }

    pub fn snapshot(&self) -> RecordSnapshot {
        self.snapshot
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default()
    }

    pub fn finished(&self) -> bool {
        self.snapshot.lock().ok().is_some_and(|guard| guard.finished)
    }
}

impl Drop for RecordSession {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Ok(mut thread) = self.thread.lock() {
            if let Some(handle) = thread.take() {
                let _ = handle.join();
            }
        }
    }
}

pub(super) struct Nv12Frame {
    pub(super) planes: Vec<u8>,
    pub(super) width: u32,
    pub(super) height: u32,
    pub(super) sample_time: Option<i64>,
    pub(super) sample_duration: Option<i64>,
    pub(super) arrival_qpc: i64,
}

pub(super) struct FrameQueue {
    frames: Mutex<VecDeque<Nv12Frame>>,
    cv: Condvar,
    shutdown: AtomicBool,
    pub(super) dropped: AtomicU32,
    pub(super) seen: AtomicU32,
}

impl FrameQueue {
    pub(super) fn new() -> Arc<Self> {
        Arc::new(Self {
            frames: Mutex::new(VecDeque::new()),
            cv: Condvar::new(),
            shutdown: AtomicBool::new(false),
            dropped: AtomicU32::new(0),
            seen: AtomicU32::new(0),
        })
    }

    pub(super) fn push(&self, frame: Nv12Frame) {
        self.seen.fetch_add(1, Ordering::SeqCst);
        if self.shutdown.load(Ordering::SeqCst) {
            return;
        }
        let Ok(mut frames) = self.frames.lock() else {
            return;
        };
        while frames.len() >= QUEUE_CAP {
            frames.pop_front();
            self.dropped.fetch_add(1, Ordering::SeqCst);
        }
        frames.push_back(frame);
        self.cv.notify_one();
    }

    pub(super) fn pop(&self) -> Option<Nv12Frame> {
        let Ok(mut frames) = self.frames.lock() else {
            return None;
        };
        loop {
            if let Some(frame) = frames.pop_front() {
                return Some(frame);
            }
            if self.shutdown.load(Ordering::SeqCst) {
                return None;
            }
            frames = self.cv.wait(frames).ok()?;
        }
    }

    pub(super) fn pop_timeout(&self, timeout: Duration) -> Option<Nv12Frame> {
        let Ok(mut frames) = self.frames.lock() else {
            return None;
        };
        loop {
            if let Some(frame) = frames.pop_front() {
                return Some(frame);
            }
            if self.shutdown.load(Ordering::SeqCst) {
                return None;
            }
            let (guard, timed_out) = match self.cv.wait_timeout(frames, timeout) {
                Ok(result) => result,
                Err(_) => return None,
            };
            frames = guard;
            if timed_out.timed_out() {
                return None;
            }
        }
    }

    pub(super) fn closed(&self) -> bool {
        self.shutdown.load(Ordering::SeqCst)
    }

    pub(super) fn close(&self) {
        self.shutdown.store(true, Ordering::SeqCst);
        self.cv.notify_all();
    }
}

fn run_record(
    request: RecordRequest,
    stop: Arc<AtomicBool>,
    snapshot: Arc<Mutex<RecordSnapshot>>,
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
    let (reader, reader_subtype) = open_record_reader(&source, selected.width, selected.height)?;
    let negotiated = NegotiatedMode::from_native(selected.clone(), reader_subtype);
    log_negotiated_mode(&request.device_id, &negotiated);
    publish_negotiated(&snapshot, &negotiated);

    let opened = match open_webcam_writer(
        &request.path,
        selected.width,
        selected.height,
        selected.fps.max(1),
        request.bitrate,
    ) {
        Ok(opened) => opened,
        Err(err) => {
            let _ = unsafe { source.Shutdown() };
            return Err(err);
        }
    };
    {
        if let Ok(mut slot) = snapshot.lock() {
            slot.encoder_name = opened.name.clone();
            slot.software_fallback = opened.software_fallback;
            slot.encoder_hardware = opened.hardware_requested && !opened.software_fallback && opened.transform_name.is_some();
            slot.width = selected.width;
            slot.height = selected.height;
            slot.fps = selected.fps;
        }
    }

    let queue = FrameQueue::new();
    let encode_queue = Arc::clone(&queue);
    let encode_snapshot = Arc::clone(&snapshot);
    let software = opened.software_fallback;
    let writer = opened.writer;
    let session_origin = request
        .session_origin_hns
        .unwrap_or_else(|| SessionClock::start().qpc_origin_hns());
    tracing::info!(
        session_origin_hns = session_origin,
        live_session = request.session_origin_hns.is_some(),
        "webcam encode using SessionClock origin"
    );
    let encode = match std::thread::Builder::new()
        .name("camera-encode".into())
        .spawn(move || {
            encode_loop(
                writer,
                encode_queue,
                encode_snapshot,
                software,
                session_origin,
                selected.fps,
            )
        })
    {
        Ok(handle) => handle,
        Err(err) => {
            let _ = unsafe { source.Shutdown() };
            return Err(err.to_string());
        }
    };

    let deadline = Instant::now() + request.max_duration;
    let mut scratch = Vec::new();
    while !stop.load(Ordering::SeqCst) && Instant::now() < deadline {
        if encode.is_finished() {
            break;
        }
        match read_nv12_frame(
            &reader,
            reader_subtype,
            selected.width,
            selected.height,
            request.mirror,
            &mut scratch,
        ) {
            Ok(Some(frame)) => queue.push(frame),
            Ok(None) => continue,
            Err(err) => {
                queue.close();
                let _ = encode.join();
                let _ = unsafe { source.Shutdown() };
                return Err(err);
            }
        }
        let seen = queue.seen.load(Ordering::SeqCst);
        let dropped = queue.dropped.load(Ordering::SeqCst);
        if webcam_encode_should_abort(dropped, seen) {
            tracing::warn!(dropped, seen, "webcam encode dropped too many frames; aborting webcam only");
            break;
        }
        if let Ok(mut slot) = snapshot.lock() {
            slot.dropped_frames = dropped;
        }
    }
    queue.close();
    match encode.join() {
        Ok(Ok(())) => {}
        Ok(Err(err)) => {
            let _ = unsafe { source.Shutdown() };
            return Err(err);
        }
        Err(_) => {
            let _ = unsafe { source.Shutdown() };
            return Err("Webcam encode thread panicked.".into());
        }
    }
    let _ = unsafe { source.Shutdown() };
    Ok(())
}

fn encode_loop(
    mut writer: MfWriter,
    queue: Arc<FrameQueue>,
    snapshot: Arc<Mutex<RecordSnapshot>>,
    software: bool,
    session_origin_hns: i64,
    fps: u32,
) -> Result<(), String> {
    let mut clock = CameraClockMap::new(session_origin_hns, fps.max(1));
    let mut stalls = 0u32;
    let mut written = 0u32;
    while let Some(frame) = queue.pop() {
        let mapped = clock.map_sample(frame.sample_time, frame.sample_duration, frame.arrival_qpc);
        if let Ok(mut slot) = snapshot.lock() {
            slot.timestamp_fallback = mapped.fallback || clock.is_fallback();
            slot.session_skew_hns = clock.last_skew_hns().unwrap_or(0);
        }
        let started = Instant::now();
        writer.write_nv12_timed(
            &frame.planes,
            frame.width,
            frame.height,
            mapped.session_hns,
            mapped.duration_hns,
            written == 0,
        )?;
        let elapsed = started.elapsed();
        written += 1;
        if software && elapsed > SOFTWARE_WRITE_BUDGET {
            stalls += 1;
            tracing::warn!(?elapsed, stalls, "software H.264 write exceeded webcam budget");
            if stalls >= SOFTWARE_STALL_LIMIT {
                let _ = writer.finish();
                return Err("Software webcam encoding is too slow on this PC.".into());
            }
        } else {
            stalls = 0;
        }
        if let Ok(mut slot) = snapshot.lock() {
            slot.written_frames = written;
            slot.dropped_frames = queue.dropped.load(Ordering::SeqCst);
        }
    }
    writer.finish()?;
    Ok(())
}

fn publish_negotiated(snapshot: &Mutex<RecordSnapshot>, negotiated: &NegotiatedMode) {
    if let Ok(mut slot) = snapshot.lock() {
        slot.native_subtype = Some(negotiated.native_subtype);
        slot.reader_subtype = Some(negotiated.reader_subtype);
        slot.conversion_path = negotiated.conversion_path;
        slot.width = negotiated.mode.width;
        slot.height = negotiated.mode.height;
        slot.fps = negotiated.mode.fps;
    }
}

pub(super) fn open_record_reader(
    source: &windows::Win32::Media::MediaFoundation::IMFMediaSource,
    width: u32,
    height: u32,
) -> Result<(IMFSourceReader, CameraSubtype), String> {
    unsafe {
        let mut attrs = None;
        MFCreateAttributes(&mut attrs, 2).map_err(mf_error)?;
        let attrs = attrs.ok_or_else(|| "Could not create Media Foundation attributes.".to_string())?;
        let _ = attrs.SetUINT32(&MF_SOURCE_READER_ENABLE_ADVANCED_VIDEO_PROCESSING, 1);
        let _ = attrs.SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1);
        let reader = MFCreateSourceReaderFromMediaSource(source, Some(&attrs))
            .map_err(|err| permission_message(&err.to_string()))?;
        reader
            .SetStreamSelection(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32, true)
            .map_err(|err| permission_message(&err.to_string()))?;
        for subtype in [CameraSubtype::Nv12, CameraSubtype::Yuy2, CameraSubtype::Rgb32] {
            if set_reader_type(&reader, width, height, subtype).is_ok() {
                tracing::info!(
                    reader = subtype.as_label(),
                    width,
                    height,
                    conversion = subtype != CameraSubtype::Nv12,
                    "camera record reader output set"
                );
                return Ok((reader, subtype));
            }
        }
        Err("Could not negotiate an NV12/YUY2 record format for that camera.".into())
    }
}

fn set_reader_type(reader: &IMFSourceReader, width: u32, height: u32, subtype: CameraSubtype) -> Result<(), String> {
    let guid = guid_from_subtype(subtype).ok_or_else(|| "Unsupported record subtype.".to_string())?;
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

pub(super) fn read_nv12_frame(
    reader: &IMFSourceReader,
    subtype: CameraSubtype,
    fallback_width: u32,
    fallback_height: u32,
    mirror: bool,
    scratch: &mut Vec<u8>,
) -> Result<Option<Nv12Frame>, String> {
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
    let arrival_qpc = qpc_hns();
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
    unsafe {
        buffer
            .Lock(&mut data, None, Some(&mut length))
            .map_err(mf_error)?;
    }
    if data.is_null() || length == 0 {
        let _ = unsafe { buffer.Unlock() };
        return Ok(None);
    }
    let bytes = unsafe { std::slice::from_raw_parts(data, length as usize) };
    let stride = reader_stride(reader, width, subtype);
    scratch.clear();
    scratch.extend_from_slice(bytes);
    let _ = unsafe { buffer.Unlock() };
    let mut nv12 = match subtype {
        CameraSubtype::Nv12 => compact_nv12(scratch, width, height, stride as usize),
        CameraSubtype::Yuy2 => yuy2_to_nv12(scratch, width, height, stride as usize),
        CameraSubtype::Rgb32 => bgra_to_nv12(scratch, width, height, stride as usize),
        _ => None,
    }
    .ok_or_else(|| "Could not convert that camera frame to NV12.".to_string())?;
    if mirror {
        flip_nv12_horizontal(&mut nv12, width, height);
    }
    let sample_time = sample_time.or(Some(timestamp)).filter(|value| *value >= 0);
    Ok(Some(Nv12Frame {
        planes: nv12,
        width,
        height,
        sample_time,
        sample_duration: sample_duration.filter(|value| *value > 0),
        arrival_qpc,
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
