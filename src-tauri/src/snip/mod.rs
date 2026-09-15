//! Region screenshots: freeze every monitor, drag a rectangle, save it, copy it.
//!
//! Completely independent of Instant Replay, recording and clips. This module starts its own
//! short-lived capture sessions, owns its own windows and its own `screenshots` table, and never
//! reads or writes capture state.
//!
//! Pipeline, all on one dedicated thread per screenshot:
//! 1. `freeze::capture_all` — one-shot capture of every monitor in parallel.
//! 2. `surface::run` — native selection windows; blocks until commit or cancel.
//! 3. crop → `encode` → `store` (file + database row) → `clipboard` → overlay confirmation.
//!
//! Captured screen pixels are wiped on every exit path: `FrozenMonitor` and the surface's display
//! bitmaps zero themselves on drop, and the cropped image is zeroed once it has been saved.

pub mod clipboard;
pub mod commands;
pub mod crop;
pub mod encode;
pub mod geometry;
pub mod store;

#[cfg(windows)]
mod freeze;
#[cfg(windows)]
mod surface;

use std::panic::AssertUnwindSafe;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};

use crate::settings::AppSettings;

/// Total time to wait for every monitor's first frame.
#[cfg_attr(not(windows), allow(dead_code))]
const FREEZE_TIMEOUT: Duration = Duration::from_millis(1500);
/// Lets the main window finish hiding before the screen is frozen, so it is not in the capture.
#[cfg_attr(not(windows), allow(dead_code))]
const HIDE_MAIN_SETTLE: Duration = Duration::from_millis(150);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SnipTrigger {
    Hotkey,
    Tray,
    InApp,
}

/// Only one screenshot surface at a time; a second hotkey press while one is open is ignored.
static ACTIVE: AtomicBool = AtomicBool::new(false);

struct ActiveGuard;

impl Drop for ActiveGuard {
    fn drop(&mut self) {
        ACTIVE.store(false, Ordering::SeqCst);
    }
}

/// Begin a region screenshot. Returns immediately; the work happens on its own thread.
pub fn start(app: &AppHandle, trigger: SnipTrigger) {
    if ACTIVE.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        tracing::info!(?trigger, "a screenshot is already in progress; ignoring");
        return;
    }
    let app = app.clone();
    let spawned = std::thread::Builder::new().name("snip".into()).spawn(move || {
        let _active = ActiveGuard;
        match std::panic::catch_unwind(AssertUnwindSafe(|| run(&app, trigger))) {
            Ok(Ok(())) => {}
            Ok(Err(err)) => {
                tracing::warn!(%err, ?trigger, "screenshot failed");
                let _ = app.emit("screenshot-failed", &err);
                notify_failure(&app, &err);
            }
            Err(panic) => {
                tracing::error!(?panic, "screenshot panicked");
                notify_failure(&app, "Something went wrong taking the screenshot.");
            }
        }
    });
    if let Err(err) = spawned {
        ACTIVE.store(false, Ordering::SeqCst);
        tracing::warn!(%err, "could not start the screenshot thread");
    }
}

#[cfg(not(windows))]
fn run(_app: &AppHandle, _trigger: SnipTrigger) -> Result<(), String> {
    Err("Screenshots are only available on Windows.".into())
}

#[cfg(windows)]
fn run(app: &AppHandle, trigger: SnipTrigger) -> Result<(), String> {
    use zeroize::Zeroize;

    let settings = load_settings(app)?;
    let restore = if trigger == SnipTrigger::InApp { MainWindowRestore::hide(app) } else { MainWindowRestore::none() };
    if restore.was_hidden {
        std::thread::sleep(HIDE_MAIN_SETTLE);
    }

    let started = Instant::now();
    let frozen = freeze::capture_all(FREEZE_TIMEOUT)?;
    let freeze_ms = started.elapsed().as_millis() as u64;
    tracing::info!(freeze_ms, monitors = frozen.len(), ?trigger, "screenshot surface ready");

    let outcome = surface::run(frozen)?;
    // Bring Replayr back as soon as the surface closes, not after saving.
    drop(restore);

    match outcome {
        surface::Outcome::Cancel(reason) => {
            tracing::info!(?reason, "screenshot cancelled");
            Ok(())
        }
        surface::Outcome::Commit { mut image, monitor_rect } => {
            let result = save(app, &settings, &image, monitor_rect);
            image.bgra.zeroize();
            result
        }
    }
}

#[cfg(windows)]
fn save(
    app: &AppHandle,
    settings: &AppSettings,
    image: &crate::still::StillFrame,
    monitor_rect: geometry::PhysRect,
) -> Result<(), String> {
    use crate::overlay_notification::{notify_screenshot, MonitorInfo, ScreenshotNotice};

    let started = Instant::now();
    let png = encode::png(image)?;
    let encode_ms = started.elapsed().as_millis() as u64;

    let dir = screenshots_dir(app, settings)?;
    crate::disk::ensure_free_space(&dir, settings.min_free_disk_bytes).map_err(|err| err.to_string())?;
    let id = store::new_id();
    let path = store::write_new(&dir, &store::file_stem(store::LocalStamp::now()), "png", &png)?;
    crate::paths::allow_asset_file(app, &path);

    // A missing thumbnail only costs the Library a fallback; never fail the screenshot over it.
    let thumb_path = encode::thumbnail(image)
        .ok()
        .and_then(|bytes| thumbs_dir(app).ok().map(|dir| (dir, bytes)))
        .and_then(|(dir, bytes)| store::write_new(&dir, &id, "jpg", &bytes).ok())
        .inspect(|thumb| crate::paths::allow_asset_file(app, thumb));

    let record = store::ScreenshotRecord {
        id,
        file_path: path.display().to_string(),
        thumb_path: thumb_path.map(|thumb| thumb.display().to_string()),
        width: image.width,
        height: image.height,
        file_size: png.len() as u64,
        created_at: store::now_iso(),
        cloud_id: None,
        slug: None,
        share_url: None,
        upload_status: "local".into(),
        upload_error: None,
    };
    with_db(app, |conn| store::insert(conn, &record).map_err(|err| err.to_string()))?;

    let copied = clipboard::set_image(image, &png);
    if let Err(err) = &copied {
        tracing::warn!(%err, "screenshot saved but could not be copied");
    }

    tracing::info!(
        id = %record.id,
        width = image.width,
        height = image.height,
        bytes = png.len(),
        encode_ms,
        total_ms = started.elapsed().as_millis() as u64,
        "screenshot saved"
    );

    if copied.is_ok() {
        notify_screenshot(
            app,
            MonitorInfo { x: monitor_rect.x, y: monitor_rect.y, width: monitor_rect.w, height: monitor_rect.h },
            ScreenshotNotice::ImageCopied,
        );
    }
    let _ = app.emit("screenshot-saved", &record);
    Ok(())
}

/// `{save location}\Screenshots`, alongside clips but in its own folder.
pub(crate) fn screenshots_dir(app: &AppHandle, settings: &AppSettings) -> Result<PathBuf, String> {
    let base = if settings.save_location.trim().is_empty() {
        app.path()
            .video_dir()
            .or_else(|_| app.path().document_dir())
            .map_err(|err| err.to_string())?
            .join("Project Replay")
    } else {
        PathBuf::from(settings.save_location.trim())
    };
    let dir = base.join("Screenshots");
    std::fs::create_dir_all(&dir).map_err(|err| format!("Could not create the screenshots folder: {err}"))?;
    Ok(dir)
}

pub(crate) fn thumbs_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|err| err.to_string())?.join("screenshot-thumbs");
    std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir)
}

pub(crate) fn load_settings(app: &AppHandle) -> Result<AppSettings, String> {
    with_db(app, |conn| crate::settings::load(conn).map_err(|err| err.to_string()))
}

pub(crate) fn with_db<T>(
    app: &AppHandle,
    work: impl FnOnce(&rusqlite::Connection) -> Result<T, String>,
) -> Result<T, String> {
    let state = app.state::<crate::database::AppState>();
    let conn = state.db.lock().map_err(|err| err.to_string())?;
    work(&conn)
}

fn notify_failure(app: &AppHandle, message: &str) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app.notification().builder().title("Screenshot failed").body(message).show();
}

/// Hides the main window for an in-app screenshot and always brings it back.
#[cfg_attr(not(windows), allow(dead_code))]
struct MainWindowRestore {
    app: Option<AppHandle>,
    was_hidden: bool,
}

#[cfg_attr(not(windows), allow(dead_code))]
impl MainWindowRestore {
    fn none() -> Self {
        Self { app: None, was_hidden: false }
    }

    fn hide(app: &AppHandle) -> Self {
        let Some(window) = app.get_webview_window("main") else {
            return Self::none();
        };
        if !window.is_visible().unwrap_or(false) {
            return Self::none();
        }
        let _ = window.hide();
        Self { app: Some(app.clone()), was_hidden: true }
    }
}

impl Drop for MainWindowRestore {
    fn drop(&mut self) {
        if !self.was_hidden {
            return;
        }
        if let Some(window) = self.app.as_ref().and_then(|app| app.get_webview_window("main")) {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}
