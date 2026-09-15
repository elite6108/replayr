//! Freezing every monitor at the moment a screenshot starts.
//!
//! Each monitor gets its own one-shot Windows Graphics Capture session, all started in parallel:
//! the handler packs the first frame that arrives and stops itself. This is independent of the
//! Instant Replay and composed-recording capture sessions — it starts its own sessions and never
//! touches theirs.
//!
//! WGC is used rather than DXGI Desktop Duplication because duplication only enumerates outputs on
//! the default adapter (it fails on hybrid-GPU laptops) and its first `AcquireNextFrame` can time
//! out on a static desktop.

#![cfg(windows)]

use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use windows::Win32::Foundation::RECT;
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, HMONITOR, MONITORINFO};
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
use windows_capture::capture::{Context, GraphicsCaptureApiHandler};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::monitor::Monitor;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
    MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};
use zeroize::Zeroize;

use crate::still::StillFrame;

use super::geometry::PhysRect;

/// One monitor's frozen image and where it sits on the virtual desktop.
pub struct FrozenMonitor {
    /// Physical virtual-desktop rect (`rcMonitor`). May have negative coordinates.
    pub rect: PhysRect,
    /// Effective DPI, for scaling the selection border and label.
    pub dpi: u32,
    pub frame: StillFrame,
}

impl Drop for FrozenMonitor {
    /// Screen contents can include anything — messages, passwords, banking. Wipe them on every
    /// exit path (commit, cancel, error, panic unwind) rather than trusting each caller to.
    fn drop(&mut self) {
        self.frame.bgra.zeroize();
    }
}

struct FrameSlot {
    frame: Mutex<Option<StillFrame>>,
    ready: Condvar,
}

struct OneShot {
    slot: Arc<FrameSlot>,
    delivered: bool,
}

impl GraphicsCaptureApiHandler for OneShot {
    type Flags = Arc<FrameSlot>;
    type Error = String;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        Ok(Self { slot: ctx.flags, delivered: false })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        capture_control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        if self.delivered {
            return Ok(());
        }
        // Only stop once a frame actually packed; a failed map waits for the next frame.
        let Some(still) = pack_frame(frame) else {
            return Ok(());
        };
        self.delivered = true;
        if let Ok(mut slot) = self.slot.frame.lock() {
            *slot = Some(still);
            self.slot.ready.notify_all();
        }
        capture_control.stop();
        Ok(())
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        Ok(())
    }
}

/// Capture every connected monitor, waiting at most `timeout` in total.
///
/// A monitor that fails or times out is left out rather than failing the whole screenshot — the
/// user can still snip the others. Only a capture with no monitors at all is an error.
pub fn capture_all(timeout: Duration) -> Result<Vec<FrozenMonitor>, String> {
    let monitors = Monitor::enumerate().map_err(|err| format!("Could not list monitors: {err}"))?;
    if monitors.is_empty() {
        return Err("No monitors were found.".into());
    }

    struct Pending {
        rect: PhysRect,
        dpi: u32,
        slot: Arc<FrameSlot>,
        control: windows_capture::capture::CaptureControl<OneShot, String>,
    }

    let mut pending = Vec::with_capacity(monitors.len());
    for monitor in monitors {
        let Some((rect, dpi)) = monitor_geometry(&monitor) else {
            tracing::warn!("skipping a monitor whose geometry could not be read");
            continue;
        };
        let slot = Arc::new(FrameSlot { frame: Mutex::new(None), ready: Condvar::new() });
        let settings = Settings::new(
            monitor,
            // The live cursor stays visible over the selection surface; a frozen copy would
            // show two cursors and end up burned into the screenshot.
            CursorCaptureSettings::WithoutCursor,
            DrawBorderSettings::WithoutBorder,
            SecondaryWindowSettings::Default,
            MinimumUpdateIntervalSettings::Default,
            DirtyRegionSettings::Default,
            ColorFormat::Bgra8,
            Arc::clone(&slot),
        );
        match OneShot::start_free_threaded(settings) {
            Ok(control) => pending.push(Pending { rect, dpi, slot, control }),
            Err(err) => tracing::warn!(%err, "could not start capture for a monitor"),
        }
    }

    let deadline = Instant::now() + timeout;
    let mut frozen = Vec::with_capacity(pending.len());
    for item in pending {
        let frame = wait_for_frame(&item.slot, deadline);
        // Stopping joins the capture thread, so never do it on the path the user is waiting on.
        let control = item.control;
        let _ = std::thread::Builder::new()
            .name("snip-capture-reaper".into())
            .spawn(move || {
                let _ = control.stop();
            });
        match frame {
            Some(frame) => {
                if (frame.width, frame.height) != (item.rect.w, item.rect.h) {
                    tracing::info!(
                        frame = format!("{}x{}", frame.width, frame.height),
                        monitor = format!("{}x{}", item.rect.w, item.rect.h),
                        "captured frame size differs from monitor rect; selection will be scaled"
                    );
                }
                frozen.push(FrozenMonitor { rect: item.rect, dpi: item.dpi, frame });
            }
            None => tracing::warn!(
                rect = ?item.rect,
                "monitor did not deliver a frame in time; it will not be selectable"
            ),
        }
    }

    if frozen.is_empty() {
        return Err("Could not capture the screen.".into());
    }
    Ok(frozen)
}

fn wait_for_frame(slot: &FrameSlot, deadline: Instant) -> Option<StillFrame> {
    let mut guard = slot.frame.lock().ok()?;
    loop {
        if let Some(frame) = guard.take() {
            return Some(frame);
        }
        let now = Instant::now();
        if now >= deadline {
            return None;
        }
        let (next, _) = slot.ready.wait_timeout(guard, deadline - now).ok()?;
        guard = next;
    }
}

fn monitor_geometry(monitor: &Monitor) -> Option<(PhysRect, u32)> {
    let handle = HMONITOR(monitor.as_raw_hmonitor());
    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    if !unsafe { GetMonitorInfoW(handle, &mut info) }.as_bool() {
        return None;
    }
    let RECT { left, top, right, bottom } = info.rcMonitor;
    let (w, h) = (right.checked_sub(left)?, bottom.checked_sub(top)?);
    if w <= 0 || h <= 0 {
        return None;
    }
    let mut dpi_x = 0u32;
    let mut dpi_y = 0u32;
    let dpi = match unsafe { GetDpiForMonitor(handle, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y) } {
        Ok(()) => dpi_x.max(dpi_y).max(96),
        Err(_) => 96,
    };
    Some((PhysRect { x: left, y: top, w: w as u32, h: h as u32 }, dpi))
}

/// Copy a WGC frame into a tightly packed BGRA buffer. Mirrors the private helper in the
/// recording capture source, kept separate so this module never reaches into recording code.
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
    Some(StillFrame { bgra: bytes, width, height, pitch })
}
