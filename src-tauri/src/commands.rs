use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

use crate::capture::{RecordingState, RecordingStatus, ReplayStatus};
use crate::database::AppState;
use crate::detection::DetectionState;
use crate::error::{AppError, AppResult};
use crate::games::{DetectedGameSnapshot, GameInput, GameRecord};
use crate::library::LocalClipDto;
use crate::settings::AppSettings;
use crate::{auth, capture, detection, games, hotkeys, library, settings};

#[tauri::command]
pub fn get_all_settings(state: State<AppState>) -> AppResult<AppSettings> {
    let conn = state.db.lock().map_err(|err| AppError::Message(err.to_string()))?;
    settings::load(&conn)
}

#[tauri::command]
pub fn set_setting(app: AppHandle, state: State<AppState>, rec: State<RecordingState>, detection: State<DetectionState>, key: String, value: Value) -> AppResult<AppSettings> {
    let settings = {
        let conn = state.db.lock().map_err(|err| AppError::Message(err.to_string()))?;
        settings::set_document(&conn, json!({ key: value }))?
    };
    after_settings(&app, &rec, &detection, &settings)?;
    Ok(settings)
}

#[tauri::command]
pub fn set_settings(app: AppHandle, state: State<AppState>, rec: State<RecordingState>, detection: State<DetectionState>, patch: Value) -> AppResult<AppSettings> {
    let settings = {
        let conn = state.db.lock().map_err(|err| AppError::Message(err.to_string()))?;
        settings::set_document(&conn, patch)?
    };
    after_settings(&app, &rec, &detection, &settings)?;
    Ok(settings)
}

fn after_settings(
    app: &AppHandle,
    rec: &RecordingState,
    detection: &DetectionState,
    settings: &AppSettings,
) -> AppResult<()> {
    hotkeys::register_all(app, &settings.hotkeys)?;
    let snapshot = detection::current_snapshot(detection);
    let _ = capture::sync_replay(app, rec, snapshot.pid, snapshot.name, snapshot.slug);
    Ok(())
}

#[tauri::command]
pub fn list_local_clips(state: State<AppState>, limit: Option<i64>) -> AppResult<Vec<LocalClipDto>> {
    let conn = state.db.lock().map_err(|err| AppError::Message(err.to_string()))?;
    library::list(&conn, limit.unwrap_or(80))
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
pub fn export_local_clip(source: String, dest: String) -> AppResult<()> {
    library::export_copy(&source, &dest)
}

#[tauri::command]
pub fn download_url_to_file(url: String, dest: String) -> AppResult<()> {
    crate::upload::download_url_to_file(&url, &dest)
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
