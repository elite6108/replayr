use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

use crate::capture::{RecordingState, RecordingStatus, ReplayStatus};
use crate::database::AppState;
use crate::detection::DetectionState;
use crate::error::{AppError, AppResult};
use crate::games::{DetectedGameSnapshot, GameInput, GameRecord};
use crate::library::LocalClipDto;
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
pub fn set_setting(app: AppHandle, state: State<AppState>, rec: State<RecordingState>, detection: State<DetectionState>, key: String, value: Value) -> AppResult<AppSettings> {
    let settings = {
        let conn = state.db.lock().map_err(|err| AppError::Message(err.to_string()))?;
        settings::set_document(&conn, json!({ key.clone(): value }))?
    };
    after_settings(&app, &rec, &detection, &settings, &[key])?;
    Ok(settings)
}

#[tauri::command]
pub fn set_settings(app: AppHandle, state: State<AppState>, rec: State<RecordingState>, detection: State<DetectionState>, patch: Value) -> AppResult<AppSettings> {
    let keys = patch_keys(&patch);
    let settings = {
        let conn = state.db.lock().map_err(|err| AppError::Message(err.to_string()))?;
        settings::set_document(&conn, patch)?
    };
    after_settings(&app, &rec, &detection, &settings, &keys)?;
    Ok(settings)
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
    let hotkeys_changed = keys.iter().any(|key| key == "hotkeys");
    let audio_changed = keys.iter().any(|key| LIVE_AUDIO_KEYS.contains(&key.as_str()));
    let capture_changed = keys.iter().any(|key| CAPTURE_KEYS.contains(&key.as_str()));

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
        let status = app.state::<crate::audio::AudioRuntime>().status();
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
pub fn reveal_local_clip(file_path: String) -> AppResult<()> {
    library::reveal(&file_path)
}

#[tauri::command]
pub fn share_local_clip(app: AppHandle, file_path: String) -> AppResult<String> {
    crate::share::share_file(&app, &file_path)
}

#[tauri::command]
pub fn export_local_clip(app: AppHandle, source: String, dest: String) -> AppResult<()> {
    #[cfg(windows)]
    {
        let src = std::path::Path::new(&source);
        if crate::export::should_watermark_exports(&app)
            && src.extension().and_then(|value| value.to_str()).unwrap_or("").eq_ignore_ascii_case("mp4")
        {
            crate::export::write_watermarked_mp4(src, std::path::Path::new(&dest), 60).map_err(AppError::Message)?;
            return Ok(());
        }
    }
    #[cfg(not(windows))]
    let _ = app;
    library::export_copy(&source, &dest)
}

#[tauri::command]
pub fn download_url_to_file(app: AppHandle, url: String, dest: String) -> AppResult<()> {
    crate::upload::download_url_to_file(&app, &url, &dest)
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
pub async fn sync_watermark_jobs(app: AppHandle, access_token: String, api_base: String) -> AppResult<usize> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::watermark_upload::sync_jobs(&app, &access_token, &api_base)
    })
    .await
    .map_err(|err| AppError::Message(err.to_string()))?
}

#[tauri::command]
pub async fn process_watermark_jobs(app: AppHandle, access_token: String, api_base: String) -> AppResult<usize> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::watermark_upload::process_jobs(&app, &access_token, &api_base)
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
pub fn start_recording(app: AppHandle, rec: State<RecordingState>, detection: State<DetectionState>) -> AppResult<RecordingStatus> {
    let snapshot = detection::current_snapshot(&detection);
    capture::start(&app, &rec, snapshot.pid, snapshot.name, snapshot.slug)
}

#[tauri::command]
pub fn stop_recording(app: AppHandle, rec: State<RecordingState>) -> AppResult<RecordingStatus> {
    capture::stop(&app, &rec)
}

#[tauri::command]
pub fn get_recording_status(rec: State<RecordingState>) -> RecordingStatus {
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
