//! Recording-only WGC session. Isolated from Instant Replay WindowsSession.

#![cfg(windows)]

use std::convert::TryInto;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};

use windows_capture::capture::{Context, GraphicsCaptureApiHandler};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::monitor::Monitor;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
    MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};
use windows_capture::window::Window;

use crate::still::StillFrame;

use super::super::scene::CaptureKind;

pub struct CaptureHub {
    latest: Mutex<Option<StillFrame>>,
    cv: Condvar,
    stop: AtomicBool,
}

impl CaptureHub {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            latest: Mutex::new(None),
            cv: Condvar::new(),
            stop: AtomicBool::new(false),
        })
    }

    fn offer(&self, frame: StillFrame) {
        if self.stop.load(Ordering::SeqCst) {
            return;
        }
        if let Ok(mut slot) = self.latest.lock() {
            *slot = Some(frame);
            self.cv.notify_one();
        }
    }

    pub fn latest(&self) -> Option<StillFrame> {
        self.latest.lock().ok().and_then(|slot| slot.clone())
    }
}

pub struct ComposedCapture {
    hub: Arc<CaptureHub>,
    control: Option<windows_capture::capture::CaptureControl<CaptureOnlySession, String>>,
}

struct CaptureOnlySession {
    hub: Arc<CaptureHub>,
}

impl GraphicsCaptureApiHandler for CaptureOnlySession {
    type Flags = Arc<CaptureHub>;
    type Error = String;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        Ok(Self { hub: ctx.flags })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        _capture_control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        if let Some(still) = pack_frame(frame) {
            self.hub.offer(still);
        }
        Ok(())
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        Ok(())
    }
}

impl ComposedCapture {
    pub fn start(kind: CaptureKind, pid: Option<u32>) -> Result<Self, String> {
        let hub = CaptureHub::new();
        let control = match kind {
            CaptureKind::Display => {
                let monitor = Monitor::primary().map_err(|err| err.to_string())?;
                begin(monitor, Arc::clone(&hub))?
            }
            CaptureKind::Game | CaptureKind::Window => {
                let pid = pid
                    .filter(|value| *value != 0)
                    .ok_or_else(|| "No game detected. Open a game or switch the source to Desktop.".to_string())?;
                let window = window_for_pid(pid).ok_or_else(|| "No game window.".to_string())?;
                begin(window, Arc::clone(&hub))?
            }
        };
        Ok(Self {
            hub,
            control: Some(control),
        })
    }

    pub fn latest(&self) -> Option<StillFrame> {
        self.hub.latest()
    }

    pub fn stop(&mut self) {
        self.hub.stop.store(true, Ordering::SeqCst);
        if let Some(control) = self.control.take() {
            let _ = control.stop();
        }
    }
}

impl Drop for ComposedCapture {
    fn drop(&mut self) {
        self.stop();
    }
}

fn pack_frame(frame: &mut Frame) -> Option<StillFrame> {
    let mut pixels = frame.buffer().ok()?;
    let width = pixels.width();
    let height = pixels.height();
    if width == 0 || height == 0 {
        return None;
    }
    let mut packed = Vec::new();
    let (bytes, pitch) = if pixels.has_padding() {
        let _ = pixels.as_nopadding_buffer(&mut packed);
        (packed, width * 4)
    } else {
        (pixels.as_raw_buffer().to_vec(), pixels.row_pitch())
    };
    Some(StillFrame {
        bgra: bytes,
        width,
        height,
        pitch,
    })
}

fn window_for_pid(pid: u32) -> Option<Window> {
    let windows = Window::enumerate().ok()?;
    let mut matches: Vec<Window> = windows
        .into_iter()
        .filter(|window| window.is_valid() && window.process_id().ok() == Some(pid))
        .collect();
    matches.sort_by_key(|window| {
        let area = window
            .width()
            .unwrap_or(0)
            .saturating_mul(window.height().unwrap_or(0));
        std::cmp::Reverse(area)
    });
    matches.into_iter().next()
}

fn begin<T>(
    item: T,
    flags: Arc<CaptureHub>,
) -> Result<windows_capture::capture::CaptureControl<CaptureOnlySession, String>, String>
where
    T: TryInto<windows_capture::settings::GraphicsCaptureItemType> + Clone + Send + 'static,
{
    let settings = Settings::new(
        item,
        CursorCaptureSettings::Default,
        DrawBorderSettings::WithoutBorder,
        SecondaryWindowSettings::Default,
        MinimumUpdateIntervalSettings::Default,
        DirtyRegionSettings::Default,
        ColorFormat::Bgra8,
        flags,
    );
    CaptureOnlySession::start_free_threaded(settings).map_err(|err| err.to_string())
}
