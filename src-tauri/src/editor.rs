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

    #[cfg(windows)]
    if let Some(webcam) = library::valid_webcam_source(&source) {
        let sidecar = crate::camera::webcam_sidecar_path(&dest);
        if let Err(err) = crate::export::trim_mp4(
            Path::new(&webcam.file_path),
            &sidecar,
            ms_to_hns(start_ms),
            ms_to_hns(end_ms),
        ) {
            tracing::warn!(%err, "webcam trim failed; saving gameplay-only derived clip");
            let _ = std::fs::remove_file(&sidecar);
        }
    }

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

/// Upper bound on kept sections per save; keeps temp-file fan-out sane.
pub const MAX_SEGMENTS: usize = 64;

/// Validates the kept ranges for a multi-section save: 2..=MAX_SEGMENTS ranges,
/// each at least MIN_TRIM_MS long, strictly ordered and non-overlapping.
pub fn validate_segments(ranges: &[(u64, u64)], duration_ms: u64) -> Result<Vec<(u64, u64)>, String> {
    if ranges.len() < 2 {
        return Err("Split the clip into at least two sections first.".into());
    }
    if ranges.len() > MAX_SEGMENTS {
        return Err(format!("Keep at most {MAX_SEGMENTS} sections."));
    }
    let mut out = Vec::with_capacity(ranges.len());
    let mut previous_end = 0_u64;
    for (index, &(start_ms, end_ms)) in ranges.iter().enumerate() {
        let (start, end) = validate_range(start_ms, end_ms, duration_ms)?;
        if index > 0 && start < previous_end {
            return Err("Sections overlap; join or move them before saving.".into());
        }
        previous_end = end;
        out.push((start, end));
    }
    Ok(out)
}

/// Removes a scratch directory (and everything in it) when dropped. The
/// shared parent is removed too once it is empty, so no `.editor-tmp` folder
/// lingers next to the user's clips.
struct RemoveDir(PathBuf);

impl Drop for RemoveDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
        if let Some(parent) = self.0.parent() {
            let _ = std::fs::remove_dir(parent);
        }
    }
}

/// Saves several kept ranges of one clip as a single new clip. Each range is
/// stream-copied with `trim_mp4` (cuts land on the previous keyframe) and the
/// pieces are joined with `concat_mp4s`; nothing is re-encoded.
pub fn save_segmented_clip(
    app: &AppHandle,
    source_local_id: &str,
    ranges: &[(u64, u64)],
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
        return Err(AppError::Message("Only MP4 clips can be edited.".into()));
    }
    let duration_ms = source.duration_ms.unwrap_or(0).max(0) as u64;
    let ranges = validate_segments(ranges, duration_ms).map_err(AppError::Message)?;
    let dest_dir = path
        .parent()
        .ok_or_else(|| AppError::Message("That clip has no folder.".into()))?;
    let dest = output_path(dest_dir, "clip-edit", "mp4");

    #[cfg(not(windows))]
    {
        let _ = (dest, title);
        return Err(AppError::Message("Section edits are only available on Windows.".into()));
    }

    #[cfg(windows)]
    {
        let scratch = dest_dir.join(".editor-tmp").join(
            dest.file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("edit"),
        );
        std::fs::create_dir_all(&scratch).map_err(|err| AppError::Message(err.to_string()))?;
        let _scratch_guard = RemoveDir(scratch.clone());

        // Trim each kept range to its own stream-copied piece, then lay the
        // pieces back to back using the lengths actually written (keyframe
        // snapping can make a piece slightly longer than requested).
        let mut pieces = Vec::with_capacity(ranges.len());
        let mut cursor_hns = 0_i64;
        for (index, &(start_ms, end_ms)) in ranges.iter().enumerate() {
            let piece = scratch.join(format!("part-{index:02}.mp4"));
            let written_ms = crate::export::trim_mp4(&path, &piece, ms_to_hns(start_ms), ms_to_hns(end_ms))
                .map_err(AppError::Message)?;
            let length_hns = if written_ms > 0 {
                ms_to_hns(written_ms as u64)
            } else {
                ms_to_hns(end_ms - start_ms)
            };
            pieces.push(crate::export::ConcatSegment {
                path: piece,
                start_hns: cursor_hns,
                end_hns: cursor_hns + length_hns,
            });
            cursor_hns += length_hns;
        }
        let total_hns = cursor_hns;

        crate::export::concat_mp4s(&pieces, &dest, 0).map_err(|err| {
            let _ = std::fs::remove_file(&dest);
            AppError::Message(err)
        })?;

        if let Some(webcam) = library::valid_webcam_source(&source) {
            let sidecar = crate::camera::webcam_sidecar_path(&dest);
            let webcam_path = Path::new(&webcam.file_path);
            let mut cam_pieces = Vec::with_capacity(pieces.len());
            let mut cam_ok = true;
            for (index, (&(start_ms, end_ms), piece)) in ranges.iter().zip(pieces.iter()).enumerate() {
                let cam_piece = scratch.join(format!("cam-{index:02}.mp4"));
                match crate::export::trim_mp4(webcam_path, &cam_piece, ms_to_hns(start_ms), ms_to_hns(end_ms)) {
                    Ok(_) => cam_pieces.push(crate::export::ConcatSegment {
                        path: cam_piece,
                        start_hns: piece.start_hns,
                        end_hns: piece.end_hns,
                    }),
                    Err(err) => {
                        tracing::warn!(%err, "webcam section trim failed; saving gameplay-only derived clip");
                        cam_ok = false;
                        break;
                    }
                }
            }
            if cam_ok {
                if let Err(err) = crate::export::concat_mp4s_preserve_timeline(&cam_pieces, &sidecar, 0, total_hns)
                {
                    tracing::warn!(%err, "webcam section join failed; saving gameplay-only derived clip");
                    let _ = std::fs::remove_file(&sidecar);
                }
            }
        }

        let kept_ms: u64 = ranges.iter().map(|(start, end)| end - start).sum();
        let duration_ms = if total_hns > 0 { (total_hns / 10_000) as u64 } else { kept_ms };
        let preview = crate::thumb::frame_at(&dest, duration_ms / 2).ok();

        let title = title
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.to_string())
            .unwrap_or_else(|| {
                format!(
                    "{} — Edit",
                    source.title.as_deref().filter(|value| !value.is_empty()).unwrap_or("Clip")
                )
            });

        let first_start = ranges.first().map(|(start, _)| *start).unwrap_or(0);
        let last_end = ranges.last().map(|(_, end)| *end).unwrap_or(duration_ms);
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
                source_start_ms: first_start as i64,
                source_end_ms: last_end as i64,
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
}

pub fn save_short_clip(
    app: &AppHandle,
    source_local_id: &str,
    start_ms: u64,
    end_ms: u64,
    pan: f32,
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
        return Err(AppError::Message("Only MP4 clips can be exported as a Short.".into()));
    }
    let duration_ms = source.duration_ms.unwrap_or(0).max(0) as u64;
    let (start_ms, end_ms) = validate_range(start_ms, end_ms, duration_ms).map_err(AppError::Message)?;
    let pan = pan.clamp(0.0, 1.0);
    let _ = library::set_editor_crop(app, source_local_id, pan);
    let dest_dir = path
        .parent()
        .ok_or_else(|| AppError::Message("That clip has no folder.".into()))?;
    let dest = output_path(dest_dir, "clip-short", "mp4");
    let fps = source.fps.unwrap_or(60).max(24).min(60) as u32;

    #[cfg(windows)]
    let overlay = library::valid_webcam_source(&source).map(|webcam| crate::export::WebcamCompose {
        path: PathBuf::from(&webcam.file_path),
        layout: crate::overlay::OverlayLayout::from_json(webcam.layout_json.as_deref()),
    });
    #[cfg(windows)]
    let written_ms = crate::export::write_vertical_mp4(
        &path,
        &dest,
        ms_to_hns(start_ms),
        ms_to_hns(end_ms),
        pan,
        fps,
        overlay.as_ref(),
    )
    .map_err(|err| {
        // The sink writer creates the file up front, so a failed encode would
        // otherwise leave a 0-byte MP4 next to the real clips.
        let _ = std::fs::remove_file(&dest);
        AppError::Message(err)
    })?;
    #[cfg(not(windows))]
    let written_ms: i64 = {
        let _ = (dest, pan, fps);
        return Err(AppError::Message("Shorts export is only available on Windows.".into()));
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
                "{} — Short",
                source.title.as_deref().filter(|value| !value.is_empty()).unwrap_or("Clip")
            )
        });

    let local_id = library::insert_derived(
        app,
        &dest,
        duration_ms,
        1080,
        1920,
        fps,
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
            kind: "short".into(),
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
    let count = count.clamp(8, 192);
    let duration_ms = clip.duration_ms.unwrap_or(0).max(0) as u64;
    let dest = path
        .parent()
        .ok_or_else(|| AppError::Message("That clip has no folder.".into()))?
        .join(".thumbs")
        .join(format!("{local_id}-strip"))
        .join(format!("density-{count}"));
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

pub fn clip_waveform(app: &AppHandle, local_id: &str, buckets: u32) -> AppResult<Vec<f32>> {
    let clip = {
        let db = app.state::<AppState>();
        let conn = db.db.lock().map_err(|err| AppError::Message(err.to_string()))?;
        library::get(&conn, local_id).inspect_err(|err| {
            tracing::warn!("waveform: clip {local_id} lookup failed: {err}");
        })?
    };
    let path = PathBuf::from(&clip.file_path);
    if !path.exists() {
        tracing::warn!("waveform: {local_id} file missing at {}", path.display());
        return Ok(Vec::new());
    }
    #[cfg(windows)]
    {
        tracing::info!("waveform: decoding {local_id} ({buckets} buckets)");
        match crate::export::audio_peaks(&path, buckets as usize) {
            Ok(peaks) => {
                tracing::info!("waveform ready for {local_id}: {} buckets", peaks.len());
                Ok(peaks)
            }
            Err(err) => {
                tracing::warn!("waveform failed for {local_id}: {err}");
                Ok(Vec::new())
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = buckets;
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

    #[test]
    fn segments_need_two_ordered_ranges() {
        assert!(validate_segments(&[(0, 5_000)], 10_000).is_err());
        assert!(validate_segments(&[(0, 5_000), (4_000, 9_000)], 10_000).is_err());
        assert!(validate_segments(&[(0, 5_000), (5_000, 5_500)], 10_000).is_err());
        assert_eq!(
            validate_segments(&[(0, 2_000), (4_000, 9_000)], 10_000).unwrap(),
            vec![(0, 2_000), (4_000, 9_000)]
        );
    }

    #[test]
    fn segments_are_capped() {
        let many: Vec<(u64, u64)> = (0..(MAX_SEGMENTS as u64 + 1))
            .map(|i| (i * 2_000, i * 2_000 + 1_000))
            .collect();
        assert!(validate_segments(&many, 1_000_000).is_err());
    }
}
