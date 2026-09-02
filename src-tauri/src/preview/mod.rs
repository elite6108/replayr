//! Observational gameplay preview. Never owns SessionClock, the encoder,
//! Instant Replay, or audio. Failure here must not touch capture.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::still::{scale_bgra, StillFrame};

#[cfg(windows)]
mod standalone;

const PREVIEW_MAX_WIDTH: u32 = 854;
const PREVIEW_MIN_INTERVAL: Duration = Duration::from_millis(66);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreviewMode {
    Game,
    Desktop,
}

impl PreviewMode {
    pub fn parse(value: &str) -> Self {
        if value.eq_ignore_ascii_case("desktop") {
            Self::Desktop
        } else {
            Self::Game
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapturePreviewFrame {
    pub png_base64: Option<String>,
    pub width: u32,
    pub height: u32,
    pub state: String,
    pub label: String,
    pub source: String,
}

#[derive(Clone)]
pub struct PreviewHub {
    inner: Arc<Inner>,
}

struct Inner {
    wanted: AtomicU32,
    capture_live: AtomicBool,
    stop_worker: AtomicBool,
    last_accept_ms: AtomicU64,
    offered: AtomicU64,
    dropped: AtomicU64,
    encoded: AtomicU64,
    last_encode_ms: AtomicU64,
    mode: Mutex<PreviewMode>,
    pid: Mutex<Option<u32>>,
    pending: Mutex<Option<StillFrame>>,
    latest: Mutex<Option<EncodedPreview>>,
    error: Mutex<Option<String>>,
    cv: Condvar,
    worker: Mutex<Option<JoinHandle<()>>>,
    #[cfg(windows)]
    standalone: Mutex<Option<standalone::StandalonePreview>>,
}

struct EncodedPreview {
    png_base64: String,
    width: u32,
    height: u32,
}

impl PreviewHub {
    pub fn new() -> Self {
        let inner = Arc::new(Inner {
            wanted: AtomicU32::new(0),
            capture_live: AtomicBool::new(false),
            stop_worker: AtomicBool::new(false),
            last_accept_ms: AtomicU64::new(0),
            offered: AtomicU64::new(0),
            dropped: AtomicU64::new(0),
            encoded: AtomicU64::new(0),
            last_encode_ms: AtomicU64::new(0),
            mode: Mutex::new(PreviewMode::Game),
            pid: Mutex::new(None),
            pending: Mutex::new(None),
            latest: Mutex::new(None),
            error: Mutex::new(None),
            cv: Condvar::new(),
            worker: Mutex::new(None),
            #[cfg(windows)]
            standalone: Mutex::new(None),
        });
        let worker_inner = Arc::clone(&inner);
        if let Ok(handle) = std::thread::Builder::new()
            .name("capture-preview".into())
            .spawn(move || encode_loop(worker_inner))
        {
            if let Ok(mut slot) = inner.worker.lock() {
                *slot = Some(handle);
            }
        }
        Self { inner }
    }

    pub fn retain(&self, mode: PreviewMode, pid: Option<u32>) {
        self.set_target(mode, pid);
        let previous = self.inner.wanted.swap(1, Ordering::SeqCst);
        tracing::info!(
            mode = ?mode,
            pid = ?pid,
            capture_live = self.capture_live(),
            "capture preview retained"
        );
        if previous == 0 {
            self.ensure_source();
        }
    }

    pub fn release(&self) {
        let previous = self.inner.wanted.swap(0, Ordering::SeqCst);
        if previous > 0 {
            self.suspend_standalone();
            tracing::info!("capture preview released");
        }
    }

    pub fn set_target(&self, mode: PreviewMode, pid: Option<u32>) {
        let mut changed = false;
        if let Ok(mut slot) = self.inner.mode.lock() {
            if *slot != mode {
                *slot = mode;
                changed = true;
            }
        }
        if let Ok(mut slot) = self.inner.pid.lock() {
            if *slot != pid {
                *slot = pid;
                changed = true;
            }
        }
        if changed && self.wanted() && !self.capture_live() {
            self.suspend_standalone();
            self.ensure_source();
        }
    }

    pub fn suspend_standalone(&self) {
        #[cfg(windows)]
        {
            if let Ok(mut slot) = self.inner.standalone.lock() {
                if let Some(session) = slot.take() {
                    session.stop();
                }
            }
        }
    }

    pub fn mark_capture_live(&self, live: bool) {
        self.inner.capture_live.store(live, Ordering::SeqCst);
        if live {
            self.suspend_standalone();
        } else if self.wanted() {
            self.ensure_source();
        }
    }

    pub fn resume_if_wanted(&self) {
        if self.wanted() && !self.capture_live() {
            self.ensure_source();
        }
    }

    pub fn should_accept(&self) -> bool {
        if !self.wanted() {
            return false;
        }
        let now_ms = preview_now_ms();
        let last = self.inner.last_accept_ms.load(Ordering::Relaxed);
        if now_ms.saturating_sub(last) < PREVIEW_MIN_INTERVAL.as_millis() as u64 {
            return false;
        }
        self.inner
            .pending
            .lock()
            .ok()
            .map(|pending| pending.is_none())
            .unwrap_or(false)
    }

    pub fn offer(&self, frame: &StillFrame) {
        if !self.should_accept() {
            if self.wanted() {
                self.inner.dropped.fetch_add(1, Ordering::Relaxed);
            }
            return;
        }
        let scaled = scale_bgra(frame, PREVIEW_MAX_WIDTH);
        if let Ok(mut pending) = self.inner.pending.lock() {
            if pending.is_some() {
                self.inner.dropped.fetch_add(1, Ordering::Relaxed);
                return;
            }
            *pending = Some(scaled);
            self.inner.last_accept_ms.store(preview_now_ms(), Ordering::Relaxed);
            self.inner.offered.fetch_add(1, Ordering::Relaxed);
        }
        self.inner.cv.notify_one();
    }

    pub fn snapshot(&self) -> CapturePreviewFrame {
        let latest = self.inner.latest.lock().ok().and_then(|slot| slot.clone());
        let mode = self.inner.mode.lock().ok().map(|slot| *slot).unwrap_or(PreviewMode::Game);
        let pid = self.inner.pid.lock().ok().and_then(|slot| *slot);
        let error = self.inner.error.lock().ok().and_then(|slot| slot.clone());
        let capture_live = self.capture_live();
        let wanted = self.wanted();
        let source = if capture_live {
            "tap"
        } else if self.standalone_active() {
            "standalone"
        } else {
            "none"
        };
        if let Some(frame) = latest {
            let desktop = mode == PreviewMode::Desktop && !capture_live;
            return CapturePreviewFrame {
                png_base64: Some(frame.png_base64),
                width: frame.width,
                height: frame.height,
                state: if desktop { "desktop".into() } else { "live".into() },
                label: if desktop { "Desktop Preview".into() } else { "Live".into() },
                source: source.into(),
            };
        }
        if !wanted {
            return CapturePreviewFrame {
                png_base64: None,
                width: 0,
                height: 0,
                state: "unavailable".into(),
                label: "Preview unavailable".into(),
                source: "none".into(),
            };
        }
        if mode == PreviewMode::Game && pid.unwrap_or(0) == 0 && !capture_live {
            return CapturePreviewFrame {
                png_base64: None,
                width: 0,
                height: 0,
                state: "waiting".into(),
                label: "Waiting for game".into(),
                source: source.into(),
            };
        }
        CapturePreviewFrame {
            png_base64: None,
            width: 0,
            height: 0,
            state: "unavailable".into(),
            label: error.unwrap_or_else(|| "Preview unavailable".into()),
            source: source.into(),
        }
    }

    fn wanted(&self) -> bool {
        self.inner.wanted.load(Ordering::SeqCst) > 0
    }

    fn capture_live(&self) -> bool {
        self.inner.capture_live.load(Ordering::SeqCst)
    }

    fn standalone_active(&self) -> bool {
        #[cfg(windows)]
        {
            self.inner
                .standalone
                .lock()
                .ok()
                .map(|slot| slot.is_some())
                .unwrap_or(false)
        }
        #[cfg(not(windows))]
        {
            false
        }
    }

    fn ensure_source(&self) {
        if !self.wanted() || self.capture_live() {
            return;
        }
        let mode = self.inner.mode.lock().ok().map(|slot| *slot).unwrap_or(PreviewMode::Game);
        let pid = self.inner.pid.lock().ok().and_then(|slot| *slot);
        if mode == PreviewMode::Game && pid.unwrap_or(0) == 0 {
            self.suspend_standalone();
            return;
        }
        #[cfg(windows)]
        {
            if self.standalone_active() {
                return;
            }
            match standalone::StandalonePreview::start(self.clone(), mode, pid) {
                Ok(session) => {
                    tracing::info!(mode = ?mode, pid = ?pid, "capture preview standalone started");
                    if let Ok(mut slot) = self.inner.error.lock() {
                        *slot = None;
                    }
                    if let Ok(mut slot) = self.inner.standalone.lock() {
                        *slot = Some(session);
                    }
                }
                Err(err) => {
                    tracing::warn!("capture preview standalone failed: {err}");
                    if let Ok(mut slot) = self.inner.error.lock() {
                        *slot = Some("Preview unavailable".into());
                    }
                }
            }
        }
        #[cfg(not(windows))]
        {
            let _ = (mode, pid);
            if let Ok(mut slot) = self.inner.error.lock() {
                *slot = Some("Preview unavailable".into());
            }
        }
    }
}

impl Default for PreviewHub {
    fn default() -> Self {
        Self::new()
    }
}

impl Clone for EncodedPreview {
    fn clone(&self) -> Self {
        Self {
            png_base64: self.png_base64.clone(),
            width: self.width,
            height: self.height,
        }
    }
}

fn encode_loop(inner: Arc<Inner>) {
    while !inner.stop_worker.load(Ordering::SeqCst) {
        let frame = {
            let Ok(mut pending) = inner.pending.lock() else {
                break;
            };
            loop {
                if let Some(frame) = pending.take() {
                    break Some(frame);
                }
                if inner.stop_worker.load(Ordering::SeqCst) {
                    break None;
                }
                pending = match inner.cv.wait_timeout(pending, Duration::from_millis(250)) {
                    Ok((guard, _)) => guard,
                    Err(_) => break None,
                };
            }
        };
        let Some(frame) = frame else {
            continue;
        };
        let started = Instant::now();
        match encode_preview_png(&frame) {
            Ok(encoded) => {
                if let Ok(mut latest) = inner.latest.lock() {
                    *latest = Some(encoded);
                }
                if let Ok(mut error) = inner.error.lock() {
                    *error = None;
                }
                let encoded = inner.encoded.fetch_add(1, Ordering::Relaxed) + 1;
                let encode_ms = started.elapsed().as_millis() as u64;
                inner.last_encode_ms.store(encode_ms, Ordering::Relaxed);
                if encoded == 1 || encoded % 120 == 0 {
                    tracing::info!(
                        offered = inner.offered.load(Ordering::Relaxed),
                        dropped = inner.dropped.load(Ordering::Relaxed),
                        encoded,
                        encode_ms,
                        "capture preview stats"
                    );
                }
            }
            Err(err) => {
                tracing::warn!("capture preview encode failed: {err}");
                if let Ok(mut error) = inner.error.lock() {
                    *error = Some("Preview unavailable".into());
                }
            }
        }
    }
}

fn encode_preview_png(frame: &StillFrame) -> Result<EncodedPreview, String> {
    let packed = pack_preview_bgra(frame);
    let png = crate::camera::color::encode_png_bgra(&packed, frame.width, frame.height)?;
    Ok(EncodedPreview {
        png_base64: crate::camera::color::base64_encode(&png),
        width: frame.width,
        height: frame.height,
    })
}

fn pack_preview_bgra(frame: &StillFrame) -> Vec<u8> {
    let stride = frame.width.saturating_mul(4);
    if frame.pitch == stride || frame.width == 0 || frame.height == 0 {
        return frame.bgra.clone();
    }
    let mut packed = vec![0_u8; (stride * frame.height) as usize];
    for y in 0..frame.height {
        let src = (y * frame.pitch) as usize;
        let dst = (y * stride) as usize;
        let end = src + stride as usize;
        if end <= frame.bgra.len() && dst + stride as usize <= packed.len() {
            packed[dst..dst + stride as usize].copy_from_slice(&frame.bgra[src..end]);
        }
    }
    packed
}

fn preview_now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn latest_pending_frame_replaces_and_capacity_stays_one() {
        let hub = PreviewHub::new();
        hub.inner.wanted.store(1, Ordering::SeqCst);
        let small = StillFrame {
            bgra: vec![10, 20, 30, 255],
            width: 1,
            height: 1,
            pitch: 4,
        };
        let other = StillFrame {
            bgra: vec![40, 50, 60, 255],
            width: 1,
            height: 1,
            pitch: 4,
        };
        if let Ok(mut pending) = hub.inner.pending.lock() {
            *pending = Some(small);
        }
        hub.inner.last_accept_ms.store(0, Ordering::Relaxed);
        hub.offer(&other);
        assert!(hub.inner.pending.lock().expect("pending").is_some());
        assert_eq!(hub.inner.dropped.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn unwanted_preview_never_queues_a_frame() {
        let hub = PreviewHub::new();
        let frame = StillFrame {
            bgra: vec![1, 2, 3, 255],
            width: 1,
            height: 1,
            pitch: 4,
        };
        hub.offer(&frame);
        let pending = hub.inner.pending.lock().expect("pending");
        assert!(pending.is_none());
    }
}
