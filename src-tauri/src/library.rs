use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::database::AppState;
use crate::error::{AppError, AppResult};
use crate::still::{scale_bgra, write_bgra_bmp, StillFrame};

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
    Ok(())
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
    conn.execute("DELETE FROM local_clips WHERE local_id = ?1", [local_id])?;
    remove_media(&clip.file_path);
    if let Some(thumb) = clip.thumbnail_path.as_ref() {
        if thumb != &clip.file_path {
            remove_media(thumb);
        }
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
}
