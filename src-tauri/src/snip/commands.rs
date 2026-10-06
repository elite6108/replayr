//! Tauri commands for region screenshots.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};

use super::store::ScreenshotRecord;
use super::{store, with_db, SnipTrigger};

const DEFAULT_LIST_LIMIT: u32 = 200;

fn to_app_error(message: String) -> AppError {
    AppError::Message(message)
}

/// Start a region screenshot from inside the app. Replayr hides itself for the capture.
#[tauri::command]
pub fn screenshot_start(app: AppHandle) {
    super::start(&app, SnipTrigger::InApp);
}

/// Newest screenshots first, with their folders allowed through the asset protocol for display.
#[tauri::command]
pub fn screenshot_list(app: AppHandle, limit: Option<u32>) -> AppResult<Vec<ScreenshotRecord>> {
    let records = with_db(&app, |conn| {
        store::list(conn, limit.unwrap_or(DEFAULT_LIST_LIMIT)).map_err(|err| err.to_string())
    })
    .map_err(to_app_error)?;
    allow_screenshot_dirs(&app, &records);
    Ok(records)
}

/// Allow each screenshots folder once. The grid only displays JPEG thumbs; opening one still
/// needs the PNG folder, but neither has to be granted file by file.
fn allow_screenshot_dirs(app: &AppHandle, records: &[ScreenshotRecord]) {
    let mut dirs = HashSet::<PathBuf>::new();
    if let Ok(thumbs) = super::thumbs_dir(app) {
        dirs.insert(thumbs);
    }
    for record in records {
        if !record.file_path.is_empty() {
            push_parent(&mut dirs, Path::new(&record.file_path));
        }
        if let Some(thumb) = &record.thumb_path {
            push_parent(&mut dirs, Path::new(thumb));
        }
    }
    let scope = app.asset_protocol_scope();
    for dir in dirs {
        let _ = scope.allow_directory(&dir, true);
    }
}

fn push_parent(dirs: &mut HashSet<PathBuf>, path: &Path) {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            dirs.insert(parent.to_path_buf());
        }
    }
}

const BACKFILL_DEFAULT: u32 = 4;

/// Build missing library JPEGs from local PNGs, a few at a time, after the grid is already shown.
#[tauri::command]
pub fn screenshot_backfill_thumbs(
    app: AppHandle,
    limit: Option<u32>,
) -> AppResult<Vec<ScreenshotRecord>> {
    let batch = limit.unwrap_or(BACKFILL_DEFAULT).clamp(1, 8);
    // Look past a run of unreadable files so one bad PNG does not block the rest of the library.
    let scan = 64;
    let pending = with_db(&app, |conn| {
        store::list_missing_thumbs(conn, scan).map_err(|err| err.to_string())
    })
    .map_err(to_app_error)?;
    let mut updated = Vec::new();
    for record in pending {
        if updated.len() >= batch as usize {
            break;
        }
        match write_missing_thumb(&app, &record) {
            Ok(Some(next)) => updated.push(next),
            Ok(None) => {}
            Err(err) => {
                tracing::warn!(id = %record.id, %err, "could not build screenshot thumbnail")
            }
        }
    }
    allow_screenshot_dirs(&app, &updated);
    Ok(updated)
}

fn write_missing_thumb(
    app: &AppHandle,
    record: &ScreenshotRecord,
) -> Result<Option<ScreenshotRecord>, String> {
    if record.file_path.is_empty() {
        return Ok(None);
    }
    crate::paths::assert_reveal_allowed(app, &record.file_path).map_err(|err| err.to_string())?;
    let png = std::fs::read(&record.file_path)
        .map_err(|_| "That screenshot is no longer on disk.".to_string())?;
    let frame = super::encode::decode_png(&png)?;
    let jpeg = super::encode::thumbnail(&frame)?;
    let path = store::write_new(&super::thumbs_dir(app)?, &record.id, "jpg", &jpeg)?;
    let thumb_path = path.display().to_string();
    with_db(app, |conn| {
        store::set_thumb_path(conn, &record.id, &thumb_path).map_err(|err| err.to_string())?;
        store::get(conn, &record.id).map_err(|err| err.to_string())
    })?
    .ok_or_else(|| "That screenshot was not found.".to_string())
    .map(Some)
}

/// Remove a screenshot from the Library, and optionally its file on disk and/or cloud copy.
///
/// File deletion goes through the same allow-list as "reveal in folder": a database row is never
/// enough on its own to delete an arbitrary path.
#[tauri::command]
pub fn screenshot_delete(app: AppHandle, id: String, delete_file: bool, delete_cloud: Option<bool>) -> AppResult<()> {
    let record = find(&app, &id)?;
    let drop_cloud = delete_cloud.unwrap_or(false);
    if drop_cloud {
        if let Some(cloud_id) = record.cloud_id.as_deref() {
            let session = super::session::broker()
                .request(&app, false, super::session::SESSION_TIMEOUT)
                .ok_or_else(|| AppError::Message("Sign in to delete the cloud copy.".into()))?;
            super::cloud::delete_remote(&session.api_base, &session.access_token, cloud_id)
                .map_err(|err| AppError::Message(err.message().into()))?;
        }
    }
    if delete_file {
        if !record.file_path.is_empty() {
            remove_owned_file(&app, &record.file_path, "png")?;
        }
        if let Some(thumb) = &record.thumb_path {
            // Thumbnails are regenerable; a failure here is not worth blocking the delete.
            if let Err(err) = remove_owned_file(&app, thumb, "jpg") {
                tracing::warn!(%err, "could not remove screenshot thumbnail");
            }
        }
    }
    if delete_file || !drop_cloud {
        with_db(&app, |conn| store::remove(conn, &id).map_err(|err| err.to_string())).map_err(to_app_error)?;
    } else {
        with_db(&app, |conn| {
            store::set_upload(conn, &id, "local", None, None, None, None).map_err(|err| err.to_string())
        })
        .map_err(to_app_error)?;
    }
    Ok(())
}

/// Copy a saved screenshot again: `"image"` for the picture, `"link"` for its share link.
#[tauri::command]
pub fn screenshot_copy(app: AppHandle, id: String, what: String) -> AppResult<()> {
    let record = find(&app, &id)?;
    match what.as_str() {
        "link" => {
            let url = record
                .share_url
                .filter(|_| record.upload_status == "ready")
                .ok_or_else(|| AppError::Message("This screenshot has no share link yet.".into()))?;
            copy_text(&url)
        }
        "image" => {
            if record.file_path.is_empty() {
                return Err(AppError::Message("That screenshot is only in the cloud.".into()));
            }
            crate::paths::assert_reveal_allowed(&app, &record.file_path)?;
            let bytes = std::fs::read(&record.file_path)
                .map_err(|_| AppError::Message("That screenshot is no longer on disk.".into()))?;
            let frame = super::encode::decode_png(&bytes).map_err(to_app_error)?;
            copy_image(&frame, &bytes)
        }
        _ => Err(AppError::Message("Unknown copy target.".into())),
    }
}

/// Show the screenshot's file in Explorer.
#[tauri::command]
pub fn screenshot_reveal(app: AppHandle, id: String) -> AppResult<()> {
    let record = find(&app, &id)?;
    if record.file_path.is_empty() {
        return Err(AppError::Message("That screenshot is only in the cloud.".into()));
    }
    crate::paths::assert_reveal_allowed(&app, &record.file_path)?;
    crate::library::reveal(&record.file_path)
}

/// Answer a `screenshot-session-request`. Unknown ids are ignored.
#[tauri::command]
pub fn screenshot_provide_session(request_id: u64, access_token: Option<String>, api_base: Option<String>) {
    let session = match (access_token, api_base) {
        (Some(token), Some(base)) if !token.is_empty() && super::cloud::api_base_allowed(&base) => {
            Some(super::session::CloudSession { access_token: token, api_base: base })
        }
        _ => None,
    };
    super::session::broker().provide(request_id, session);
}

#[tauri::command]
pub fn screenshot_retry_upload(app: AppHandle, id: String) -> AppResult<ScreenshotRecord> {
    let record = find(&app, &id)?;
    if record.file_path.is_empty() {
        return Err(AppError::Message("That screenshot is only in the cloud.".into()));
    }
    crate::paths::assert_reveal_allowed(&app, &record.file_path)?;
    let png = std::fs::read(&record.file_path).map_err(|_| AppError::Message("That screenshot is no longer on disk.".into()))?;
    let session = super::session::broker()
        .request(&app, false, super::session::SESSION_TIMEOUT)
        .ok_or_else(|| AppError::Message("Sign in to upload screenshots.".into()))?;
    let mut result = super::cloud::upload(&session.api_base, &session.access_token, &png);
    if matches!(result, Err(super::cloud::CloudError::Unauthorized)) {
        if let Some(next) = super::session::broker().request(&app, true, super::session::SESSION_TIMEOUT) {
            result = super::cloud::upload(&next.api_base, &next.access_token, &png);
        }
    }
    match result {
        Ok(ok) => {
            with_db(&app, |conn| {
                store::set_upload(conn, &id, "ready", Some(&ok.id), Some(&ok.slug), Some(&ok.share_url), None)
                    .map_err(|err| err.to_string())?;
                if !ok.evicted_ids.is_empty() {
                    store::mark_evicted_by_cloud_ids(conn, &ok.evicted_ids).map_err(|err| err.to_string())?;
                }
                Ok(())
            })
            .map_err(to_app_error)?;
            #[cfg(windows)]
            {
                let _ = super::clipboard::set_text(&ok.share_url);
            }
        }
        Err(err) => {
            with_db(&app, |conn| {
                store::set_upload(conn, &id, "failed", None, None, None, Some(err.message())).map_err(|e| e.to_string())
            })
            .map_err(to_app_error)?;
            return Err(AppError::Message(err.message().into()));
        }
    }
    find(&app, &id)
}

/// Save a screenshot PNG to a user-chosen path. Uses the local file when present, otherwise the
/// public cloud PNG.
#[tauri::command]
pub fn screenshot_export(app: AppHandle, id: String, dest: String) -> AppResult<()> {
    let record = find(&app, &id)?;
    let dest_path = std::path::Path::new(&dest);
    let ext_ok = dest_path
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("png"));
    if !ext_ok {
        return Err(AppError::Message("Save the screenshot as a PNG.".into()));
    }
    crate::paths::assert_export_dest_allowed(&app, &dest)?;
    if let Some(parent) = dest_path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| AppError::Message(format!("Could not save the screenshot: {err}")))?;
    }
    if !record.file_path.is_empty() {
        crate::paths::assert_reveal_allowed(&app, &record.file_path)?;
        std::fs::copy(&record.file_path, dest_path)
            .map_err(|err| AppError::Message(format!("Could not save the screenshot: {err}")))?;
        return Ok(());
    }
    let share = record
        .share_url
        .filter(|_| record.upload_status == "ready")
        .ok_or_else(|| AppError::Message("That screenshot has no cloud copy to download.".into()))?;
    let url = format!("{}.png", share.trim_end_matches('/'));
    let png = super::cloud::fetch_png(&url).map_err(|_| AppError::Message("Could not download that screenshot.".into()))?;
    std::fs::write(dest_path, png).map_err(|err| AppError::Message(format!("Could not save the screenshot: {err}")))?;
    Ok(())
}

#[tauri::command]
pub fn screenshot_sync_cloud(app: AppHandle) -> AppResult<Vec<ScreenshotRecord>> {
    let Some(session) = super::session::broker().request(&app, false, super::session::SESSION_TIMEOUT) else {
        return screenshot_list(app, None);
    };
    let remote = super::cloud::list_ready_ids(&session.api_base, &session.access_token).map_err(|err| {
        AppError::Message(err.message().into())
    })?;
    with_db(&app, |conn| {
        let local = store::list(conn, 1000).map_err(|err| err.to_string())?;
        let remote_set: std::collections::HashSet<&str> = remote.iter().map(String::as_str).collect();
        let stale: Vec<String> = local
            .into_iter()
            .filter(|row| row.upload_status == "ready")
            .filter_map(|row| row.cloud_id)
            .filter(|cloud_id| !remote_set.contains(cloud_id.as_str()))
            .collect();
        store::mark_evicted_by_cloud_ids(conn, &stale).map_err(|err| err.to_string())?;
        Ok(())
    })
    .map_err(to_app_error)?;
    screenshot_list(app, None)
}

fn find(app: &AppHandle, id: &str) -> AppResult<ScreenshotRecord> {
    if id.len() > 64 || !id.starts_with("shot-") {
        return Err(AppError::Message("That screenshot was not found.".into()));
    }
    with_db(app, |conn| store::get(conn, id).map_err(|err| err.to_string()))
        .map_err(to_app_error)?
        .ok_or_else(|| AppError::Message("That screenshot was not found.".into()))
}

fn remove_owned_file(app: &AppHandle, path: &str, expected_ext: &str) -> AppResult<()> {
    let candidate = std::path::Path::new(path);
    let ext_ok = candidate
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case(expected_ext));
    if !ext_ok {
        return Err(AppError::Message("Refusing to delete an unexpected file.".into()));
    }
    if !candidate.exists() {
        return Ok(());
    }
    crate::paths::assert_reveal_allowed(app, path)?;
    std::fs::remove_file(candidate).map_err(|err| AppError::Message(format!("Could not delete the file: {err}")))
}

#[cfg(windows)]
fn copy_text(text: &str) -> AppResult<()> {
    super::clipboard::set_text(text).map_err(to_app_error)
}

#[cfg(windows)]
fn copy_image(frame: &crate::still::StillFrame, png: &[u8]) -> AppResult<()> {
    super::clipboard::set_image(frame, png).map_err(to_app_error)
}

#[cfg(not(windows))]
fn copy_text(_text: &str) -> AppResult<()> {
    Err(AppError::Message("Copying is only available on Windows.".into()))
}

#[cfg(not(windows))]
fn copy_image(_frame: &crate::still::StillFrame, _png: &[u8]) -> AppResult<()> {
    Err(AppError::Message("Copying is only available on Windows.".into()))
}
