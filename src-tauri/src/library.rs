use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::camera::webcam_sidecar_path;
use crate::database::AppState;
use crate::error::{AppError, AppResult};
use crate::overlay::OverlayLayout;
use crate::still::{scale_bgra, write_bgra_bmp, StillFrame};

pub const SOURCE_GAMEPLAY: &str = "gameplay";
pub const SOURCE_WEBCAM: &str = "webcam";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipSourceDto {
    pub id: i64,
    pub clip_id: String,
    pub source_instance_id: String,
    pub kind: String,
    pub file_path: String,
    pub role: String,
    pub start_hns: i64,
    pub duration_hns: Option<i64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub fps: Option<i64>,
    pub health: String,
    pub layout_json: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalClipDto {
    pub local_id: String,
    pub cloud_clip_id: Option<String>,
    pub file_path: String,
    pub thumbnail_path: Option<String>,
    pub game_id: Option<String>,
    pub created_at: String,
    pub duration_ms: Option<i64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub fps: Option<i64>,
    pub file_size: Option<i64>,
    pub upload_status: String,
    pub favorite: bool,
    pub title: Option<String>,
    pub description: Option<String>,
    pub source_clip_id: Option<String>,
    pub source_start_ms: Option<i64>,
    pub source_end_ms: Option<i64>,
    pub editor_crop_x: f64,
    #[serde(default)]
    pub sources: Vec<ClipSourceDto>,
}

pub struct ClipLineage {
    pub source_clip_id: String,
    pub source_start_ms: i64,
    pub source_end_ms: i64,
}

pub fn insert(
    app: &AppHandle,
    path: &Path,
    duration_ms: u64,
    width: u32,
    height: u32,
    fps: u32,
    game_id: Option<String>,
    title: String,
    preview: Option<&StillFrame>,
) -> AppResult<String> {
    let local_id = format!(
        "clip-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );
    let thumbnail_path = preview
        .and_then(|frame| preview_thumb(path, &local_id, frame))
        .or_else(|| thumbnail_for(path, &local_id));
    let file_size = std::fs::metadata(path).map(|meta| meta.len() as i64).unwrap_or(0);
    let db = app.state::<AppState>();
    let conn = db.db.lock().map_err(|err| AppError::Message(err.to_string()))?;
    insert_row(
        &conn,
        &local_id,
        path,
        thumbnail_path.as_ref(),
        game_id,
        duration_ms,
        width,
        height,
        fps,
        file_size,
        title,
        None,
    )?;
    Ok(local_id)
}

pub fn insert_derived(
    app: &AppHandle,
    path: &Path,
    duration_ms: u64,
    width: u32,
    height: u32,
    fps: u32,
    game_id: Option<String>,
    title: String,
    preview: Option<&StillFrame>,
    lineage: ClipLineage,
) -> AppResult<String> {
    let local_id = format!(
        "clip-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );
    let thumbnail_path = preview
        .and_then(|frame| preview_thumb(path, &local_id, frame))
        .or_else(|| thumbnail_for(path, &local_id));
    let file_size = std::fs::metadata(path).map(|meta| meta.len() as i64).unwrap_or(0);
    let db = app.state::<AppState>();
    let conn = db.db.lock().map_err(|err| AppError::Message(err.to_string()))?;
    insert_row(
        &conn,
        &local_id,
        path,
        thumbnail_path.as_ref(),
        game_id,
        duration_ms,
        width,
        height,
        fps,
        file_size,
        title,
        Some(&lineage),
    )?;
    Ok(local_id)
}

fn insert_row(
    conn: &Connection,
    local_id: &str,
    path: &Path,
    thumbnail_path: Option<&PathBuf>,
    game_id: Option<String>,
    duration_ms: u64,
    width: u32,
    height: u32,
    fps: u32,
    file_size: i64,
    title: String,
    lineage: Option<&ClipLineage>,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO local_clips (
            local_id, cloud_clip_id, file_path, thumbnail_path, game_id, created_at,
            duration_ms, width, height, fps, file_size, upload_status, favorite, title, description,
            source_clip_id, source_start_ms, source_end_ms, editor_crop_x
         ) VALUES (?1, NULL, ?2, ?3, ?4, datetime('now'), ?5, ?6, ?7, ?8, ?9, 'local', 0, ?10, NULL, ?11, ?12, ?13, 0.5)",
        rusqlite::params![
            local_id,
            path.display().to_string(),
            thumbnail_path.map(|p| p.display().to_string()),
            game_id,
            duration_ms as i64,
            width as i64,
            height as i64,
            fps as i64,
            file_size,
            title,
            lineage.map(|row| row.source_clip_id.as_str()),
            lineage.map(|row| row.source_start_ms),
            lineage.map(|row| row.source_end_ms),
        ],
    )?;
    attach_saved_sources(
        conn,
        local_id,
        path,
        duration_ms,
        width,
        height,
        fps,
        webcam_layout_from_settings(conn),
    );
    Ok(())
}

fn webcam_layout_from_settings(conn: &Connection) -> Option<(u32, u32, u32, OverlayLayout)> {
    crate::settings::load(conn).ok().map(|settings| {
        (
            settings.webcam.width,
            settings.webcam.height,
            settings.webcam.fps,
            OverlayLayout::new(
                &settings.webcam.default_placement,
                &settings.webcam.default_shape,
                settings.webcam.default_width,
            ),
        )
    })
}

/// Attach gameplay always. Attach webcam only when the sidecar exists and is non-empty.
/// Failures are logged and never fail the clip insert.
pub fn attach_saved_sources(
    conn: &Connection,
    local_id: &str,
    gameplay_path: &Path,
    duration_ms: u64,
    width: u32,
    height: u32,
    fps: u32,
    webcam_meta: Option<(u32, u32, u32, OverlayLayout)>,
) {
    let duration_hns = (duration_ms as i64).saturating_mul(10_000);
    if let Err(err) = attach_source(
        conn,
        NewClipSource {
            clip_id: local_id,
            source_instance_id: SOURCE_GAMEPLAY,
            kind: SOURCE_GAMEPLAY,
            file_path: &gameplay_path.display().to_string(),
            role: "primary",
            start_hns: 0,
            duration_hns: Some(duration_hns),
            width: Some(width as i64),
            height: Some(height as i64),
            fps: Some(fps as i64),
            health: "valid",
            layout_json: None,
        },
    ) {
        tracing::warn!(%err, local_id, "could not attach gameplay source");
    }

    let sidecar = webcam_sidecar_path(gameplay_path);
    let sidecar_ok = std::fs::metadata(&sidecar)
        .map(|meta| meta.is_file() && meta.len() > 0)
        .unwrap_or(false);
    if !sidecar_ok {
        return;
    }
    let (cam_w, cam_h, cam_fps, layout) = webcam_meta.unwrap_or((0, 0, 0, OverlayLayout::default()));
    let layout_json = layout.to_json();
    let path = sidecar.display().to_string();
    if let Err(err) = attach_source(
        conn,
        NewClipSource {
            clip_id: local_id,
            source_instance_id: SOURCE_WEBCAM,
            kind: SOURCE_WEBCAM,
            file_path: &path,
            role: "overlay",
            start_hns: 0,
            duration_hns: Some(duration_hns),
            width: Some(cam_w as i64),
            height: Some(cam_h as i64),
            fps: Some(cam_fps as i64),
            health: "valid",
            layout_json: Some(&layout_json),
        },
    ) {
        tracing::warn!(%err, local_id, "could not attach webcam source; gameplay clip is intact");
    }
}

pub struct NewClipSource<'a> {
    pub clip_id: &'a str,
    pub source_instance_id: &'a str,
    pub kind: &'a str,
    pub file_path: &'a str,
    pub role: &'a str,
    pub start_hns: i64,
    pub duration_hns: Option<i64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub fps: Option<i64>,
    pub health: &'a str,
    pub layout_json: Option<&'a str>,
}

pub fn attach_source(conn: &Connection, source: NewClipSource<'_>) -> AppResult<()> {
    conn.execute(
        "INSERT INTO clip_sources (
            clip_id, source_instance_id, kind, file_path, role, start_hns, duration_hns,
            width, height, fps, health, layout_json, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, datetime('now'))
         ON CONFLICT(clip_id, source_instance_id) DO UPDATE SET
            kind = excluded.kind,
            file_path = excluded.file_path,
            role = excluded.role,
            start_hns = excluded.start_hns,
            duration_hns = excluded.duration_hns,
            width = excluded.width,
            height = excluded.height,
            fps = excluded.fps,
            health = excluded.health,
            layout_json = excluded.layout_json",
        rusqlite::params![
            source.clip_id,
            source.source_instance_id,
            source.kind,
            source.file_path,
            source.role,
            source.start_hns,
            source.duration_hns,
            source.width,
            source.height,
            source.fps,
            source.health,
            source.layout_json,
        ],
    )?;
    Ok(())
}

pub fn list_sources(conn: &Connection, clip_id: &str) -> AppResult<Vec<ClipSourceDto>> {
    let mut stmt = conn.prepare(
        "SELECT id, clip_id, source_instance_id, kind, file_path, role, start_hns, duration_hns,
                width, height, fps, health, layout_json, created_at
         FROM clip_sources
         WHERE clip_id = ?1
         ORDER BY id",
    )?;
    let rows = stmt.query_map([clip_id], map_source)?;
    let mut sources = Vec::new();
    for row in rows {
        sources.push(row?);
    }
    Ok(sources)
}

pub fn set_source_layout(
    conn: &Connection,
    clip_id: &str,
    source_instance_id: &str,
    layout: OverlayLayout,
) -> AppResult<LocalClipDto> {
    let mut layout = layout;
    layout.sanitize();
    let json = layout.to_json();
    let changed = conn.execute(
        "UPDATE clip_sources SET layout_json = ?1 WHERE clip_id = ?2 AND source_instance_id = ?3",
        rusqlite::params![json, clip_id, source_instance_id],
    )?;
    if changed == 0 {
        return Err(AppError::Message("Webcam source not found.".into()));
    }
    get(conn, clip_id)
}

pub fn valid_webcam_source(clip: &LocalClipDto) -> Option<&ClipSourceDto> {
    clip.sources.iter().find(|source| {
        source.kind == SOURCE_WEBCAM
            && source.health.eq_ignore_ascii_case("valid")
            && source_file_ok(&source.file_path)
    })
}

fn source_file_ok(path: &str) -> bool {
    std::fs::metadata(path)
        .map(|meta| meta.is_file() && meta.len() > 0)
        .unwrap_or(false)
}

fn with_sources(conn: &Connection, mut clip: LocalClipDto) -> AppResult<LocalClipDto> {
    clip.sources = list_sources(conn, &clip.local_id)?;
    Ok(clip)
}

fn map_source(row: &rusqlite::Row<'_>) -> rusqlite::Result<ClipSourceDto> {
    Ok(ClipSourceDto {
        id: row.get(0)?,
        clip_id: row.get(1)?,
        source_instance_id: row.get(2)?,
        kind: row.get(3)?,
        file_path: row.get(4)?,
        role: row.get(5)?,
        start_hns: row.get(6)?,
        duration_hns: row.get(7)?,
        width: row.get(8)?,
        height: row.get(9)?,
        fps: row.get(10)?,
        health: row.get(11)?,
        layout_json: row.get(12)?,
        created_at: row.get(13)?,
    })
}

pub fn list(conn: &Connection, limit: i64) -> AppResult<Vec<LocalClipDto>> {
    let mut stmt = conn.prepare(
        "SELECT local_id, cloud_clip_id, file_path, thumbnail_path, game_id, created_at,
                duration_ms, width, height, fps, file_size, upload_status, favorite, title, description,
                source_clip_id, source_start_ms, source_end_ms, editor_crop_x
         FROM local_clips
         ORDER BY created_at DESC
         LIMIT ?1",
    )?;
    let rows = stmt.query_map([limit], map_clip)?;
    let mut clips = Vec::new();
    for row in rows {
        clips.push(row?);
    }
    drop(stmt);
    for clip in &mut clips {
        if clip.thumbnail_path.is_none() {
            let path = PathBuf::from(&clip.file_path);
            if let Some(thumb) = thumbnail_for(&path, &clip.local_id) {
                conn.execute(
                    "UPDATE local_clips SET thumbnail_path = ?1 WHERE local_id = ?2",
                    rusqlite::params![thumb.display().to_string(), clip.local_id],
                )?;
                clip.thumbnail_path = Some(thumb.display().to_string());
            }
        }
    }
    for clip in &mut clips {
        clip.sources = list_sources(conn, &clip.local_id).unwrap_or_default();
    }
    Ok(clips)
}

pub fn rename(conn: &Connection, local_id: &str, title: &str) -> AppResult<LocalClipDto> {
    let title = title.trim();
    if title.is_empty() {
        return Err(AppError::Message("Clip name cannot be empty.".into()));
    }
    let changed = conn.execute(
        "UPDATE local_clips SET title = ?1 WHERE local_id = ?2",
        rusqlite::params![title, local_id],
    )?;
    if changed == 0 {
        return Err(AppError::Message("Clip not found.".into()));
    }
    get(conn, local_id)
}

pub fn set_favorite(conn: &Connection, local_id: &str, favorite: bool) -> AppResult<LocalClipDto> {
    let changed = conn.execute(
        "UPDATE local_clips SET favorite = ?1 WHERE local_id = ?2",
        rusqlite::params![if favorite { 1 } else { 0 }, local_id],
    )?;
    if changed == 0 {
        return Err(AppError::Message("Clip not found.".into()));
    }
    get(conn, local_id)
}

pub fn set_cloud(
    conn: &Connection,
    local_id: &str,
    status: &str,
    cloud_clip_id: Option<&str>,
    error: Option<&str>,
) -> AppResult<LocalClipDto> {
    let changed = conn.execute(
        "UPDATE local_clips SET upload_status = ?1, cloud_clip_id = COALESCE(?2, cloud_clip_id) WHERE local_id = ?3",
        rusqlite::params![status, cloud_clip_id, local_id],
    )?;
    if changed == 0 {
        return Err(AppError::Message("Clip not found.".into()));
    }
    conn.execute(
        "INSERT INTO upload_queue (local_clip_id, cloud_clip_id, attempts, uploaded_bytes, status, last_error, created_at, updated_at)
         VALUES (?1, ?2, 1, 0, ?3, ?4, datetime('now'), datetime('now'))
         ON CONFLICT(local_clip_id) DO UPDATE SET
            cloud_clip_id = COALESCE(excluded.cloud_clip_id, upload_queue.cloud_clip_id),
            attempts = upload_queue.attempts + 1,
            status = excluded.status,
            last_error = excluded.last_error,
            updated_at = datetime('now')",
        rusqlite::params![local_id, cloud_clip_id, status, error],
    )?;
    get(conn, local_id)
}

/// Clears in-flight upload rows left behind when the app crashed mid-upload.
/// Keeps resume metadata so a retry can continue multipart instead of restarting.
pub fn reset_stale_uploads(conn: &Connection) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT local_id FROM local_clips
         WHERE upload_status IN ('queued', 'preparing', 'uploading', 'processing')",
    )?;
    let ids: Vec<String> = stmt
        .query_map([], |row| row.get(0))?
        .filter_map(|row| row.ok())
        .collect();
    if ids.is_empty() {
        return Ok(ids);
    }
    conn.execute(
        "UPDATE local_clips SET upload_status = 'failed'
         WHERE upload_status IN ('queued', 'preparing', 'uploading', 'processing')",
        [],
    )?;
    conn.execute(
        "UPDATE upload_queue SET status = 'failed', last_error = COALESCE(last_error, 'Upload interrupted'), updated_at = datetime('now')
         WHERE status IN ('queued', 'preparing', 'uploading', 'processing')",
        [],
    )?;
    Ok(ids)
}

pub fn save_upload_resume(conn: &Connection, local_id: &str, resume_json: &str, uploaded_bytes: u64) -> AppResult<()> {
    conn.execute(
        "UPDATE upload_queue SET resume_json = ?1, uploaded_bytes = ?2, updated_at = datetime('now') WHERE local_clip_id = ?3",
        rusqlite::params![resume_json, uploaded_bytes as i64, local_id],
    )?;
    Ok(())
}

pub fn load_upload_resume(conn: &Connection, local_id: &str) -> AppResult<Option<String>> {
    let mut stmt = conn.prepare("SELECT resume_json FROM upload_queue WHERE local_clip_id = ?1")?;
    let value: Option<Option<String>> = stmt
        .query_row([local_id], |row| row.get(0))
        .optional()?;
    Ok(value.flatten().filter(|text| !text.is_empty()))
}

pub fn clear_upload_resume(conn: &Connection, local_id: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE upload_queue SET resume_json = NULL, uploaded_bytes = 0, updated_at = datetime('now') WHERE local_clip_id = ?1",
        [local_id],
    )?;
    Ok(())
}

pub fn clear_cloud_link(conn: &Connection, cloud_clip_id: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE local_clips SET upload_status = 'local', cloud_clip_id = NULL WHERE cloud_clip_id = ?1",
        [cloud_clip_id],
    )?;
    conn.execute(
        "UPDATE upload_queue SET status = 'cancelled', cloud_clip_id = NULL, updated_at = datetime('now') WHERE cloud_clip_id = ?1",
        [cloud_clip_id],
    )?;
    Ok(())
}

pub fn delete(conn: &Connection, local_id: &str) -> AppResult<()> {
    let clip = get(conn, local_id)?;
    let mut paths = vec![clip.file_path.clone()];
    if let Some(thumb) = clip.thumbnail_path.as_ref() {
        if thumb != &clip.file_path {
            paths.push(thumb.clone());
        }
    }
    for source in &clip.sources {
        if !paths.iter().any(|path| path == &source.file_path) {
            paths.push(source.file_path.clone());
        }
    }
    let play = playback_sidecar_path(Path::new(&clip.file_path));
    if play != Path::new(&clip.file_path) {
        paths.push(play.to_string_lossy().into_owned());
    }
    conn.execute("DELETE FROM local_clips WHERE local_id = ?1", [local_id])?;
    for path in paths {
        remove_media(&path);
    }
    Ok(())
}

pub fn set_editor_crop(app: &AppHandle, local_id: &str, pan: f32) -> AppResult<LocalClipDto> {
    let pan = f64::from(pan).clamp(0.0, 1.0);
    let db = app.state::<AppState>();
    let conn = db.db.lock().map_err(|err| AppError::Message(err.to_string()))?;
    let changed = conn.execute(
        "UPDATE local_clips SET editor_crop_x = ?1 WHERE local_id = ?2",
        rusqlite::params![pan, local_id],
    )?;
    if changed == 0 {
        return Err(AppError::Message("Clip not found.".into()));
    }
    get(&conn, local_id)
}

pub fn playback_sidecar_path(path: &Path) -> PathBuf {
    let name = path.file_name().and_then(|name| name.to_str()).unwrap_or("");
    if name.ends_with(".play.mp4") {
        return path.to_path_buf();
    }
    let stem = path.file_stem().and_then(|stem| stem.to_str()).unwrap_or("clip");
    path.with_file_name(format!("{stem}.play.mp4"))
}

fn sidecar_is_current(src: &Path, dest: &Path) -> bool {
    let Ok(play) = dest.metadata() else {
        return false;
    };
    if play.len() < 32 {
        return false;
    }
    let Ok(source) = src.metadata() else {
        return false;
    };
    match (play.modified(), source.modified()) {
        (Ok(play_mtime), Ok(source_mtime)) => play_mtime >= source_mtime,
        _ => true,
    }
}

/// Copy-remux a local MP4 into a WebView-playable sidecar. Original file is unchanged.
pub fn prepare_playback(app: &AppHandle, local_id: &str) -> AppResult<String> {
    let db = app.state::<AppState>();
    let conn = db.db.lock().map_err(|err| AppError::Message(err.to_string()))?;
    let clip = get(&conn, local_id)?;
    drop(conn);
    crate::paths::assert_reveal_allowed(app, &clip.file_path)?;
    let src = PathBuf::from(&clip.file_path);
    if !src
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("mp4"))
    {
        return Ok(clip.file_path);
    }
    let dest = playback_sidecar_path(&src);
    if dest == src {
        return Ok(clip.file_path);
    }
    if sidecar_is_current(&src, &dest) {
        return Ok(dest.to_string_lossy().into_owned());
    }
    crate::export::remux_composed_mp4(&src, &dest).map_err(AppError::Message)?;
    Ok(dest.to_string_lossy().into_owned())
}

pub fn get(conn: &Connection, local_id: &str) -> AppResult<LocalClipDto> {
    conn.query_row(
        "SELECT local_id, cloud_clip_id, file_path, thumbnail_path, game_id, created_at,
                duration_ms, width, height, fps, file_size, upload_status, favorite, title, description,
                source_clip_id, source_start_ms, source_end_ms, editor_crop_x
         FROM local_clips WHERE local_id = ?1",
        [local_id],
        map_clip,
    )
    .map_err(|err| match err {
        rusqlite::Error::QueryReturnedNoRows => AppError::Message("Clip not found.".into()),
        other => AppError::Sqlite(other),
    })
    .and_then(|clip| with_sources(conn, clip))
}

pub fn reveal(path: &str) -> AppResult<()> {
    let path = PathBuf::from(path);
    if !path.exists() {
        return Err(AppError::Message("That file is no longer on disk.".into()));
    }
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg("/select,")
            .arg(&path)
            .spawn()
            .map_err(|err| AppError::Message(err.to_string()))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&path)
            .spawn()
            .map_err(|err| AppError::Message(err.to_string()))?;
    }
    Ok(())
}

pub fn export_copy(source: &str, dest: &str) -> AppResult<()> {
    let source = PathBuf::from(source);
    let dest = PathBuf::from(dest);
    if !source.exists() {
        return Err(AppError::Message("That file is no longer on disk.".into()));
    }
    if dest.as_os_str().is_empty() {
        return Err(AppError::Message("Choose a download location.".into()));
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::copy(&source, &dest)?;
    Ok(())
}

fn map_clip(row: &rusqlite::Row<'_>) -> rusqlite::Result<LocalClipDto> {
    Ok(LocalClipDto {
        local_id: row.get(0)?,
        cloud_clip_id: row.get(1)?,
        file_path: row.get(2)?,
        thumbnail_path: row.get(3)?,
        game_id: row.get(4)?,
        created_at: row.get(5)?,
        duration_ms: row.get(6)?,
        width: row.get(7)?,
        height: row.get(8)?,
        fps: row.get(9)?,
        file_size: row.get(10)?,
        upload_status: row.get(11)?,
        favorite: row.get::<_, i64>(12)? != 0,
        title: row.get(13)?,
        description: row.get(14)?,
        source_clip_id: row.get(15)?,
        source_start_ms: row.get(16)?,
        source_end_ms: row.get(17)?,
        editor_crop_x: row.get::<_, Option<f64>>(18)?.unwrap_or(0.5).clamp(0.0, 1.0),
        sources: Vec::new(),
    })
}

fn preview_thumb(path: &Path, local_id: &str, frame: &StillFrame) -> Option<PathBuf> {
    let dest = path.parent()?.join(".thumbs").join(format!("{local_id}.bmp"));
    write_bgra_bmp(&dest, &scale_bgra(frame, 480)).ok()?;
    Some(dest)
}

fn thumbnail_for(path: &Path, local_id: &str) -> Option<PathBuf> {
    if !path.exists() {
        return None;
    }
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if matches!(ext.as_str(), "bmp" | "png" | "jpg" | "jpeg" | "webp") {
        return Some(path.to_path_buf());
    }
    let dest = path.parent()?.join(".thumbs").join(format!("{local_id}.bmp"));
    #[cfg(windows)]
    {
        crate::thumb::from_video(path, &dest).ok()?;
        Some(dest)
    }
    #[cfg(not(windows))]
    {
        let _ = dest;
        None
    }
}

fn remove_media(path: &str) {
    let path = PathBuf::from(path);
    if path.components().any(|part| part.as_os_str() == ".replay-buffer") {
        return;
    }
    let _ = std::fs::remove_file(path);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::{migrate, open_path};
    use tempfile::tempdir;

    fn seed(conn: &Connection, id: &str, title: &str) {
        conn.execute(
            "INSERT INTO local_clips (
                local_id, file_path, created_at, upload_status, favorite, title
             ) VALUES (?1, ?2, datetime('now'), 'local', 0, ?3)",
            rusqlite::params![id, format!("C:/clips/{id}.mp4"), title],
        )
        .unwrap();
    }

    #[test]
    fn rename_favorite_and_delete() {
        let dir = tempdir().unwrap();
        let conn = open_path(&dir.path().join("db.sqlite")).unwrap();
        migrate(&conn).unwrap();
        seed(&conn, "clip-1", "Old");
        let renamed = rename(&conn, "clip-1", "Highlight").unwrap();
        assert_eq!(renamed.title.as_deref(), Some("Highlight"));
        let fav = set_favorite(&conn, "clip-1", true).unwrap();
        assert!(fav.favorite);
        delete(&conn, "clip-1").unwrap();
        assert!(get(&conn, "clip-1").is_err());
    }

    #[test]
    fn cloud_status_writes_queue() {
        let dir = tempdir().unwrap();
        let conn = open_path(&dir.path().join("db.sqlite")).unwrap();
        migrate(&conn).unwrap();
        seed(&conn, "clip-2", "Upload me");
        let next = set_cloud(&conn, "clip-2", "completed", Some("cloud-1"), None).unwrap();
        assert_eq!(next.upload_status, "completed");
        assert_eq!(next.cloud_clip_id.as_deref(), Some("cloud-1"));
        let status: String = conn
            .query_row(
                "SELECT status FROM upload_queue WHERE local_clip_id = 'clip-2'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "completed");
    }

    #[test]
    fn reset_stale_uploads_clears_in_flight() {
        let dir = tempdir().unwrap();
        let conn = open_path(&dir.path().join("db.sqlite")).unwrap();
        migrate(&conn).unwrap();
        seed(&conn, "clip-3", "Stuck");
        set_cloud(&conn, "clip-3", "uploading", Some("cloud-pending"), None).unwrap();
        let ids = reset_stale_uploads(&conn).unwrap();
        assert_eq!(ids, vec!["clip-3".to_string()]);
        let clip = get(&conn, "clip-3").unwrap();
        assert_eq!(clip.upload_status, "local");
        assert_eq!(clip.cloud_clip_id, None);
    }

    #[test]
    fn lineage_columns_exist_after_migrate() {
        let dir = tempdir().unwrap();
        let conn = open_path(&dir.path().join("db.sqlite")).unwrap();
        migrate(&conn).unwrap();
        seed(&conn, "clip-3", "Source");
        conn.execute(
            "UPDATE local_clips SET source_clip_id = 'clip-3', source_start_ms = 1000, source_end_ms = 4000 WHERE local_id = 'clip-3'",
            [],
        )
        .unwrap();
        let clip = get(&conn, "clip-3").unwrap();
        assert_eq!(clip.source_clip_id.as_deref(), Some("clip-3"));
        assert_eq!(clip.source_start_ms, Some(1000));
        assert_eq!(clip.source_end_ms, Some(4000));
        conn.execute(
            "UPDATE local_clips SET editor_crop_x = 0.25 WHERE local_id = 'clip-3'",
            [],
        )
        .unwrap();
        let framed = get(&conn, "clip-3").unwrap();
        assert!((framed.editor_crop_x - 0.25).abs() < f64::EPSILON);
    }

    #[test]
    fn clip_sources_unique_fk_and_optional_webcam() {
        let dir = tempdir().unwrap();
        let conn = open_path(&dir.path().join("db.sqlite")).unwrap();
        migrate(&conn).unwrap();
        seed(&conn, "clip-src", "Gameplay");
        let gameplay = dir.path().join("clip-src.mp4");
        std::fs::write(&gameplay, b"gameplay").unwrap();

        attach_saved_sources(&conn, "clip-src", &gameplay, 8_000, 1920, 1080, 60, None);
        let clip = get(&conn, "clip-src").unwrap();
        assert_eq!(clip.sources.len(), 1);
        assert_eq!(clip.sources[0].kind, SOURCE_GAMEPLAY);
        assert!(valid_webcam_source(&clip).is_none());

        let sidecar = webcam_sidecar_path(&gameplay);
        std::fs::write(&sidecar, b"webcam").unwrap();
        let layout = OverlayLayout::new("top-left", "circle", 0.18);
        attach_saved_sources(
            &conn,
            "clip-src",
            &gameplay,
            8_000,
            1920,
            1080,
            60,
            Some((1280, 720, 30, layout.clone())),
        );
        let clip = get(&conn, "clip-src").unwrap();
        assert_eq!(clip.sources.len(), 2);
        let webcam = clip.sources.iter().find(|s| s.kind == SOURCE_WEBCAM).unwrap();
        assert_eq!(webcam.source_instance_id, SOURCE_WEBCAM);
        assert_eq!(webcam.role, "overlay");
        let parsed = OverlayLayout::from_json(webcam.layout_json.as_deref());
        assert_eq!(parsed.placement, "top-left");
        assert_eq!(parsed.shape, "circle");

        let duplicate = conn.execute(
            "INSERT INTO clip_sources (
                clip_id, source_instance_id, kind, file_path, role, start_hns, health, created_at
             ) VALUES ('clip-src', 'webcam', 'webcam', 'other.mp4', 'overlay', 0, 'valid', datetime('now'))",
            [],
        );
        assert!(duplicate.is_err());

        let updated = set_source_layout(&conn, "clip-src", SOURCE_WEBCAM, OverlayLayout::new("bottom-right", "rounded", 0.22)).unwrap();
        let webcam = updated.sources.iter().find(|s| s.kind == SOURCE_WEBCAM).unwrap();
        assert_eq!(OverlayLayout::from_json(webcam.layout_json.as_deref()).placement, "bottom-right");

        delete(&conn, "clip-src").unwrap();
        assert!(get(&conn, "clip-src").is_err());
        let leftover: i64 = conn
            .query_row("SELECT COUNT(*) FROM clip_sources WHERE clip_id = 'clip-src'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(leftover, 0);
        assert!(!gameplay.exists());
        assert!(!sidecar.exists());
    }

    #[test]
    fn missing_webcam_does_not_fail_source_attach() {
        let dir = tempdir().unwrap();
        let conn = open_path(&dir.path().join("db.sqlite")).unwrap();
        migrate(&conn).unwrap();
        seed(&conn, "clip-gap", "No cam");
        let gameplay = dir.path().join("missing-cam.mp4");
        std::fs::write(&gameplay, b"gameplay").unwrap();
        attach_saved_sources(&conn, "clip-gap", &gameplay, 2_000, 1280, 720, 60, None);
        let listed = list(&conn, 10).unwrap();
        let clip = listed.iter().find(|item| item.local_id == "clip-gap").unwrap();
        assert_eq!(clip.sources.len(), 1);
        assert_eq!(clip.sources[0].kind, SOURCE_GAMEPLAY);
    }

    #[test]
    fn playback_sidecar_sits_next_to_the_original() {
        let src = PathBuf::from(r"C:\Videos\clip-1.mp4");
        assert_eq!(
            playback_sidecar_path(&src),
            PathBuf::from(r"C:\Videos\clip-1.play.mp4")
        );
        assert_eq!(
            playback_sidecar_path(&PathBuf::from(r"C:\Videos\clip-1.play.mp4")),
            PathBuf::from(r"C:\Videos\clip-1.play.mp4")
        );
    }
}
