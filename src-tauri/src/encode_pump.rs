use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

use crate::buffer::Segment;
use crate::capture::CaptureShared;
use crate::encode::MfWriter;

const SEGMENT_HNS: i64 = 20_000_000;
const QUEUE_CAP: usize = 30;
const START_TIMEOUT: Duration = Duration::from_secs(10);

pub struct QueuedFrame {
    pub bgra: Vec<u8>,
    pub pitch: u32,
    pub width: u32,
    pub height: u32,
    pub capture_hns: i64,
    pub pcm: Vec<u8>,
}

pub struct EncodeSession {
    pub path: PathBuf,
    pub dir: PathBuf,
    pub width: u32,
    pub height: u32,
    pub bitrate: u32,
    pub fps: u32,
    pub include_audio: bool,
    pub segmented: bool,
    pub min_free_disk_bytes: u64,
    pub shared: Arc<CaptureShared>,
}

struct FrameQueue {
    frames: Mutex<VecDeque<QueuedFrame>>,
    cv: Condvar,
    shutdown: AtomicBool,
}

impl FrameQueue {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            frames: Mutex::new(VecDeque::new()),
            cv: Condvar::new(),
            shutdown: AtomicBool::new(false),
        })
    }

    fn push(&self, frame: QueuedFrame) {
        if self.shutdown.load(Ordering::SeqCst) {
            return;
        }
        let Ok(mut frames) = self.frames.lock() else {
            return;
        };
        while frames.len() >= QUEUE_CAP {
            frames.pop_front();
        }
        frames.push_back(frame);
        self.cv.notify_one();
    }

    fn pop(&self) -> Option<QueuedFrame> {
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

    fn close(&self) {
        self.shutdown.store(true, Ordering::SeqCst);
        self.cv.notify_all();
    }
}

pub struct EncodePump {
    queue: Arc<FrameQueue>,
    join: Option<JoinHandle<()>>,
    pub include_audio: bool,
}

impl EncodePump {
    pub fn start(session: EncodeSession) -> Result<Self, String> {
        let queue = FrameQueue::new();
        let queue_thread = Arc::clone(&queue);
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let join = thread::Builder::new()
            .name("replay-encode".into())
            .spawn(move || {
                let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
                encode_thread_main(session, queue_thread, ready_tx);
            })
            .map_err(|err| format!("Could not start the encode thread: {err}"))?;
        let include_audio = ready_rx
            .recv_timeout(START_TIMEOUT)
            .map_err(|_| "Encode thread did not start.".to_string())??;
        Ok(Self {
            queue,
            join: Some(join),
            include_audio,
        })
    }

    pub fn push(&self, frame: QueuedFrame) {
        self.queue.push(frame);
    }

    pub fn shutdown(&mut self) {
        self.queue.close();
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

impl Drop for EncodePump {
    fn drop(&mut self) {
        self.shutdown();
    }
}

struct EncodeState {
    encoder: Option<MfWriter>,
    path: PathBuf,
    dir: PathBuf,
    width: u32,
    height: u32,
    bitrate: u32,
    fps: u32,
    include_audio: bool,
    segmented: bool,
    min_free_disk_bytes: u64,
    shared: Arc<CaptureShared>,
    segment_index: u64,
}

fn encode_thread_main(
    session: EncodeSession,
    queue: Arc<FrameQueue>,
    ready: std::sync::mpsc::Sender<Result<bool, String>>,
) {
    let mut include_audio = session.include_audio;
    let encoder = match open_session_encoder(&session.path, &session, include_audio) {
        Ok(encoder) => encoder,
        Err(err) if include_audio => {
            tracing::warn!("encoder with audio failed ({err}); retrying silent");
            include_audio = false;
            match open_session_encoder(&session.path, &session, false) {
                Ok(encoder) => encoder,
                Err(err) => {
                    let _ = ready.send(Err(err));
                    return;
                }
            }
        }
        Err(err) => {
            let _ = ready.send(Err(err));
            return;
        }
    };
    include_audio = include_audio && encoder.has_audio();
    if ready.send(Ok(include_audio)).is_err() {
        let _ = encoder.finish();
        return;
    }
    let mut state = EncodeState {
        encoder: Some(encoder),
        path: session.path,
        dir: session.dir,
        width: session.width,
        height: session.height,
        bitrate: session.bitrate,
        fps: session.fps,
        include_audio,
        segmented: session.segmented,
        min_free_disk_bytes: session.min_free_disk_bytes,
        shared: session.shared,
        segment_index: 0,
    };
    while let Some(frame) = queue.pop() {
        if let Err(err) = state.handle_frame(frame) {
            tracing::warn!("encode pump stopped: {err}");
            break;
        }
    }
    let _ = state.finish_encoder();
    tracing::info!("capture encoder finished");
}

impl EncodeState {
    fn handle_frame(&mut self, frame: QueuedFrame) -> Result<(), String> {
        let requested = self.shared.rotate.swap(false, Ordering::SeqCst);
        let Some(encoder) = self.encoder.as_mut() else {
            return Ok(());
        };
        let duration = encoder.preview_duration(frame.capture_hns);
        let closing = self.segmented && (requested || encoder.timestamp() + duration >= SEGMENT_HNS);
        encoder.write_bgra(
            &frame.bgra,
            frame.pitch,
            frame.width,
            frame.height,
            frame.capture_hns,
            closing,
        )?;
        if self.include_audio {
            if closing {
                encoder.write_pcm_closing(&frame.pcm)?;
            } else {
                encoder.write_pcm(&frame.pcm)?;
            }
        }
        if closing {
            self.rotate()?;
        }
        Ok(())
    }

    fn rotate(&mut self) -> Result<(), String> {
        let leftover = self
            .encoder
            .as_mut()
            .map(|encoder| encoder.take_audio_leftover())
            .unwrap_or_default();
        let last_capture = self.encoder.as_ref().and_then(MfWriter::last_capture_hns);
        self.finish_encoder()?;
        match crate::disk::ensure_free_space(&self.dir, self.min_free_disk_bytes) {
            Ok(_) => {}
            Err(err) => {
                tracing::warn!("disk guard stopped the replay buffer: {err}");
                self.shared.notify_rotate();
                return Err(err.to_string());
            }
        }
        self.segment_index += 1;
        self.path = self.dir.join(format!("seg-{:06}.mp4", self.segment_index));
        let session = self.as_session();
        let mut encoder = open_session_encoder(&self.path, &session, self.include_audio)?;
        encoder.set_last_capture_hns(last_capture);
        encoder.prepend_audio_leftover(leftover);
        self.include_audio = self.include_audio && encoder.has_audio();
        self.encoder = Some(encoder);
        self.shared.notify_rotate();
        self.sweep_scratch();
        Ok(())
    }

    fn as_session(&self) -> EncodeSession {
        EncodeSession {
            path: self.path.clone(),
            dir: self.dir.clone(),
            width: self.width,
            height: self.height,
            bitrate: self.bitrate,
            fps: self.fps,
            include_audio: self.include_audio,
            segmented: self.segmented,
            min_free_disk_bytes: self.min_free_disk_bytes,
            shared: Arc::clone(&self.shared),
        }
    }

    fn sweep_scratch(&self) {
        let mut keep = self
            .shared
            .buffer
            .lock()
            .map(|buffer| buffer.paths())
            .unwrap_or_default();
        keep.push(self.path.clone());
        crate::buffer::sweep_dir(&self.dir, &keep);
    }

    fn finish_encoder(&mut self) -> Result<(), String> {
        if let Some(mut encoder) = self.encoder.take() {
            let _ = encoder.write_pcm_closing(&[]);
            let duration_ms = (encoder.timestamp() / 10_000).max(0) as u64;
            let path = self.path.clone();
            encoder.finish().map_err(|err| err.to_string())?;
            if self.segmented && duration_ms > 0 {
                if let Ok(mut buffer) = self.shared.buffer.lock() {
                    buffer.push(Segment {
                        path,
                        duration_ms,
                        width: self.width,
                        height: self.height,
                        fps: self.fps,
                        pinned: false,
                        locked: false,
                    });
                }
                self.sweep_scratch();
            }
        }
        Ok(())
    }
}

fn open_session_encoder(path: &Path, session: &EncodeSession, want_audio: bool) -> Result<MfWriter, String> {
    let with_aac = want_audio && !session.segmented;
    let pcm_path = if want_audio && session.segmented {
        Some(crate::encode::pcm_sidecar_path(path))
    } else {
        None
    };
    match open_encoder(
        path,
        session.width,
        session.height,
        session.fps,
        session.bitrate,
        with_aac,
        pcm_path.as_deref(),
    ) {
        Ok(encoder) => Ok(encoder),
        Err(err) if with_aac => {
            tracing::warn!("encoder with AAC failed ({err}); retrying without AAC");
            open_encoder(
                path,
                session.width,
                session.height,
                session.fps,
                session.bitrate,
                false,
                pcm_path.as_deref(),
            )
        }
        Err(err) => Err(err),
    }
}

fn open_encoder(
    path: &Path,
    width: u32,
    height: u32,
    fps: u32,
    bitrate: u32,
    with_audio: bool,
    pcm_path: Option<&Path>,
) -> Result<MfWriter, String> {
    let fps = fps.min(60).max(24);
    let attempts = [(width, height), (1920, 1080), (1280, 720)];
    let mut last = String::from("Could not create the Media Foundation encoder.");
    for (width, height) in attempts {
        match MfWriter::new(path, width, height, fps, bitrate, with_audio, pcm_path) {
            Ok(encoder) => {
                tracing::info!(
                    "MF encoder ready {width}x{height} @ {fps} aac={with_audio} pcm={}",
                    pcm_path.is_some()
                );
                return Ok(encoder);
            }
            Err(err) => {
                last = err;
                tracing::warn!("MF encoder {width}x{height} aac={with_audio} failed: {last}");
            }
        }
    }
    Err(last)
}
