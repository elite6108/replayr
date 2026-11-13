//! Preview for display and window layers that are not the recording base.
//! The base keeps `PreviewHub`. These sessions never touch the encoder.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use crate::capture_windows::{sanitize_target, WindowTarget};
use crate::recording_compositor::scene::CaptureKind;
use crate::recording_compositor::sources::capture::ComposedCapture;

use super::LayerPreviewHeader;

struct Slot {
    header: Mutex<LayerPreviewHeader>,
    jpeg: Mutex<Arc<[u8]>>,
    ready: Condvar,
}

impl Slot {
    fn new() -> Self {
        Self {
            header: Mutex::new(LayerPreviewHeader::empty(0)),
            jpeg: Mutex::new(Arc::from([])),
            ready: Condvar::new(),
        }
    }

    fn publish(&self, width: u32, height: u32, jpeg: Vec<u8>) {
        let frame_id = self.header.lock().map(|header| header.frame_id.saturating_add(1)).unwrap_or(1);
        if let Ok(mut header) = self.header.lock() {
            *header = LayerPreviewHeader { width, height, frame_id, mime_type: "image/jpeg" };
        }
        if let Ok(mut bytes) = self.jpeg.lock() {
            *bytes = Arc::from(jpeg.into_boxed_slice());
        }
        self.ready.notify_all();
    }

    fn wait(&self, after: u64, timeout: Duration) -> (LayerPreviewHeader, Option<Arc<[u8]>>) {
        let Ok(header) = self.header.lock() else {
            return (LayerPreviewHeader::empty(after), None);
        };
        let header = if header.frame_id > after {
            header.clone()
        } else {
            self.ready.wait_timeout(header, timeout).map(|(header, _)| header.clone()).unwrap_or_else(|err| err.into_inner().0.clone())
        };
        if header.frame_id <= after || header.width == 0 {
            return (header, None);
        }
        let bytes = self.jpeg.lock().ok().map(|slot| Arc::clone(&slot));
        (header, bytes)
    }
}

struct Session {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
    slot: Arc<Slot>,
}

impl Drop for Session {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

#[derive(Clone)]
pub struct LayerPreviewHub {
    inner: Arc<LayerInner>,
}

struct LayerInner {
    sessions: Mutex<HashMap<String, Session>>,
    frame: AtomicU64,
}

impl LayerPreviewHub {
    pub fn new() -> Self {
        Self { inner: Arc::new(LayerInner { sessions: Mutex::new(HashMap::new()), frame: AtomicU64::new(0) }) }
    }

    pub fn start(
        &self,
        source_id: &str,
        kind: &str,
        monitor_id: Option<&str>,
        title: &str,
        class_name: &str,
        exe: &str,
    ) -> Result<(), String> {
        let source_id = clean_id(source_id)?;
        let kind = match kind {
            "display" => CaptureKind::Display,
            "window" => CaptureKind::Window,
            _ => return Err("Only a desktop or a window can be a second capture.".into()),
        };
        let window = sanitize_target(title, class_name, exe);
        if kind == CaptureKind::Window && window.is_empty() {
            return Err("Choose a window to record.".into());
        }
        {
            let sessions = self.inner.sessions.lock().map_err(|err| err.to_string())?;
            if sessions.len() >= 8 && !sessions.contains_key(&source_id) {
                return Err("A scene can preview up to eight extra captures.".into());
            }
        }
        let capture = ComposedCapture::start(kind, None, monitor_id, kind.window_arg(&window))?;
        let stop = Arc::new(AtomicBool::new(false));
        let slot = Arc::new(Slot::new());
        let stop_thread = Arc::clone(&stop);
        let slot_thread = Arc::clone(&slot);
        let thread = thread::Builder::new()
            .name("replay-layer-preview".into())
            .spawn(move || run(capture, stop_thread, slot_thread))
            .map_err(|err| err.to_string())?;
        let mut sessions = self.inner.sessions.lock().map_err(|err| err.to_string())?;
        sessions.insert(source_id, Session { stop, thread: Some(thread), slot });
        Ok(())
    }

    pub fn stop(&self, source_id: &str) {
        let Ok(source_id) = clean_id(source_id) else { return };
        if let Ok(mut sessions) = self.inner.sessions.lock() {
            sessions.remove(&source_id);
        }
    }

    pub fn wait(&self, source_id: &str, after: u64, timeout: Duration) -> (LayerPreviewHeader, Option<Arc<[u8]>>) {
        let Ok(source_id) = clean_id(source_id) else {
            return (LayerPreviewHeader::empty(after), None);
        };
        let slot = self.inner.sessions.lock().ok().and_then(|sessions| sessions.get(&source_id).map(|session| Arc::clone(&session.slot)));
        match slot {
            Some(slot) => slot.wait(after, timeout),
            None => {
                thread::sleep(timeout.min(Duration::from_millis(100)));
                (LayerPreviewHeader::empty(self.inner.frame.load(Ordering::Relaxed)), None)
            }
        }
    }
}

impl CaptureKind {
    fn window_arg<'a>(&self, window: &'a WindowTarget) -> Option<&'a WindowTarget> {
        matches!(self, CaptureKind::Window).then_some(window)
    }
}

fn run(capture: ComposedCapture, stop: Arc<AtomicBool>, slot: Arc<Slot>) {
    while !stop.load(Ordering::Relaxed) {
        if let Some(frame) = capture.latest() {
            let scaled = crate::still::scale_bgra_area(&frame, 960);
            if let Ok(jpeg) = crate::camera::color::encode_jpeg_bgra_quality(&scaled.bgra, scaled.width, scaled.height, 80) {
                slot.publish(scaled.width, scaled.height, jpeg);
            }
        }
        thread::sleep(Duration::from_millis(80));
    }
    // `capture` drops here. ComposedCapture's Drop stops the grab.
    let _ = capture;
}

fn clean_id(value: &str) -> Result<String, String> {
    let cleaned: String = value.chars().filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_')).take(40).collect();
    if cleaned.is_empty() {
        return Err("Choose a source.".into());
    }
    Ok(cleaned)
}
