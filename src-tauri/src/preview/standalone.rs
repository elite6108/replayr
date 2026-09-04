//! Preview-only WGC session. No encoder, SessionClock, audio, or camera.

use std::convert::TryInto;
use windows_capture::capture::{Context, GraphicsCaptureApiHandler};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
    MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};
use windows_capture::window::Window;

use crate::still::StillFrame;

use super::{PreviewHub, PreviewMode};

pub struct StandalonePreview {
    control: Option<windows_capture::capture::CaptureControl<PreviewOnlySession, String>>,
}

struct PreviewOnlySession {
    hub: PreviewHub,
}

impl GraphicsCaptureApiHandler for PreviewOnlySession {
    type Flags = PreviewHub;
    type Error = String;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        Ok(Self { hub: ctx.flags })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        _capture_control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        if self.hub.should_accept() {
            if let Some(still) = pack_frame(frame) {
                self.hub.offer(&still);
            }
        }
        Ok(())
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        Ok(())
    }
}

impl StandalonePreview {
    pub fn start(
        hub: PreviewHub,
        mode: PreviewMode,
        pid: Option<u32>,
        monitor_id: Option<&str>,
    ) -> Result<Self, String> {
        let control = match mode {
            PreviewMode::Game => {
                let pid = pid.filter(|value| *value != 0).ok_or_else(|| "No game detected.".to_string())?;
                let window = window_for_pid(pid).ok_or_else(|| "No game window.".to_string())?;
                begin(window, hub)?
            }
            PreviewMode::Desktop => {
                let monitor = crate::displays::resolve_monitor(monitor_id)?;
                begin(monitor, hub)?
            }
        };
        Ok(Self {
            control: Some(control),
        })
    }

    pub fn stop(mut self) {
        if let Some(control) = self.control.take() {
            let _ = control.stop();
        }
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
        let area = window.width().unwrap_or(0).saturating_mul(window.height().unwrap_or(0));
        std::cmp::Reverse(area)
    });
    matches.into_iter().next()
}

fn begin<T>(
    item: T,
    flags: PreviewHub,
) -> Result<windows_capture::capture::CaptureControl<PreviewOnlySession, String>, String>
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
    PreviewOnlySession::start_free_threaded(settings).map_err(|err| err.to_string())
}
