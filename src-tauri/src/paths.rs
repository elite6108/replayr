use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};
use crate::settings;

/// True when `candidate` is under `root` after canonicalize (or string prefix fallback).
pub fn is_under(root: &Path, candidate: &Path) -> bool {
    let Ok(root) = dunce_canonicalize(root) else {
        return false;
    };
    let Ok(candidate) = dunce_canonicalize(candidate) else {
        return false;
    };
    candidate.starts_with(&root)
}

fn dunce_canonicalize(path: &Path) -> std::io::Result<PathBuf> {
    match path.canonicalize() {
        Ok(path) => Ok(strip_verbatim(path)),
        Err(err) => Err(err),
    }
}

fn strip_verbatim(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        path
    }
}

/// Roots where Reveal may open Explorer (clip library + save location + app data).
pub fn reveal_roots(app: &AppHandle) -> AppResult<Vec<PathBuf>> {
    let mut roots = Vec::new();
    if let Ok(dir) = app.path().app_data_dir() {
        roots.push(dir);
    }
    if let Ok(dir) = app.path().video_dir() {
        roots.push(dir.join("Project Replay"));
        roots.push(dir);
    }
    if let Ok(dir) = app.path().document_dir() {
        roots.push(dir.join("Project Replay"));
    }
    if let Ok(dir) = app.path().download_dir() {
        roots.push(dir);
    }
    {
        let db = app.state::<crate::database::AppState>();
        if let Ok(conn) = db.db.lock() {
            if let Ok(cfg) = settings::load(&conn) {
                let save = cfg.save_location.trim();
                if !save.is_empty() {
                    roots.push(PathBuf::from(save));
                }
            }
        };
    }
    Ok(roots)
}

/// Let WebView2 read clip folders that sit outside the bundled `$HOME/$VIDEO` asset scope
/// (custom save drive, non-English Videos path). Runtime-only; not persisted.
pub fn allow_clip_asset_roots(app: &AppHandle) {
    let scope = app.asset_protocol_scope();
    if let Ok(dir) = app.path().app_data_dir() {
        let playback = dir.join("playback");
        let _ = std::fs::create_dir_all(&playback);
        let _ = scope.allow_directory(&dir, true);
        let _ = scope.allow_directory(&playback, true);
    }
    if let Ok(dir) = app.path().video_dir() {
        let _ = scope.allow_directory(&dir, true);
        let _ = scope.allow_directory(dir.join("Project Replay"), true);
    }
    if let Ok(roots) = reveal_roots(app) {
        for root in roots {
            if root.as_os_str().is_empty() {
                continue;
            }
            let _ = scope.allow_directory(&root, true);
        }
    }
}

pub fn playback_cache_dir(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|err| AppError::Message(err.to_string()))?
        .join("playback");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

pub fn allow_asset_file(app: &AppHandle, path: &Path) {
    let scope = app.asset_protocol_scope();
    if let Some(parent) = path.parent() {
        let _ = scope.allow_directory(parent, true);
    }
    let _ = scope.allow_file(path);
}

pub fn assert_reveal_allowed(app: &AppHandle, path: &str) -> AppResult<()> {
    let candidate = PathBuf::from(path);
    if !candidate.exists() {
        return Err(AppError::Message("That file is no longer on disk.".into()));
    }
    let roots = reveal_roots(app)?;
    if roots.iter().any(|root| is_under(root, &candidate)) {
        return Ok(());
    }
    Err(AppError::Message("That path is outside the clip library.".into()))
}

/// Destinations for export / download: user Videos, Documents, Downloads, or save_location.
pub fn assert_export_dest_allowed(app: &AppHandle, dest: &str) -> AppResult<()> {
    let dest = PathBuf::from(dest);
    if dest.as_os_str().is_empty() {
        return Err(AppError::Message("Choose a download location.".into()));
    }
    let parent = dest
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(dest.as_path());
    // Allow writing into a not-yet-created folder if an ancestor is allowed.
    let mut check = parent.to_path_buf();
    let roots = reveal_roots(app)?;
    loop {
        if roots.iter().any(|root| {
            if let (Ok(r), Ok(c)) = (dunce_canonicalize(root), dunce_canonicalize(&check)) {
                c.starts_with(&r)
            } else {
                false
            }
        }) {
            return Ok(());
        }
        // Walk up until something exists to canonicalize.
        if check.exists() {
            break;
        }
        match check.parent() {
            Some(next) if next != check => check = next.to_path_buf(),
            _ => break,
        }
    }
    if roots.iter().any(|root| is_under(root, &check) || is_under(root, parent)) {
        return Ok(());
    }
    // Fresh nested folder under an allowed root that does not exist yet.
    let text = dest.to_string_lossy().to_ascii_lowercase();
    for root in &roots {
        let root_text = root.to_string_lossy().to_ascii_lowercase();
        if !root_text.is_empty() && text.starts_with(&*root_text) {
            return Ok(());
        }
    }
    Err(AppError::Message("Choose a folder under Videos, Documents, Downloads, or your save location.".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn is_under_accepts_child_paths() {
        let dir = tempdir().unwrap();
        let child = dir.path().join("clips").join("a.mp4");
        fs::create_dir_all(child.parent().unwrap()).unwrap();
        fs::write(&child, b"x").unwrap();
        assert!(is_under(dir.path(), &child));
        assert!(!is_under(dir.path(), Path::new("C:\\Windows\\System32")));
    }
}
