//! One isolated page, shown on the Capture preview and recorded from there.
//! The window is owned by the main window. It has no Tauri bridge.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crate::browser_policy::sanitize_page_url;
use crate::camera::color::encode_jpeg_bgra_quality;
use crate::recording_compositor::sources::browser::{BrowserView, SharedBrowser};
use crate::still::StillFrame;

use super::LayerPreviewHeader;

#[derive(Clone)]
struct Bounds {
    parent: isize,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

struct Session {
    view: BrowserView,
    frames: Arc<Mutex<Option<StillFrame>>>,
    url: String,
    preview: bool,
    retains: u32,
    bounds: Option<Bounds>,
    interactive: bool,
    /// Bumped on every start. A stop from an older preview mount leaves the newer page alone.
    generation: u64,
}

struct Inner {
    sessions: Mutex<HashMap<String, Session>>,
    /// One open at a time, so a second start cannot drop the page the first start just showed.
    start_gate: Mutex<()>,
    next_generation: AtomicU64,
}

#[derive(Clone)]
pub struct BrowserPreviewHub {
    inner: Arc<Inner>,
}

impl BrowserPreviewHub {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Inner {
                sessions: Mutex::new(HashMap::new()),
                start_gate: Mutex::new(()),
                next_generation: AtomicU64::new(1),
            }),
        }
    }

    /// Opens the page, or keeps the one already open. The returned generation is the only stop that may close it.
    pub fn start(&self, source_id: &str, url: &str) -> Result<u64, String> {
        let _gate = self.inner.start_gate.lock().map_err(|err| err.to_string())?;
        let source_id = clean_id(source_id)?;
        let url = sanitize_page_url(url)?;
        let generation = self.inner.next_generation.fetch_add(1, Ordering::Relaxed);
        let mut sessions = self.inner.sessions.lock().map_err(|err| err.to_string())?;
        if let Some(session) = sessions.get_mut(&source_id) {
            session.preview = true;
            session.generation = generation;
            if session.url == url || session.retains > 0 {
                if let Some(bounds) = session.bounds.clone() {
                    session.view.place(bounds.parent, bounds.x, bounds.y, bounds.width, bounds.height, session.interactive);
                }
                return Ok(generation);
            }
            if session.retains == 0 {
                let old = sessions.remove(&source_id);
                drop(sessions);
                drop(old);
            } else {
                return Ok(generation);
            }
        } else if sessions.len() >= 2 {
            return Err("A scene can preview up to two browser sources.".into());
        } else {
            drop(sessions);
        }
        let view = BrowserView::open(&url, &source_id)?;
        let frames = view.frames();
        let mut sessions = self.inner.sessions.lock().map_err(|err| err.to_string())?;
        if sessions.contains_key(&source_id) {
            if let Some(session) = sessions.get_mut(&source_id) {
                session.preview = true;
                session.generation = generation;
            }
            return Ok(generation);
        }
        if sessions.len() >= 2 {
            return Err("A scene can preview up to two browser sources.".into());
        }
        sessions.insert(
            source_id,
            Session { view, frames, url, preview: true, retains: 0, bounds: None, interactive: true, generation },
        );
        Ok(generation)
    }

    /// The next captured page after `after`, so the live preview can draw it before recording starts.
    pub fn wait_frame(&self, source_id: &str, after: u64, timeout: Duration) -> (LayerPreviewHeader, Option<Vec<u8>>) {
        let Ok(source_id) = clean_id(source_id) else {
            return (LayerPreviewHeader::empty(after), None);
        };
        let start = Instant::now();
        loop {
            let ready = {
                let Ok(sessions) = self.inner.sessions.lock() else {
                    return (LayerPreviewHeader::empty(after), None);
                };
                match sessions.get(&source_id) {
                    Some(session) => {
                        let generation = session.view.generation();
                        if generation <= after {
                            None
                        } else {
                            session.view.latest().map(|frame| (generation, frame))
                        }
                    }
                    None => None,
                }
            };
            if let Some((generation, frame)) = ready {
                if let Ok(jpeg) = encode_jpeg_bgra_quality(&frame.bgra, frame.width, frame.height, 80) {
                    return (
                        LayerPreviewHeader {
                            width: frame.width,
                            height: frame.height,
                            frame_id: generation,
                            mime_type: "image/jpeg",
                        },
                        Some(jpeg),
                    );
                }
            }
            if start.elapsed() >= timeout {
                return (LayerPreviewHeader::empty(after), None);
            }
            thread::sleep(Duration::from_millis(20));
        }
    }

    pub fn place(&self, source_id: &str, parent: isize, x: i32, y: i32, width: i32, height: i32, interactive: bool) {
        let Ok(source_id) = clean_id(source_id) else { return };
        let Ok(mut sessions) = self.inner.sessions.lock() else { return };
        let Some(session) = sessions.get_mut(&source_id) else { return };
        if !session.preview {
            return;
        }
        session.bounds = Some(Bounds { parent, x, y, width, height });
        session.interactive = interactive;
        session.view.place(parent, x, y, width, height, interactive);
    }

    pub fn set_interactive(&self, source_id: &str, interactive: bool) {
        let Ok(source_id) = clean_id(source_id) else { return };
        let Ok(mut sessions) = self.inner.sessions.lock() else { return };
        let Some(session) = sessions.get_mut(&source_id) else { return };
        session.interactive = interactive;
        if let Some(bounds) = session.bounds.as_ref() {
            session.view.place(bounds.parent, bounds.x, bounds.y, bounds.width, bounds.height, interactive);
        }
    }

    /// The preview no longer shows this page. A recording that already took it keeps capturing.
    /// A generation from an older mount does not close a page a newer mount is showing.
    pub fn stop_preview(&self, source_id: &str, generation: u64) {
        let Ok(source_id) = clean_id(source_id) else { return };
        let Ok(mut sessions) = self.inner.sessions.lock() else { return };
        let Some(session) = sessions.get_mut(&source_id) else { return };
        if session.generation != generation {
            return;
        }
        session.preview = false;
        session.view.park();
        if session.retains == 0 {
            let old = sessions.remove(&source_id);
            drop(sessions);
            drop(old);
        }
    }

    /// Recording reads this page instead of opening a second one.
    pub fn retain(&self, source_id: &str) -> Option<SharedBrowser> {
        let source_id = clean_id(source_id).ok()?;
        let frames = {
            let mut sessions = self.inner.sessions.lock().ok()?;
            let session = sessions.get_mut(&source_id)?;
            session.retains = session.retains.saturating_add(1);
            Arc::clone(&session.frames)
        };
        let hub = self.clone();
        Some(SharedBrowser::new(frames, Box::new(move || hub.release(&source_id))))
    }

    fn release(&self, source_id: &str) {
        let Ok(mut sessions) = self.inner.sessions.lock() else { return };
        let Some(session) = sessions.get_mut(source_id) else { return };
        session.retains = session.retains.saturating_sub(1);
        if session.retains == 0 && !session.preview {
            let old = sessions.remove(source_id);
            drop(sessions);
            drop(old);
        }
    }
}

fn clean_id(value: &str) -> Result<String, String> {
    let cleaned: String = value.chars().filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_')).take(40).collect();
    if cleaned.is_empty() {
        return Err("Choose a source.".into());
    }
    Ok(cleaned)
}
