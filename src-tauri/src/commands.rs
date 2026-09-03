use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

use crate::camera::{CameraEngine, PreviewRequest};
use crate::capture::{RecordingState, RecordingStatus, ReplayStatus};
use crate::database::AppState;
use crate::detection::DetectionState;
use crate::error::{AppError, AppResult};
use crate::games::{DetectedGameSnapshot, GameInput, GameRecord};
use crate::library::LocalClipDto;
use crate::recording_compositor::{ComposedRecordingState, RecordingComposition};
use crate::settings::AppSettings;
use crate::{auth, capture, detection, games, hotkeys, library, settings, shortcut};

const LIVE_AUDIO_KEYS: &[&str] = &[
    "micEnabled",
    "microphoneId",
    "micGain",
    "gameAudioEnabled",
    "gameAudioGain",
    "discordAudioEnabled",
    "discordAudioGain",
    "systemAudioEnabled",
    "extraApps",
];
const CAPTURE_KEYS: &[&str] = &[
    "instantReplayEnabled",
    "replayDurationSeconds",
    "resolution",
    "fps",
    "bitrate",
    "customBitrateKbps",
    "codec",
    "saveLocation",
];

#[tauri::command]
pub fn get_all_settings(state: State<AppState>) -> AppResult<AppSettings> {
    let conn = state.db.lock().map_err(|err| AppError::Message(err.to_string()))?;
    settings::load(&conn)
}

#[tauri::command]
pub fn set_setting(app: AppHandle, state: State<AppState>, rec: State<RecordingState>, composed: State<ComposedRecordingState>, detection: State<DetectionState>, key: String, value: Value) -> AppResult<AppSettings> {
    reject_ir_while_composed(&composed, &key, &value)?;
    let settings = {
        let conn = state.db.lock().map_err(|err| AppError::Message(err.to_string()))?;
        settings::set_document(&conn, json!({ key.clone(): value }))?
    };
    after_settings(&app, &rec, &detection, &settings, &[key])?;
    Ok(settings)
}

#[tauri::command]
pub fn set_settings(app: AppHandle, state: State<AppState>, rec: State<RecordingState>, composed: State<ComposedRecordingState>, detection: State<DetectionState>, patch: Value) -> AppResult<AppSettings> {
    if let Some(value) = patch.get("instantReplayEnabled") {
        reject_ir_while_composed(&composed, "instantReplayEnabled", value)?;
    }
    let keys = patch_keys(&patch);
    let settings = {
        let conn = state.db.lock().map_err(|err| AppError::Message(err.to_string()))?;
        settings::set_document(&conn, patch)?
    };
    after_settings(&app, &rec, &detection, &settings, &keys)?;
    Ok(settings)
}

fn reject_ir_while_composed(composed: &ComposedRecordingState, key: &str, value: &Value) -> AppResult<()> {
    if key == "instantReplayEnabled" && value.as_bool() == Some(true) && composed.is_active() {
        return Err(AppError::Message(
            "Stop composed recording before enabling Instant Replay.".into(),
        ));
    }
    Ok(())
}

fn patch_keys(patch: &Value) -> Vec<String> {
    patch
        .as_object()
        .map(|object| object.keys().cloned().collect())
        .unwrap_or_default()
}

fn after_settings(
    app: &AppHandle,
    rec: &RecordingState,
    detection: &DetectionState,
    settings: &AppSettings,
    keys: &[String],
) -> AppResult<()> {
    let _ = rec;
    crate::discord_presence::refresh(app);
    let hotkeys_changed = keys.iter().any(|key| key == "hotkeys");
    let audio_changed = keys.iter().any(|key| LIVE_AUDIO_KEYS.contains(&key.as_str()));
    let capture_changed = keys.iter().any(|key| CAPTURE_KEYS.contains(&key.as_str()));
    let webcam_changed = keys.iter().any(|key| key == "webcam");

    if hotkeys_changed {
        hotkeys::register_all(app, &settings.hotkeys)?;
    }

    #[cfg(windows)]
    if audio_changed {
        let handle = app.clone();
        let settings = settings.clone();
        let _ = std::thread::Builder::new()
            .name("audio-apply".into())
            .spawn(move || {
                handle.state::<crate::audio::AudioRuntime>().apply(&settings);
            });
    }

    if webcam_changed {
        app.state::<CameraEngine>().configure(&settings.webcam);
    }

    if keys.iter().any(|key| key == "saveLocation") {
        crate::paths::allow_clip_asset_roots(app);
    }

    if capture_changed {
        let handle = app.clone();
        let snapshot = detection::current_snapshot(detection);
        let _ = std::thread::Builder::new()
            .name("sync-replay".into())
            .spawn(move || {
                let rec = handle.state::<RecordingState>();
                if let Err(err) = capture::sync_replay(
                    &handle,
                    &rec,
                    snapshot.pid,
                    snapshot.name.clone(),
                    snapshot.slug.clone(),
                ) {
                    tracing::warn!("sync replay after settings: {err}");
                }
            });
    }
    Ok(())
}

#[tauri::command]
pub async fn list_audio_devices() -> AppResult<Value> {
    #[cfg(windows)]
    {
        let devices = tauri::async_runtime::spawn_blocking(crate::audio::list_devices)
            .await
            .map_err(|err| AppError::Message(err.to_string()))?
            .map_err(AppError::Message)?;
        Ok(serde_json::to_value(devices)?)
    }
    #[cfg(not(windows))]
    {
        Ok(json!([]))
    }
}

#[tauri::command]
pub fn list_camera_devices(engine: State<CameraEngine>) -> AppResult<Value> {
    let devices = engine.list_devices().map_err(AppError::Message)?;
    Ok(serde_json::to_value(devices)?)
}

#[tauri::command]
pub fn list_camera_modes(engine: State<CameraEngine>, device_id: String) -> AppResult<Value> {
    let modes = engine.list_modes(&device_id).map_err(AppError::Message)?;
    Ok(serde_json::to_value(modes)?)
}

#[tauri::command]
pub fn get_camera_status(engine: State<CameraEngine>) -> AppResult<Value> {
    Ok(serde_json::to_value(engine.status())?)
}

#[tauri::command]
pub fn start_camera_preview(
    engine: State<CameraEngine>,
    device_id: String,
    width: u32,
    height: u32,
    fps: u32,
    mirror: bool,
) -> AppResult<Value> {
    let status = engine
        .start_preview(PreviewRequest {
            device_id,
            width,
            height,
            fps,
            mirror,
        })
        .map_err(AppError::Message)?;
    Ok(serde_json::to_value(status)?)
}

#[tauri::command]
pub fn stop_camera_preview(engine: State<CameraEngine>) -> AppResult<()> {
    engine.stop_preview();
    Ok(())
}

#[tauri::command]
pub fn get_camera_preview_frame(engine: State<CameraEngine>) -> AppResult<Value> {
    Ok(serde_json::to_value(engine.latest_preview())?)
}

#[tauri::command]
pub fn start_capture_preview(
    rec: State<RecordingState>,
    detection: State<DetectionState>,
    mode: Option<String>,
    pid: Option<u32>,
) -> AppResult<()> {
    let snapshot = detection::current_snapshot(&detection);
    let resolved = pid.filter(|value| *value != 0).or(snapshot.pid);
    capture::retain_preview(&rec, mode.as_deref().unwrap_or("game"), resolved);
    Ok(())
}

#[tauri::command]
pub fn stop_capture_preview(rec: State<RecordingState>) -> AppResult<()> {
    capture::release_preview(&rec);
    Ok(())
}

#[tauri::command]
pub fn get_capture_preview_frame(rec: State<RecordingState>) -> AppResult<Value> {
    Ok(serde_json::to_value(capture::preview_frame(&rec))?)
}

#[tauri::command]
pub fn start_webcam_test_record(
    app: AppHandle,
    engine: State<CameraEngine>,
    device_id: String,
    width: u32,
    height: u32,
    fps: u32,
    mirror: bool,
) -> AppResult<Value> {
    let path = webcam_test_path(&app)?;
    let status = engine
        .start_test_record(device_id, width, height, fps, mirror, path)
        .map_err(AppError::Message)?;
    Ok(serde_json::to_value(status)?)
}

#[tauri::command]
pub fn stop_webcam_test_record(engine: State<CameraEngine>) -> AppResult<Value> {
    Ok(serde_json::to_value(engine.stop_test_record())?)
}

fn webcam_test_path(app: &AppHandle) -> AppResult<std::path::PathBuf> {
    let settings = {
        let db = app.state::<AppState>();
        let conn = db.db.lock().map_err(|err| AppError::Message(err.to_string()))?;
        settings::load(&conn)?
    };
    let dir = if settings.save_location.trim().is_empty() {
        let dir = app
            .path()
            .video_dir()
            .or_else(|_| app.path().document_dir())
            .map_err(|err| AppError::Message(err.to_string()))?;
        dir.join("Project Replay")
    } else {
        std::path::PathBuf::from(&settings.save_location)
    };
    std::fs::create_dir_all(&dir)?;
    crate::disk::ensure_free_space(&dir, settings.min_free_disk_bytes)?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Ok(dir.join(format!("webcam-test-{ts}.mp4")))
}

#[tauri::command]
pub async fn list_audio_sessions() -> AppResult<Value> {
    #[cfg(windows)]
    {
        let sessions = tauri::async_runtime::spawn_blocking(crate::audio::list_sessions)
            .await
            .map_err(|err| AppError::Message(err.to_string()))?
            .map_err(AppError::Message)?;
        Ok(serde_json::to_value(sessions)?)
    }
    #[cfg(not(windows))]
    {
        Ok(json!([]))
    }
}

#[tauri::command]
pub fn get_audio_status(app: AppHandle) -> AppResult<Value> {
    #[cfg(windows)]
    {
        let runtime = app.state::<crate::audio::AudioRuntime>();
        runtime.ensure_desktop_peak_monitor();
        let status = runtime.status();
        Ok(serde_json::to_value(status)?)
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Ok(json!({
            "processLoopbackSupported": false,
            "osBuild": 0,
            "extraCount": 0,
            "extraCap": 4,
            "game": { "id": "game", "displayName": "Game Audio", "enabled": false, "running": false, "capturing": false, "isolationFailed": false, "status": "", "peak": 0.0, "gain": 1.0 },
            "desktop": { "id": "desktop", "displayName": "Desktop / System", "enabled": false, "running": false, "capturing": false, "isolationFailed": false, "status": "", "peak": 0.0, "gain": 1.0 },
            "discord": { "id": "discord", "displayName": "Discord", "enabled": false, "running": false, "capturing": false, "isolationFailed": false, "status": "", "peak": 0.0, "gain": 1.0 },
            "extras": [],
            "detectedExtras": []
        }))
    }
}

#[tauri::command]
pub fn add_extra_audio_app(
    app: AppHandle,
    state: State<AppState>,
    rec: State<RecordingState>,
    detection: State<DetectionState>,
    exe: String,
    display_name: String,
) -> AppResult<AppSettings> {
    let exe = exe.trim().to_string();
    if exe.is_empty() {
        return Err(AppError::Message("Choose an app that is playing audio.".into()));
    }
    let current = {
        let conn = state.db.lock().map_err(|err| AppError::Message(err.to_string()))?;
        settings::load(&conn)?
    };
    if let Some(existing) = current
        .extra_apps
        .iter()
        .find(|app| crate::games::process_name_matches(&app.exe, &exe))
    {
        let mut extras = current.extra_apps.clone();
        if let Some(item) = extras.iter_mut().find(|item| item.id == existing.id) {
            item.enabled = true;
            if !display_name.trim().is_empty() {
                item.display_name = display_name.trim().to_string();
            }
        }
        let patch = json!({ "extraApps": extras });
        let keys = patch_keys(&patch);
        let settings = {
            let conn = state.db.lock().map_err(|err| AppError::Message(err.to_string()))?;
            settings::set_document(&conn, patch)?
        };
        after_settings(&app, &rec, &detection, &settings, &keys)?;
        return Ok(settings);
    }
    crate::audio_resolve::can_add_extra_app(current.discord_audio_enabled, &current.extra_apps)
        .map_err(AppError::Message)?;
    let catalog = crate::audio_resolve::catalog_for_exe(&exe);
    let mut extras = current.extra_apps.clone();
    extras.push(crate::settings::ExtraAudioApp {
        id: catalog
            .map(|app| app.id.to_string())
            .unwrap_or_else(|| crate::games::normalize_process_name(&exe)),
        exe,
        display_name: display_name.trim().to_string().if_empty_then(catalog.map(|app| app.display_name)),
        enabled: true,
        gain: 1.0,
    });
    let patch = json!({ "extraApps": extras });
    let keys = patch_keys(&patch);
    let settings = {
        let conn = state.db.lock().map_err(|err| AppError::Message(err.to_string()))?;
        settings::set_document(&conn, patch)?
    };
    after_settings(&app, &rec, &detection, &settings, &keys)?;
    Ok(settings)
}

trait IfEmptyThen {
    fn if_empty_then(self, fallback: Option<&str>) -> String;
}

impl IfEmptyThen for String {
    fn if_empty_then(self, fallback: Option<&str>) -> String {
        if self.is_empty() {
            fallback.unwrap_or("App").to_string()
        } else {
            self
        }
    }
}

#[tauri::command]
pub fn get_mic_level(app: AppHandle, state: State<AppState>) -> f32 {
    #[cfg(windows)]
    {
        let loaded = state
            .db
            .lock()
            .ok()
            .and_then(|conn| settings::load(&conn).ok());
        let device_id = loaded
            .as_ref()
            .map(|settings| settings.microphone_id.clone())
            .unwrap_or_else(|| "default".into());
        let runtime = app.state::<crate::audio::AudioRuntime>();
        if let Some(settings) = loaded.as_ref() {
            runtime.set_gain(settings.mic_gain);
        }
        if !runtime.is_monitoring(&device_id) {
            let handle = app.clone();
            let _ = std::thread::Builder::new()
                .name("mic-monitor".into())
                .spawn(move || {
                    handle
                        .state::<crate::audio::AudioRuntime>()
                        .ensure_peak_monitor(&device_id);
                });
        }
        runtime.idle_tick();
        runtime.peak()
    }
    #[cfg(not(windows))]
    {
        let _ = (app, state);
        0.0
    }
}

#[tauri::command]
pub fn stop_mic_monitor(app: AppHandle) {
    #[cfg(windows)]
    {
        app.state::<crate::audio::AudioRuntime>().stop_if_not_mixing();
    }
    #[cfg(not(windows))]
    {
        let _ = app;
    }
}

#[tauri::command]
pub fn resolve_mic_disconnect(
    app: AppHandle,
    state: State<AppState>,
    rec: State<RecordingState>,
    detection: State<DetectionState>,
    action: String,
) -> AppResult<AppSettings> {
    #[cfg(windows)]
    {
        app.state::<crate::audio::AudioRuntime>().clear_hold();
    }
    let patch = match action.as_str() {
        "default" => json!({ "microphoneId": "default", "micEnabled": true }),
        "off" => json!({ "micEnabled": false }),
        _ => return Err(AppError::Message("Unknown microphone disconnect action.".into())),
    };
    let keys = patch_keys(&patch);
    let settings = {
        let conn = state.db.lock().map_err(|err| AppError::Message(err.to_string()))?;
        settings::set_document(&conn, patch)?
    };
    after_settings(&app, &rec, &detection, &settings, &keys)?;
    Ok(settings)
}

fn ms_arg(value: f64) -> u64 {
    if !value.is_finite() || value <= 0.0 {
        0
    } else {
        value.round() as u64
    }
}

#[tauri::command]
pub async fn save_trimmed_clip(
    app: AppHandle,
    source_local_id: String,
    start_ms: f64,
    end_ms: f64,
    title: Option<String>,
) -> AppResult<crate::library::LocalClipDto> {
    let start_ms = ms_arg(start_ms);
    let end_ms = ms_arg(end_ms);
    tauri::async_runtime::spawn_blocking(move || {
        crate::editor::save_trimmed_clip(&app, &source_local_id, start_ms, end_ms, title)
    })
    .await
    .map_err(|err| AppError::Message(err.to_string()))?
}

#[tauri::command]
pub async fn save_short_clip(
    app: AppHandle,
    source_local_id: String,
    start_ms: f64,
    end_ms: f64,
    pan: Option<f64>,
    title: Option<String>,
) -> AppResult<crate::library::LocalClipDto> {
    let start_ms = ms_arg(start_ms);
    let end_ms = ms_arg(end_ms);
    let pan = pan.unwrap_or(0.5) as f32;
    tauri::async_runtime::spawn_blocking(move || {
        crate::editor::save_short_clip(&app, &source_local_id, start_ms, end_ms, pan, title)
    })
    .await
    .map_err(|err| AppError::Message(err.to_string()))?
}

#[tauri::command]
pub fn set_clip_editor_crop(app: AppHandle, local_id: String, pan: f64) -> AppResult<crate::library::LocalClipDto> {
    crate::library::set_editor_crop(&app, &local_id, pan as f32)
}

#[tauri::command]
pub fn set_clip_source_layout(
    state: State<AppState>,
    local_id: String,
    source_instance_id: String,
    layout: crate::overlay::OverlayLayout,
) -> AppResult<LocalClipDto> {
    let conn = state.db.lock().map_err(|err| AppError::Message(err.to_string()))?;
    library::set_source_layout(&conn, &local_id, &source_instance_id, layout)
}

#[tauri::command]
pub async fn list_clip_filmstrip(
    app: AppHandle,
    local_id: String,
    count: Option<u32>,
) -> AppResult<Vec<crate::editor::FilmstripFrame>> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::editor::list_filmstrip(&app, &local_id, count.unwrap_or(12))
    })
    .await
    .map_err(|err| AppError::Message(err.to_string()))?
}

#[tauri::command]
pub async fn prepare_local_clip_playback(app: AppHandle, local_id: String) -> AppResult<String> {
    tauri::async_runtime::spawn_blocking(move || library::prepare_playback(&app, &local_id))
        .await
        .map_err(|err| AppError::Message(err.to_string()))?
}

#[tauri::command]
pub fn list_local_clips(state: State<AppState>, limit: Option<i64>) -> AppResult<Vec<LocalClipDto>> {
    let conn = state.db.lock().map_err(|err| AppError::Message(err.to_string()))?;
    library::list(&conn, limit.unwrap_or(80))
}

#[tauri::command]
pub fn reset_stale_uploads(state: State<AppState>) -> AppResult<Vec<String>> {
    let conn = state.db.lock().map_err(|err| AppError::Message(err.to_string()))?;
    library::reset_stale_uploads(&conn)
}

#[tauri::command]
pub fn rename_local_clip(state: State<AppState>, local_id: String, title: String) -> AppResult<LocalClipDto> {
    let conn = state.db.lock().map_err(|err| AppError::Message(err.to_string()))?;
    library::rename(&conn, &local_id, &title)
}

#[tauri::command]
pub fn set_local_clip_favorite(state: State<AppState>, local_id: String, favorite: bool) -> AppResult<LocalClipDto> {
    let conn = state.db.lock().map_err(|err| AppError::Message(err.to_string()))?;
    library::set_favorite(&conn, &local_id, favorite)
}

#[tauri::command]
pub fn delete_local_clip(state: State<AppState>, local_id: String) -> AppResult<()> {
    let conn = state.db.lock().map_err(|err| AppError::Message(err.to_string()))?;
    library::delete(&conn, &local_id)
}

#[tauri::command]
pub fn reveal_local_clip(app: AppHandle, file_path: String) -> AppResult<()> {
    crate::paths::assert_reveal_allowed(&app, &file_path)?;
    library::reveal(&file_path)
}

#[tauri::command]
pub fn share_local_clip(
    app: AppHandle,
    file_path: Option<String>,
    local_id: Option<String>,
) -> AppResult<String> {
    crate::share::share_clip(&app, local_id.as_deref(), file_path.as_deref())
}

#[tauri::command]
pub fn export_local_clip(
    app: AppHandle,
    source: Option<String>,
    dest: String,
    local_id: Option<String>,
) -> AppResult<()> {
    crate::share::export_clip(&app, local_id.as_deref(), source.as_deref(), &dest)
}

#[tauri::command]
pub fn download_url_to_file(
    app: AppHandle,
    url: String,
    dest: String,
    skip_watermark: Option<bool>,
    access_token: Option<String>,
) -> AppResult<()> {
    crate::upload::download_url_to_file(
        &app,
        &url,
        &dest,
        skip_watermark.unwrap_or(false),
        access_token.as_deref(),
    )
}

#[tauri::command]
pub async fn upload_local_clip(
    app: AppHandle,
    local_id: String,
    access_token: String,
    api_base: String,
) -> AppResult<LocalClipDto> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::upload::upload_local_clip(&app, &local_id, &access_token, &api_base)
    })
    .await
    .map_err(|err| AppError::Message(err.to_string()))?
}

#[tauri::command]
pub async fn delete_cloud_clip(
    app: AppHandle,
    clip_id: String,
    access_token: String,
    api_base: String,
) -> AppResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::upload::delete_cloud_clip(&app, &clip_id, &access_token, &api_base)
    })
    .await
    .map_err(|err| AppError::Message(err.to_string()))?
}

#[tauri::command]
pub fn create_desktop_shortcut(app: AppHandle) -> AppResult<()> {
    shortcut::create(&app)
}

#[tauri::command]
pub fn remove_desktop_shortcut(app: AppHandle) -> AppResult<()> {
    shortcut::remove(&app)
}

#[tauri::command]
pub fn desktop_shortcut_exists(app: AppHandle) -> AppResult<bool> {
    shortcut::exists(&app)
}

#[tauri::command]
pub fn get_default_save_location(app: AppHandle) -> AppResult<String> {
    let dir = app
        .path()
        .video_dir()
        .or_else(|_| app.path().document_dir())
        .map_err(|err| AppError::Message(err.to_string()))?;
    Ok(dir.join("Project Replay").to_string_lossy().into_owned())
}

#[tauri::command]
pub fn auth_get_item(app: AppHandle, key: String) -> AppResult<Option<String>> {
    auth::get_item(&app, &key)
}

#[tauri::command]
pub fn auth_set_item(app: AppHandle, key: String, value: String) -> AppResult<()> {
    auth::set_item(&app, &key, &value)
}

#[tauri::command]
pub fn auth_remove_item(app: AppHandle, key: String) -> AppResult<()> {
    auth::remove_item(&app, &key)
}

#[tauri::command]
pub fn list_games(state: State<AppState>) -> AppResult<Vec<GameRecord>> {
    let conn = state.db.lock().map_err(|err| AppError::Message(err.to_string()))?;
    games::load_catalog(&conn)
}

#[tauri::command]
pub fn sync_games(state: State<AppState>, games: Vec<GameInput>) -> AppResult<Vec<GameRecord>> {
    let conn = state.db.lock().map_err(|err| AppError::Message(err.to_string()))?;
    crate::games::upsert_catalog(&conn, &games)
}

#[tauri::command]
pub fn get_detected_game(state: State<DetectionState>) -> DetectedGameSnapshot {
    detection::current_snapshot(&state)
}

#[tauri::command]
pub fn get_discord_presence_status(app: AppHandle) -> crate::discord_presence::DiscordPresenceStatus {
    crate::discord_presence::status(&app)
}

#[tauri::command]
pub fn start_recording(
    app: AppHandle,
    rec: State<RecordingState>,
    composed: State<ComposedRecordingState>,
    detection: State<DetectionState>,
    webcam_layout: Option<crate::overlay::OverlayLayout>,
) -> AppResult<RecordingStatus> {
    if composed.is_active() {
        return Err(AppError::Message("A composed recording is already running.".into()));
    }
    let snapshot = detection::current_snapshot(&detection);
    capture::start(&app, &rec, snapshot.pid, snapshot.name, snapshot.slug, webcam_layout)
}

#[tauri::command]
pub fn stop_recording(app: AppHandle, rec: State<RecordingState>) -> AppResult<RecordingStatus> {
    capture::stop(&app, &rec)
}

#[tauri::command]
pub fn start_composed_recording(
    app: AppHandle,
    rec: State<RecordingState>,
    composed: State<ComposedRecordingState>,
    camera: State<CameraEngine>,
    payload: RecordingComposition,
    webcam_layout: Option<crate::overlay::OverlayLayout>,
) -> AppResult<RecordingStatus> {
    crate::recording_compositor::start(&app, &rec, &composed, &camera, payload, webcam_layout)
}

#[tauri::command]
pub fn stop_composed_recording(
    app: AppHandle,
    rec: State<RecordingState>,
    composed: State<ComposedRecordingState>,
    camera: State<CameraEngine>,
) -> AppResult<RecordingStatus> {
    crate::recording_compositor::stop(&app, &rec, &composed, &camera)
}

#[tauri::command]
pub fn get_recording_status(
    rec: State<RecordingState>,
    composed: State<ComposedRecordingState>,
) -> RecordingStatus {
    if let Some(status) = composed.status() {
        return status;
    }
    capture::status(&rec)
}

#[tauri::command]
pub fn get_replay_status(app: AppHandle, rec: State<RecordingState>) -> AppResult<ReplayStatus> {
    let settings = {
        let db = app.state::<AppState>();
        let conn = db.db.lock().map_err(|err| AppError::Message(err.to_string()))?;
        settings::load(&conn)?
    };
    Ok(capture::replay_status(&rec, &settings))
}

#[tauri::command]
pub async fn save_clip(app: AppHandle) -> AppResult<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let rec = app.state::<RecordingState>();
        capture::save_clip(&app, &rec)
    })
    .await
    .map_err(|err| AppError::Message(err.to_string()))?
}

#[tauri::command]
pub async fn save_screenshot(app: AppHandle) -> AppResult<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let rec = app.state::<RecordingState>();
        capture::screenshot(&app, &rec)
    })
    .await
    .map_err(|err| AppError::Message(err.to_string()))?
}
