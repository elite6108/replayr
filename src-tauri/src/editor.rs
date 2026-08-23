use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::capture::SavedClipEvent;
use crate::database::AppState;
use crate::error::{AppError, AppResult};
use crate::library::{self, ClipLineage, LocalClipDto};

pub const MIN_TRIM_MS: u64 = 1000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilmstripFrame {
    pub path: String,
    pub at_ms: u64,
}

pub fn validate_range(start_ms: u64, end_ms: u64, duration_ms: u64) -> Result<(u64, u64), String> {
    let duration_ms = duration_ms.max(end_ms);
    let start = start_ms.min(duration_ms);
    let end = end_ms.min(duration_ms).max(start);
    if end.saturating_sub(start) < MIN_TRIM_MS {
        return Err("Select at least one second.".into());
    }
    Ok((start, end))
}

pub fn save_trimmed_clip(
    app: &AppHandle,
    source_local_id: &str,
    start_ms: u64,
    end_ms: u64,
    title: Option<String>,
) -> AppResult<LocalClipDto> {
    let source = {
        let db = app.state::<AppState>();
        let conn = db.db.lock().map_err(|err| AppError::Message(err.to_string()))?;
        library::get(&conn, source_local_id)?
    };
    let path = PathBuf::from(&source.file_path);
    if !path.exists() {
        return Err(AppError::Message("That clip is no longer on disk.".into()));
    }
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if ext != "mp4" {
        return Err(AppError::Message("Only MP4 clips can be trimmed.".into()));
    }
    let duration_ms = source.duration_ms.unwrap_or(0).max(0) as u64;
    let (start_ms, end_ms) = validate_range(start_ms, end_ms, duration_ms).map_err(AppError::Message)?;
    let dest_dir = path
        .parent()
        .ok_or_else(|| AppError::Message("That clip has no folder.".into()))?;
    let dest = output_path(dest_dir, "clip-trim", "mp4");

    #[cfg(windows)]
    let written_ms = crate::export::trim_mp4(&path, &dest, ms_to_hns(start_ms), ms_to_hns(end_ms))
        .map_err(AppError::Message)?;
    #[cfg(not(windows))]
    let written_ms: i64 = {
        let _ = dest;
        return Err(AppError::Message("Trim is only available on Windows.".into()));
    };

    let duration_ms = if written_ms > 0 { written_ms as u64 } else { end_ms - start_ms };
    let mid_ms = duration_ms / 2;
    #[cfg(windows)]
    let preview = crate::thumb::frame_at(&dest, mid_ms).ok();
    #[cfg(not(windows))]
    let preview = None;

    let title = title
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
        .unwrap_or_else(|| {
            format!(
                "{} — Trim",
                source.title.as_deref().filter(|value| !value.is_empty()).unwrap_or("Clip")
            )
        });

    let local_id = library::insert_derived(
        app,
        &dest,
        duration_ms,
        source.width.unwrap_or(0).max(0) as u32,
        source.height.unwrap_or(0).max(0) as u32,
        source.fps.unwrap_or(0).max(0) as u32,
        source.game_id.clone(),
        title,
        preview.as_ref(),
        ClipLineage {
            source_clip_id: source.local_id.clone(),
            source_start_ms: start_ms as i64,
            source_end_ms: end_ms as i64,
        },
    )?;
    let _ = app.emit(
        "local-clip-saved",
        SavedClipEvent {
            path: dest.display().to_string(),
            kind: "trim".into(),
            local_id: local_id.clone(),
        },
    );
    let db = app.state::<AppState>();
    let conn = db.db.lock().map_err(|err| AppError::Message(err.to_string()))?;
    library::get(&conn, &local_id)
}

pub fn list_filmstrip(app: &AppHandle, local_id: &str, count: u32) -> AppResult<Vec<FilmstripFrame>> {
    let clip = {
        let db = app.state::<AppState>();
        let conn = db.db.lock().map_err(|err| AppError::Message(err.to_string()))?;
        library::get(&conn, local_id)?
    };
    let path = PathBuf::from(&clip.file_path);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let count = count.clamp(8, 16);
    let duration_ms = clip.duration_ms.unwrap_or(0).max(0) as u64;
    let dest = path
        .parent()
        .ok_or_else(|| AppError::Message("That clip has no folder.".into()))?
        .join(".thumbs")
        .join(format!("{local_id}-strip"));
    #[cfg(windows)]
    {
        match crate::thumb::filmstrip(&path, &dest, count, duration_ms) {
            Ok(frames) => Ok(frames
                .into_iter()
                .map(|(path, at_ms)| FilmstripFrame {
                    path: path.display().to_string(),
                    at_ms,
                })
                .collect()),
            Err(err) => {
                tracing::warn!("filmstrip failed for {local_id}: {err}");
                Ok(Vec::new())
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = dest;
        Ok(Vec::new())
    }
}

fn output_path(dir: &Path, slug: &str, ext: &str) -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    dir.join(format!("{slug}-{stamp}.{ext}"))
}

fn ms_to_hns(ms: u64) -> i64 {
    (ms as i64).saturating_mul(10_000)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_short_ranges() {
        assert!(validate_range(0, 500, 5_000).is_err());
        assert!(validate_range(2_000, 2_000, 5_000).is_err());
        assert_eq!(validate_range(2_000, 3_500, 5_000).unwrap(), (2_000, 3_500));
    }

    #[test]
    fn clamps_to_duration() {
        assert_eq!(validate_range(4_000, 9_000, 5_000).unwrap(), (4_000, 5_000));
    }
}
