//! Observational gameplay preview. Never owns SessionClock, the encoder,
//! Instant Replay, or audio. Failure here must not touch capture.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::still::{scale_bgra_area, StillFrame};

#[cfg(windows)]
mod standalone;
#[cfg(windows)]
pub(crate) mod layers;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerPreviewHeader {
    pub width: u32,
    pub height: u32,
    pub frame_id: u64,
    pub mime_type: &'static str,
}

impl LayerPreviewHeader {
    pub fn empty(frame_id: u64) -> Self {
        Self { width: 0, height: 0, frame_id, mime_type: "image/jpeg" }
    }
}

/// Default Live Output Preview knobs (Balanced). Overridden via `PreviewHub::apply_quality`.
const DEFAULT_PREVIEW_MAX_WIDTH: u32 = 1280;
const DEFAULT_PREVIEW_INTERVAL_MS: u64 = 33;
const DEFAULT_PREVIEW_JPEG_QUALITY: u8 = 90;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreviewQuality {
    Full,
    Balanced,
    Performance,
}

impl PreviewQuality {
    pub fn parse(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "full" => Self::Full,
            "performance" => Self::Performance,
            _ => Self::Balanced,
        }
    }

    pub fn max_width(self) -> u32 {
        match self {
            Self::Full => 2560,
            Self::Balanced => 1280,
            Self::Performance => 960,
        }
    }

    /// Full and Balanced follow a 60 fps recording. Performance stays near 25 fps.
    pub fn interval_ms_for(self, fps: u32) -> u64 {
        match self {
            Self::Performance => 40,
            _ if fps >= 60 => 16,
            _ => 33,
        }
    }

    pub fn jpeg_quality(self) -> u8 {
        match self {
            Self::Full => 95,
            Self::Performance => 85,
            Self::Balanced => 90,
        }
    }

    /// Composed tap dest size from canvas. Full matches the output, capped at a 2560 long edge.
    pub fn composed_size(self, out_w: u32, out_h: u32) -> (u32, u32) {
        let out_w = out_w.max(2);
        let out_h = out_h.max(2);
        match self {
            Self::Balanced => fit_within(out_w, out_h, 1280, 720),
            Self::Performance => fit_within(out_w, out_h, 960, 540),
            Self::Full => fit_within(out_w, out_h, 2560, 2560),
        }
    }
}

fn fit_within(width: u32, height: u32, max_w: u32, max_h: u32) -> (u32, u32) {
    if width <= max_w && height <= max_h {
        return (width & !1, height & !1);
    }
    let scale = (max_w as f64 / width as f64).min(max_h as f64 / height as f64);
    let w = ((width as f64) * scale).round().max(2.0) as u32;
    let h = ((height as f64) * scale).round().max(2.0) as u32;
    (w & !1, h & !1)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreviewMode {
    Game,
    Desktop,
    Window,
}

impl PreviewMode {
    pub fn parse(value: &str) -> Self {
        if value.eq_ignore_ascii_case("desktop") {
            Self::Desktop
        } else if value.eq_ignore_ascii_case("window") {
            Self::Window
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
    pub frame_id: u64,
    /// Preview transport MIME (`image/jpeg` or `image/png`). Recording is unaffected.
    pub mime_type: String,
}

#[derive(Clone)]
pub struct PreviewHub {
    inner: Arc<Inner>,
}

struct Inner {
    wanted: AtomicU32,
    capture_live: AtomicBool,
    composed_live: AtomicBool,
    stop_worker: AtomicBool,
    last_accept_ms: AtomicU64,
    offered: AtomicU64,
    dropped: AtomicU64,
    encoded: AtomicU64,
    last_encode_ms: AtomicU64,
    last_pack_us: AtomicU64,
    last_compress_us: AtomicU64,
    last_scale_us: AtomicU64,
    max_compress_us: AtomicU64,
    max_scale_us: AtomicU64,
    next_frame_id: AtomicU64,
    max_width: AtomicU32,
    min_interval_ms: AtomicU64,
    jpeg_quality: AtomicU32,
    mode: Mutex<PreviewMode>,
    pid: Mutex<Option<u32>>,
    monitor_id: Mutex<Option<String>>,
    window: Mutex<crate::capture_windows::WindowTarget>,
    pending: Mutex<Option<StillFrame>>,
    latest: Mutex<Option<EncodedPreview>>,
    error: Mutex<Option<String>>,
    cv: Condvar,
    /// Signalled whenever `latest` holds a new frame.
    frame_cv: Condvar,
    worker: Mutex<Option<JoinHandle<()>>>,
    #[cfg(windows)]
    standalone: Mutex<Option<standalone::StandalonePreview>>,
}

#[derive(Clone)]
struct EncodedPreview {
    bytes: Arc<[u8]>,
    width: u32,
    height: u32,
    frame_id: u64,
    mime_type: &'static str,
}

/// Frame metadata sent ahead of the JPEG bytes on the binary preview channel.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewFrameHeader {
    pub width: u32,
    pub height: u32,
    pub state: String,
    pub label: String,
    pub source: String,
    pub frame_id: u64,
    pub mime_type: String,
}

pub struct PreviewFrameBytes {
    pub header: PreviewFrameHeader,
    /// Present only when the frame is newer than the caller's `after` id.
    pub bytes: Option<Arc<[u8]>>,
}

impl PreviewHub {
    pub fn new() -> Self {
        let inner = Arc::new(Inner {
            wanted: AtomicU32::new(0),
            capture_live: AtomicBool::new(false),
            composed_live: AtomicBool::new(false),
            stop_worker: AtomicBool::new(false),
            last_accept_ms: AtomicU64::new(0),
            offered: AtomicU64::new(0),
            dropped: AtomicU64::new(0),
            encoded: AtomicU64::new(0),
            last_encode_ms: AtomicU64::new(0),
            last_pack_us: AtomicU64::new(0),
            last_compress_us: AtomicU64::new(0),
            last_scale_us: AtomicU64::new(0),
            max_compress_us: AtomicU64::new(0),
            max_scale_us: AtomicU64::new(0),
            next_frame_id: AtomicU64::new(1),
            max_width: AtomicU32::new(DEFAULT_PREVIEW_MAX_WIDTH),
            min_interval_ms: AtomicU64::new(DEFAULT_PREVIEW_INTERVAL_MS),
            jpeg_quality: AtomicU32::new(u32::from(DEFAULT_PREVIEW_JPEG_QUALITY)),
            mode: Mutex::new(PreviewMode::Game),
            pid: Mutex::new(None),
            monitor_id: Mutex::new(None),
            window: Mutex::new(crate::capture_windows::WindowTarget::default()),
            pending: Mutex::new(None),
            latest: Mutex::new(None),
            error: Mutex::new(None),
            cv: Condvar::new(),
            frame_cv: Condvar::new(),
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

    pub fn retain(
        &self,
        mode: PreviewMode,
        pid: Option<u32>,
        monitor_id: Option<String>,
        window: crate::capture_windows::WindowTarget,
    ) {
        self.set_target(mode, pid, monitor_id, window);
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

    pub fn set_target(
        &self,
        mode: PreviewMode,
        pid: Option<u32>,
        monitor_id: Option<String>,
        window: crate::capture_windows::WindowTarget,
    ) {
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
        if let Ok(mut slot) = self.inner.monitor_id.lock() {
            if *slot != monitor_id {
                *slot = monitor_id;
                changed = true;
            }
        }
        if let Ok(mut slot) = self.inner.window.lock() {
            if *slot != window {
                *slot = window;
                changed = true;
            }
        }
        if changed {
            self.clear_frames();
            tracing::info!(
                monitor = self.inner.monitor_id.lock().ok().and_then(|slot| slot.clone()).as_deref().unwrap_or("primary"),
                "capture preview target changed"
            );
        }
        if changed && self.wanted() && !self.capture_live() && !self.composed_live() {
            self.ensure_source_replaced();
        }
    }

    fn clear_frames(&self) {
        if let Ok(mut slot) = self.inner.latest.lock() {
            *slot = None;
        }
        if let Ok(mut slot) = self.inner.pending.lock() {
            *slot = None;
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
        } else if self.wanted() && !self.composed_live() {
            self.ensure_source();
        }
    }

    pub fn mark_composed_live(&self, live: bool) {
        self.inner.composed_live.store(live, Ordering::SeqCst);
        if live {
            self.suspend_standalone();
        } else if self.wanted() && !self.capture_live() {
            self.ensure_source();
        }
    }

    pub fn apply_quality(&self, quality: &str, fps: u32) {
        let parsed = PreviewQuality::parse(quality);
        let interval_ms = parsed.interval_ms_for(fps);
        self.inner
            .max_width
            .store(parsed.max_width(), Ordering::Relaxed);
        self.inner
            .min_interval_ms
            .store(interval_ms, Ordering::Relaxed);
        self.inner
            .jpeg_quality
            .store(u32::from(parsed.jpeg_quality()), Ordering::Relaxed);
        tracing::info!(
            quality = ?parsed,
            fps,
            max_width = parsed.max_width(),
            interval_ms,
            jpeg_quality = parsed.jpeg_quality(),
            "capture preview quality applied"
        );
    }

    pub fn min_interval_ms(&self) -> u64 {
        self.inner
            .min_interval_ms
            .load(Ordering::Relaxed)
            .max(16)
    }

    pub fn resume_if_wanted(&self) {
        if self.wanted() && !self.capture_live() && !self.composed_live() {
            self.ensure_source();
        }
    }

    pub fn should_accept(&self) -> bool {
        if !self.wanted() {
            return false;
        }
        let now_ms = preview_now_ms();
        let last = self.inner.last_accept_ms.load(Ordering::Relaxed);
        if now_ms.saturating_sub(last) < self.min_interval_ms() {
            return false;
        }
        self.inner
            .pending
            .lock()
            .ok()
            .map(|pending| pending.is_none())
            .unwrap_or(false)
    }

    pub fn offer(&self, frame: StillFrame) {
        if !self.should_accept() {
            if self.wanted() {
                self.inner.dropped.fetch_add(1, Ordering::Relaxed);
            }
            return;
        }
        if let Ok(mut pending) = self.inner.pending.lock() {
            if pending.is_some() {
                self.inner.dropped.fetch_add(1, Ordering::Relaxed);
                return;
            }
            *pending = Some(frame);
            self.inner.last_accept_ms.store(preview_now_ms(), Ordering::Relaxed);
            self.inner.offered.fetch_add(1, Ordering::Relaxed);
        }
        self.inner.cv.notify_one();
    }

    pub fn snapshot(&self) -> CapturePreviewFrame {
        let latest = self.inner.latest.lock().ok().and_then(|slot| slot.clone());
        let header = self.header_for(latest.as_ref());
        CapturePreviewFrame {
            png_base64: latest.map(|frame| crate::camera::color::base64_encode(&frame.bytes)),
            width: header.width,
            height: header.height,
            state: header.state,
            label: header.label,
            source: header.source,
            frame_id: header.frame_id,
            mime_type: header.mime_type,
        }
    }

    /// Blocks until a frame newer than `after` is encoded, or `timeout` passes.
    /// The header is always current; bytes come back only for a newer frame.
    pub fn wait_frame(&self, after: u64, timeout: Duration) -> PreviewFrameBytes {
        let deadline = Instant::now() + timeout;
        let latest = (|| {
            let mut slot = self.inner.latest.lock().ok()?;
            loop {
                if slot.as_ref().is_some_and(|frame| frame.frame_id > after) {
                    break;
                }
                let now = Instant::now();
                if now >= deadline || self.inner.stop_worker.load(Ordering::SeqCst) {
                    break;
                }
                slot = self.inner.frame_cv.wait_timeout(slot, deadline - now).ok()?.0;
            }
            slot.clone()
        })();
        let header = self.header_for(latest.as_ref());
        let bytes = latest
            .filter(|frame| frame.frame_id > after)
            .map(|frame| frame.bytes);
        PreviewFrameBytes { header, bytes }
    }

    fn header_for(&self, latest: Option<&EncodedPreview>) -> PreviewFrameHeader {
        let mode = self.inner.mode.lock().ok().map(|slot| *slot).unwrap_or(PreviewMode::Game);
        let pid = self.inner.pid.lock().ok().and_then(|slot| *slot);
        let capture_live = self.capture_live();
        let source = if self.composed_live() {
            "composed"
        } else if capture_live {
            "tap"
        } else if self.standalone_active() {
            "standalone"
        } else {
            "none"
        };
        let empty = |state: &str, label: String, source: &str| PreviewFrameHeader {
            width: 0,
            height: 0,
            state: state.into(),
            label,
            source: source.into(),
            frame_id: 0,
            mime_type: "image/jpeg".into(),
        };
        if let Some(frame) = latest {
            let desktop = mode == PreviewMode::Desktop && !capture_live && !self.composed_live();
            return PreviewFrameHeader {
                width: frame.width,
                height: frame.height,
                state: if desktop { "desktop".into() } else { "live".into() },
                label: if desktop { "Desktop Preview".into() } else { "Live".into() },
                source: source.into(),
                frame_id: frame.frame_id,
                mime_type: frame.mime_type.into(),
            };
        }
        if !self.wanted() {
            return empty("unavailable", "Preview unavailable".into(), "none");
        }
        if mode == PreviewMode::Game && pid.unwrap_or(0) == 0 && !capture_live {
            return empty("waiting", "Waiting for game".into(), source);
        }
        let error = self.inner.error.lock().ok().and_then(|slot| slot.clone());
        empty(
            "unavailable",
            error.unwrap_or_else(|| "Preview unavailable".into()),
            source,
        )
    }

    pub(crate) fn wanted(&self) -> bool {
        self.inner.wanted.load(Ordering::SeqCst) > 0
    }

    fn capture_live(&self) -> bool {
        self.inner.capture_live.load(Ordering::SeqCst)
    }

    fn composed_live(&self) -> bool {
        self.inner.composed_live.load(Ordering::SeqCst)
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
        self.open_standalone(false);
    }

    /// Drop the running standalone session before starting, so a monitor change cannot keep the previous display.
    fn ensure_source_replaced(&self) {
        self.suspend_standalone();
        self.open_standalone(true);
    }

    fn open_standalone(&self, replace: bool) {
        if !self.wanted() || self.capture_live() || self.composed_live() {
            return;
        }
        let mode = self.inner.mode.lock().ok().map(|slot| *slot).unwrap_or(PreviewMode::Game);
        let pid = self.inner.pid.lock().ok().and_then(|slot| *slot);
        let monitor_id = self.inner.monitor_id.lock().ok().and_then(|slot| slot.clone());
        let window = self.inner.window.lock().ok().map(|slot| slot.clone()).unwrap_or_default();
        if mode == PreviewMode::Game && pid.unwrap_or(0) == 0 {
            self.suspend_standalone();
            return;
        }
        if mode == PreviewMode::Window && window.is_empty() {
            self.suspend_standalone();
            return;
        }
        #[cfg(windows)]
        {
            if !replace && self.standalone_active() {
                return;
            }
            if replace {
                self.suspend_standalone();
            }
            match standalone::StandalonePreview::start(self.clone(), mode, pid, monitor_id.as_deref(), &window) {
                Ok(session) => {
                    tracing::info!(
                        mode = ?mode,
                        pid = ?pid,
                        monitor = monitor_id.as_deref().unwrap_or("primary"),
                        "capture preview standalone started"
                    );
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
            let _ = (mode, pid, monitor_id, window, replace);
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
        let frame_id = inner.next_frame_id.fetch_add(1, Ordering::Relaxed);
        let jpeg_quality = inner.jpeg_quality.load(Ordering::Relaxed).clamp(1, 100) as u8;
        let max_width = inner.max_width.load(Ordering::Relaxed).max(2);
        let interval_ms = inner.min_interval_ms.load(Ordering::Relaxed);
        let scale_started = Instant::now();
        let frame = if frame.width > max_width {
            scale_bgra_area(&frame, max_width)
        } else {
            frame
        };
        let scale_us = scale_started.elapsed().as_micros() as u64;
        match encode_preview_image(&frame, frame_id, jpeg_quality) {
            Ok((encoded, pack_us, compress_us)) => {
                if let Ok(mut latest) = inner.latest.lock() {
                    *latest = Some(encoded);
                }
                inner.frame_cv.notify_all();
                if let Ok(mut error) = inner.error.lock() {
                    *error = None;
                }
                let encoded_n = inner.encoded.fetch_add(1, Ordering::Relaxed) + 1;
                let encode_ms = started.elapsed().as_millis() as u64;
                inner.last_encode_ms.store(encode_ms, Ordering::Relaxed);
                inner.last_pack_us.store(pack_us, Ordering::Relaxed);
                inner.last_compress_us.store(compress_us, Ordering::Relaxed);
                inner.last_scale_us.store(scale_us, Ordering::Relaxed);
                atomic_max(&inner.max_compress_us, compress_us);
                atomic_max(&inner.max_scale_us, scale_us);
                if encoded_n == 1 || encoded_n % 120 == 0 {
                    tracing::info!(
                        offered = inner.offered.load(Ordering::Relaxed),
                        dropped = inner.dropped.load(Ordering::Relaxed),
                        encoded = encoded_n,
                        encode_ms,
                        scale_us,
                        pack_us,
                        compress_us,
                        max_compress_us = inner.max_compress_us.load(Ordering::Relaxed),
                        max_scale_us = inner.max_scale_us.load(Ordering::Relaxed),
                        preview_max_width = max_width,
                        interval_ms,
                        codec = "jpeg",
                        jpeg_quality,
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

fn encode_preview_image(
    frame: &StillFrame,
    frame_id: u64,
    jpeg_quality: u8,
) -> Result<(EncodedPreview, u64, u64), String> {
    let pack_started = Instant::now();
    let packed = pack_preview_bgra(frame);
    let pack_us = pack_started.elapsed().as_micros() as u64;
    let compress_started = Instant::now();
    let jpeg = crate::camera::color::encode_jpeg_bgra_quality(
        &packed,
        frame.width,
        frame.height,
        jpeg_quality,
    )?;
    let compress_us = compress_started.elapsed().as_micros() as u64;
    Ok((
        EncodedPreview {
            bytes: Arc::from(jpeg),
            width: frame.width,
            height: frame.height,
            frame_id,
            mime_type: "image/jpeg",
        },
        pack_us,
        compress_us,
    ))
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

fn atomic_max(slot: &AtomicU64, value: u64) {
    let mut cur = slot.load(Ordering::Relaxed);
    while value > cur {
        match slot.compare_exchange_weak(cur, value, Ordering::Relaxed, Ordering::Relaxed) {
            Ok(_) => break,
            Err(next) => cur = next,
        }
    }
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
        hub.offer(other);
        assert!(hub.inner.pending.lock().expect("pending").is_some());
        assert_eq!(hub.inner.dropped.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn interval_follows_a_sixty_fps_recording() {
        assert_eq!(PreviewQuality::Full.interval_ms_for(60), 16);
        assert_eq!(PreviewQuality::Balanced.interval_ms_for(60), 16);
        assert_eq!(PreviewQuality::Balanced.interval_ms_for(30), 33);
        assert_eq!(PreviewQuality::Performance.interval_ms_for(60), 40);
    }

    #[test]
    fn offer_queues_the_full_frame_for_the_worker_to_scale() {
        let hub = PreviewHub::new();
        hub.inner.stop_worker.store(true, Ordering::SeqCst);
        hub.inner.wanted.store(1, Ordering::SeqCst);
        hub.inner.max_width.store(2, Ordering::Relaxed);
        hub.inner.last_accept_ms.store(0, Ordering::Relaxed);
        let wide = StillFrame {
            bgra: vec![0; 8 * 2 * 4],
            width: 8,
            height: 2,
            pitch: 32,
        };
        hub.offer(wide);
        let pending = hub.inner.pending.lock().expect("pending");
        assert_eq!(pending.as_ref().map(|frame| frame.width), Some(8));
    }

    #[test]
    fn wait_frame_returns_bytes_only_for_a_newer_frame() {
        let hub = PreviewHub::new();
        hub.inner.wanted.store(1, Ordering::SeqCst);
        *hub.inner.latest.lock().expect("latest") = Some(EncodedPreview {
            bytes: Arc::from(vec![1_u8, 2, 3]),
            width: 4,
            height: 2,
            frame_id: 7,
            mime_type: "image/jpeg",
        });
        let fresh = hub.wait_frame(6, Duration::from_millis(5));
        assert_eq!(fresh.header.frame_id, 7);
        assert_eq!(fresh.bytes.as_deref(), Some(&[1_u8, 2, 3][..]));

        let started = Instant::now();
        let same = hub.wait_frame(7, Duration::from_millis(30));
        assert!(started.elapsed() >= Duration::from_millis(25));
        assert_eq!(same.header.frame_id, 7);
        assert!(same.bytes.is_none());
    }

    #[test]
    fn wait_frame_wakes_when_a_frame_lands() {
        let hub = PreviewHub::new();
        hub.inner.wanted.store(1, Ordering::SeqCst);
        let writer = hub.clone();
        let handle = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            *writer.inner.latest.lock().expect("latest") = Some(EncodedPreview {
                bytes: Arc::from(vec![9_u8]),
                width: 1,
                height: 1,
                frame_id: 3,
                mime_type: "image/jpeg",
            });
            writer.inner.frame_cv.notify_all();
        });
        let started = Instant::now();
        let got = hub.wait_frame(0, Duration::from_secs(2));
        handle.join().expect("writer");
        assert!(started.elapsed() < Duration::from_secs(1));
        assert_eq!(got.header.frame_id, 3);
        assert!(got.bytes.is_some());
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
        hub.offer(frame);
        let pending = hub.inner.pending.lock().expect("pending");
        assert!(pending.is_none());
    }

    #[test]
    fn composed_preview_box_keeps_output_aspect() {
        let (w, h) = PreviewQuality::Balanced.composed_size(3440, 1440);
        assert!(w <= 1280 && h <= 720);
        assert!(w > 2 && h > 2);
        let aspect = w as f64 / h as f64;
        assert!((aspect - (3440.0 / 1440.0)).abs() < 0.03, "{w}x{h}");

        let (pw, ph) = PreviewQuality::Performance.composed_size(1080, 1920);
        assert!(pw <= 960 && ph <= 540);
        let portrait = pw as f64 / ph as f64;
        assert!((portrait - (1080.0 / 1920.0)).abs() < 0.03, "{pw}x{ph}");

        let (fw, fh) = PreviewQuality::Full.composed_size(3440, 1440);
        assert!(fw <= 2560 && fh <= 2560);
        assert!(fw.max(fh) <= 2560);
        let full_aspect = fw as f64 / fh as f64;
        assert!((full_aspect - (3440.0 / 1440.0)).abs() < 0.03, "{fw}x{fh}");

        assert_eq!(PreviewQuality::Full.composed_size(1920, 1080), (1920, 1080));
    }
}
