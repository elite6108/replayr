//! Start/stop for the global hotkey and the tray. Both record the same layout the Record page
//! would: the last scene the Recordings tab sent, or full-screen game capture before the page
//! has ever been opened.

use std::sync::Mutex;

use tauri::{AppHandle, Manager};

use super::scene::{
    CaptureCompositionSource, CaptureKind, ComposedAudioRouting, ComposedAudioSourceRoute, CompositionCanvas,
    CompositionCrop, CompositionSource, CompositionTransform,
};
use super::{ComposedRecordingState, RecordingComposition};
use crate::camera::CameraEngine;
use crate::capture::{self, RecordingState};
use crate::error::{AppError, AppResult};
use crate::overlay::OverlayLayout;
use crate::settings::AppSettings;

#[derive(Default)]
pub struct RecordSceneState {
    scene: Mutex<Option<(RecordingComposition, Option<OverlayLayout>)>>,
}

impl RecordSceneState {
    /// Stored as sent. `start` validates, so an unrecordable scene reports the same error the
    /// Record button would instead of silently recording an older layout.
    pub fn set(&self, payload: RecordingComposition, webcam_layout: Option<OverlayLayout>) -> AppResult<()> {
        let mut slot = self.scene.lock().map_err(|err| AppError::Message(err.to_string()))?;
        *slot = Some((payload, webcam_layout));
        Ok(())
    }

    fn get(&self) -> Option<(RecordingComposition, Option<OverlayLayout>)> {
        self.scene.lock().ok().and_then(|slot| slot.clone())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToggleOutcome {
    Started,
    Saved,
}

pub const RECORD_NEEDS_IR_OFF: &str = "Turn off Instant Replay to record.";

/// The hotkey and tray never start a recording while Instant Replay is on; they say why instead.
pub fn toggle(app: &AppHandle) -> AppResult<ToggleOutcome> {
    let rec = app.state::<RecordingState>();
    let composed = app.state::<ComposedRecordingState>();
    let camera = app.state::<CameraEngine>();
    if composed.is_active() {
        super::stop(app, &rec, &composed, &camera)?;
        return Ok(ToggleOutcome::Saved);
    }
    if capture::status(&rec).active {
        capture::stop(app, &rec)?;
        return Ok(ToggleOutcome::Saved);
    }
    start(app)
}

pub fn start(app: &AppHandle) -> AppResult<ToggleOutcome> {
    let rec = app.state::<RecordingState>();
    let composed = app.state::<ComposedRecordingState>();
    let camera = app.state::<CameraEngine>();
    if composed.is_active() || capture::status(&rec).active {
        return Err(AppError::Message("Already recording.".into()));
    }
    let settings = super::load_settings(app)?;
    if settings.instant_replay_enabled {
        return Err(AppError::Message(RECORD_NEEDS_IR_OFF.into()));
    }
    let (payload, layout) = app
        .state::<RecordSceneState>()
        .get()
        .unwrap_or_else(|| (default_game_scene(&settings), None));
    super::start(app, &rec, &composed, &camera, payload, layout)?;
    Ok(ToggleOutcome::Started)
}

pub fn stop(app: &AppHandle) -> AppResult<()> {
    let rec = app.state::<RecordingState>();
    let composed = app.state::<ComposedRecordingState>();
    let camera = app.state::<CameraEngine>();
    if composed.is_active() {
        super::stop(app, &rec, &composed, &camera)?;
    } else {
        capture::stop(app, &rec)?;
    }
    Ok(())
}

fn route(present: bool) -> ComposedAudioSourceRoute {
    ComposedAudioSourceRoute { present, muted: false }
}

/// Full-frame detected game at native size, with the audio the user has switched on.
pub(crate) fn default_game_scene(settings: &AppSettings) -> RecordingComposition {
    RecordingComposition {
        canvas: CompositionCanvas { width: 0, height: 0, fps: settings.fps.clamp(24, 60) },
        audio: ComposedAudioRouting {
            microphone: route(settings.mic_enabled),
            game_audio: route(settings.game_audio_enabled),
            desktop_audio: route(settings.system_audio_enabled),
        },
        sources: vec![CompositionSource::Capture(CaptureCompositionSource {
            id: "src-game-default".into(),
            name: "Game".into(),
            capture: CaptureKind::Game,
            enabled: true,
            order: 1,
            transform: CompositionTransform { x: 0.0, y: 0.0, w: 1.0, h: 1.0, opacity: 1.0 },
            crop: CompositionCrop::default(),
            monitor_id: None,
        })],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_scene_is_a_valid_game_capture() {
        let settings = AppSettings { fps: 120, mic_enabled: true, ..AppSettings::default() };
        let spec = default_game_scene(&settings).validate().expect("default scene must validate");
        assert_eq!(spec.capture.kind, CaptureKind::Game);
        assert_eq!(spec.fps, 60);
        assert!(spec.native_canvas);
        assert!(spec.audio.microphone.routed());
    }
}
