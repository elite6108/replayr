//! Recording-only WGC session. Isolated from Instant Replay WindowsSession.

#![cfg(windows)]

use std::convert::TryInto;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};

use crate::still::StillFrame;
use windows_capture::capture::{Context, GraphicsCaptureApiHandler};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
    MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};

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
    pub fn start(
        kind: CaptureKind,
        pid: Option<u32>,
        monitor_id: Option<&str>,
        window: Option<&crate::capture_windows::WindowTarget>,
    ) -> Result<Self, String> {
        let hub = CaptureHub::new();
        let control = match kind {
            CaptureKind::Display => {
                let monitor = crate::displays::resolve_monitor_for_recording(monitor_id)?;
                begin(monitor, Arc::clone(&hub))?
            }
            CaptureKind::Game => {
                let pid = pid.filter(|value| *value != 0).ok_or_else(|| {
                    "No game detected. Open a game or switch the source to Desktop.".to_string()
                })?;
                let window = crate::game_window::window_for_pid(pid)
                    .ok_or_else(|| "No game window.".to_string())?;
                begin(window, Arc::clone(&hub))?
            }
            CaptureKind::Window => {
                let target = window.cloned().unwrap_or_default();
                let found = crate::capture_windows::resolve_capture_window(&target)?;
                begin(found, Arc::clone(&hub))?
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
