//! Tauri commands for region screenshots.

use tauri::AppHandle;

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

/// Newest screenshots first, with their files allowed through the asset protocol for display.
#[tauri::command]
pub fn screenshot_list(app: AppHandle, limit: Option<u32>) -> AppResult<Vec<ScreenshotRecord>> {
    let records = with_db(&app, |conn| {
        store::list(conn, limit.unwrap_or(DEFAULT_LIST_LIMIT)).map_err(|err| err.to_string())
    })
    .map_err(to_app_error)?;
    for record in &records {
        crate::paths::allow_asset_file(&app, std::path::Path::new(&record.file_path));
        if let Some(thumb) = &record.thumb_path {
            crate::paths::allow_asset_file(&app, std::path::Path::new(thumb));
        }
    }
    Ok(records)
}

/// Remove a screenshot from the Library, and optionally its file on disk.
///
/// File deletion goes through the same allow-list as "reveal in folder": a database row is never
/// enough on its own to delete an arbitrary path.
#[tauri::command]
pub fn screenshot_delete(app: AppHandle, id: String, delete_file: bool) -> AppResult<()> {
    let record = find(&app, &id)?;
    if delete_file {
        remove_owned_file(&app, &record.file_path, "png")?;
        if let Some(thumb) = &record.thumb_path {
            // Thumbnails are regenerable; a failure here is not worth blocking the delete.
            if let Err(err) = remove_owned_file(&app, thumb, "jpg") {
                tracing::warn!(%err, "could not remove screenshot thumbnail");
            }
        }
    }
    with_db(&app, |conn| store::remove(conn, &id).map_err(|err| err.to_string())).map_err(to_app_error)?;
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
    crate::paths::assert_reveal_allowed(&app, &record.file_path)?;
    crate::library::reveal(&record.file_path)
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
