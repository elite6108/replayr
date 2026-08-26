//! Instant Replay webcam rolling segments.
//!
//! Writes 2s NV12/H.264 files on the shared SessionClock grid. Failure here
//! never touches gameplay capture or F10 save.

#![cfg(windows)]

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

use crate::encode::MfWriter;

use super::clock::{segment_index, CameraClockMap, SegmentHealth, SourceSegment};
use super::device::{activate_source, ensure_mf, list_modes, permission_message};
use super::encoder::open_webcam_segment_writer;
use super::format::{log_negotiated_mode, pick_camera_mode, RequestedMode};
use super::record::{open_record_reader, read_nv12_frame, FrameQueue, RecordSnapshot};
use super::ring::{segment_path, webcam_dir, RotateAck, WebcamBuffer};
use super::safety::{webcam_encode_should_abort, SOFTWARE_STALL_LIMIT, SOFTWARE_WRITE_BUDGET};
use super::types::sanitize_device_id;

const ROTATE_POLL: Duration = Duration::from_millis(40);

pub struct RollingRequest {
    pub device_id: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub mirror: bool,
    pub bitrate: u32,
    pub dir: PathBuf,
    pub session_origin_hns: i64,
    pub rotate: Arc<RotateAck>,
    pub buffer: Arc<Mutex<WebcamBuffer>>,
}

impl RollingRequest {
    fn sanitize(self) -> Result<Self, String> {
        let device_id = sanitize_device_id(&self.device_id)?;
        if device_id.is_empty() {
            return Err("Choose a camera first.".into());
        }
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
            dir: self.dir,
            session_origin_hns: self.session_origin_hns,
            rotate: self.rotate,
            buffer: self.buffer,
        })
    }
}

pub struct RollingSession {
    stop: Arc<AtomicBool>,
    thread: Mutex<Option<JoinHandle<()>>>,
    snapshot: Arc<Mutex<RecordSnapshot>>,
}

impl RollingSession {
    pub fn start(request: RollingRequest) -> Result<Self, String> {
        let request = request.sanitize()?;
        std::fs::create_dir_all(&request.dir).map_err(|err| err.to_string())?;
        let stop = Arc::new(AtomicBool::new(false));
        let snapshot = Arc::new(Mutex::new(RecordSnapshot {
            recording: true,
            path: request.dir.to_string_lossy().into_owned(),
            ..RecordSnapshot::default()
        }));
        let thread_stop = Arc::clone(&stop);
        let thread_snapshot = Arc::clone(&snapshot);
        let handle = std::thread::Builder::new()
            .name("camera-roll".into())
            .spawn(move || {
                let result = run_rolling(request, thread_stop, Arc::clone(&thread_snapshot));
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

impl Drop for RollingSession {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Ok(mut thread) = self.thread.lock() {
            if let Some(handle) = thread.take() {
                let _ = handle.join();
            }
        }
    }
}

struct OpenSegment {
    writer: MfWriter,
    path: PathBuf,
    grid_index: i64,
    start_hns: i64,
    last_hns: i64,
    last_duration: i64,
    written: u32,
}

fn run_rolling(
    request: RollingRequest,
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
    let (reader, reader_subtype) = match open_record_reader(&source, selected.width, selected.height) {
        Ok(opened) => opened,
        Err(err) => {
            let _ = source.Shutdown();
            return Err(err);
        }
    };
    let negotiated = super::format::NegotiatedMode::from_native(selected.clone(), reader_subtype);
    log_negotiated_mode(&request.device_id, &negotiated);
    if let Ok(mut slot) = snapshot.lock() {
        slot.native_subtype = Some(negotiated.native_subtype);
        slot.reader_subtype = Some(negotiated.reader_subtype);
        slot.conversion_path = negotiated.conversion_path;
        slot.width = selected.width;
        slot.height = selected.height;
        slot.fps = selected.fps;
    }

    let queue = FrameQueue::new();
    let encode_queue = Arc::clone(&queue);
    let encode_snapshot = Arc::clone(&snapshot);
    let encode_request = RollingEncode {
        dir: request.dir.clone(),
        width: selected.width,
        height: selected.height,
        fps: selected.fps,
        bitrate: request.bitrate,
        session_origin_hns: request.session_origin_hns,
        rotate: Arc::clone(&request.rotate),
        buffer: Arc::clone(&request.buffer),
        software: false,
    };
    let encode = match std::thread::Builder::new()
        .name("camera-roll-encode".into())
        .spawn(move || rolling_encode_loop(encode_request, encode_queue, encode_snapshot))
    {
        Ok(handle) => handle,
        Err(err) => {
            let _ = source.Shutdown();
            return Err(err.to_string());
        }
    };

    let mut scratch = Vec::new();
    while !stop.load(Ordering::SeqCst) {
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
                let _ = source.Shutdown();
                request.rotate.ack();
                return Err(err);
            }
        }
        let seen = queue.seen.load(Ordering::SeqCst);
        let dropped = queue.dropped.load(Ordering::SeqCst);
        if webcam_encode_should_abort(dropped, seen) {
            tracing::warn!(dropped, seen, "webcam rolling dropped too many frames; aborting webcam only");
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
            let _ = source.Shutdown();
            request.rotate.ack();
            return Err(err);
        }
        Err(_) => {
            let _ = source.Shutdown();
            request.rotate.ack();
            return Err("Webcam rolling encode thread panicked.".into());
        }
    }
    let _ = source.Shutdown();
    request.rotate.ack();
    Ok(())
}

struct RollingEncode {
    dir: PathBuf,
    width: u32,
    height: u32,
    fps: u32,
    bitrate: u32,
    session_origin_hns: i64,
    rotate: Arc<RotateAck>,
    buffer: Arc<Mutex<WebcamBuffer>>,
    software: bool,
}

fn rolling_encode_loop(
    mut request: RollingEncode,
    queue: Arc<FrameQueue>,
    snapshot: Arc<Mutex<RecordSnapshot>>,
) -> Result<(), String> {
    let mut clock = CameraClockMap::new(request.session_origin_hns, request.fps.max(1));
    let mut current: Option<OpenSegment> = None;
    let mut file_seq = 0u64;
    let mut stalls = 0u32;
    let mut consecutive_open_failures = 0u32;
    loop {
        let frame = queue.pop_timeout(ROTATE_POLL);
        let had_frame = frame.is_some();
        let rotate = request.rotate.take();
        if let Some(frame) = frame {
            let mapped = clock.map_sample(frame.sample_time, frame.sample_duration, frame.arrival_qpc);
            if let Ok(mut slot) = snapshot.lock() {
                slot.timestamp_fallback = mapped.fallback || clock.is_fallback();
                slot.session_skew_hns = clock.last_skew_hns().unwrap_or(0);
            }
            let index = segment_index(mapped.session_hns);
            let grid_changed = current.as_ref().is_some_and(|open| open.grid_index != index);
            if grid_changed || rotate {
                close_segment(&mut current, &request.buffer, SegmentHealth::Valid);
                if rotate {
                    request.rotate.ack();
                }
            }
            if current.is_none() {
                if let Ok(mut buffer) = request.buffer.lock() {
                    buffer.fill_gaps_before(index);
                }
                match open_segment(&request, file_seq, index, mapped.session_hns, &snapshot) {
                    Ok((opened, software)) => {
                        request.software = software;
                        current = Some(opened);
                        file_seq += 1;
                        consecutive_open_failures = 0;
                    }
                    Err(err) => {
                        consecutive_open_failures += 1;
                        tracing::warn!(%err, index, "webcam segment open failed; gameplay continues");
                        if let Ok(mut buffer) = request.buffer.lock() {
                            let (start_hns, end_hns) = super::clock::segment_bounds(index);
                            buffer.push(SourceSegment {
                                start_hns,
                                end_hns,
                                path: String::new(),
                                health: SegmentHealth::Failed,
                            });
                        }
                        if consecutive_open_failures >= 2 {
                            return Err(err);
                        }
                        continue;
                    }
                }
            }
            let Some(open) = current.as_mut() else {
                continue;
            };
            let first = open.written == 0;
            let started = Instant::now();
            if let Err(err) = open.writer.write_nv12_timed(
                &frame.planes,
                frame.width,
                frame.height,
                mapped.session_hns,
                mapped.duration_hns,
                first,
            ) {
                tracing::warn!(%err, "webcam segment write failed; closing webcam only");
                close_segment(&mut current, &request.buffer, SegmentHealth::Failed);
                return Err(err);
            }
            open.last_hns = mapped.session_hns;
            open.last_duration = mapped.duration_hns;
            open.written += 1;
            let elapsed = started.elapsed();
            if request.software && elapsed > SOFTWARE_WRITE_BUDGET {
                stalls += 1;
                tracing::warn!(?elapsed, stalls, "software H.264 write exceeded webcam budget");
                if stalls >= SOFTWARE_STALL_LIMIT {
                    close_segment(&mut current, &request.buffer, SegmentHealth::Failed);
                    return Err("Software webcam encoding is too slow on this PC.".into());
                }
            } else {
                stalls = 0;
            }
            if let Ok(mut slot) = snapshot.lock() {
                slot.written_frames = slot.written_frames.saturating_add(1);
                slot.dropped_frames = queue.dropped.load(Ordering::SeqCst);
            }
        } else if rotate {
            close_segment(&mut current, &request.buffer, SegmentHealth::Valid);
            request.rotate.ack();
        }
        if queue.closed() && !had_frame {
            break;
        }
    }
    close_segment(&mut current, &request.buffer, SegmentHealth::Valid);
    if request.rotate.take() {
        request.rotate.ack();
    }
    Ok(())
}

fn open_segment(
    request: &RollingEncode,
    file_seq: u64,
    grid_index: i64,
    start_hns: i64,
    snapshot: &Mutex<RecordSnapshot>,
) -> Result<(OpenSegment, bool), String> {
    let path = segment_path(&request.dir, file_seq);
    let opened = open_webcam_segment_writer(&path, request.width, request.height, request.fps, request.bitrate)?;
    if let Ok(mut slot) = snapshot.lock() {
        if slot.encoder_name.is_empty() {
            slot.encoder_name = opened.name.clone();
            slot.software_fallback = opened.software_fallback;
            slot.encoder_hardware =
                opened.hardware_requested && !opened.software_fallback && opened.transform_name.is_some();
        }
        slot.path = path.to_string_lossy().into_owned();
    }
    Ok((
        OpenSegment {
            writer: opened.writer,
            path,
            grid_index,
            start_hns,
            last_hns: start_hns,
            last_duration: 0,
            written: 0,
        },
        opened.software_fallback,
    ))
}

fn close_segment(current: &mut Option<OpenSegment>, buffer: &Mutex<WebcamBuffer>, health: SegmentHealth) {
    let Some(open) = current.take() else {
        return;
    };
    let written = open.written;
    let path = open.path.clone();
    let start_hns = open.start_hns;
    let end_hns = open
        .last_hns
        .saturating_add(open.last_duration)
        .max(start_hns.saturating_add(10_000));
    let finish = open.writer.finish();
    if written == 0 {
        let _ = finish;
        let _ = std::fs::remove_file(&path);
        return;
    }
    let file_ok = finish.is_ok() && std::fs::metadata(&path).map(|meta| meta.len() > 0).unwrap_or(false);
    if let Err(err) = finish {
        tracing::warn!(%err, path = %path.display(), "webcam segment finish failed");
    }
    if !file_ok {
        let _ = std::fs::remove_file(&path);
    }
    if let Ok(mut buffer) = buffer.lock() {
        buffer.push(SourceSegment {
            start_hns,
            end_hns,
            path: if file_ok {
                path.to_string_lossy().into_owned()
            } else {
                String::new()
            },
            health: if file_ok { SegmentHealth::Valid } else { health },
        });
    }
}

pub fn prepare_webcam_dir(scratch: &std::path::Path) -> PathBuf {
    webcam_dir(scratch)
}
