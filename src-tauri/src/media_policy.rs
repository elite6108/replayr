//! Local media files only. The path is untrusted until it is a normal file of
//! an allowed type on this computer.

use std::path::{Path, PathBuf};

use crate::paths::is_safe_local_file;

const MAX_PATH: usize = 1024;

const VIDEO_EXTENSIONS: &[&str] = &["mp4", "m4v", "mov"];
const AUDIO_EXTENSIONS: &[&str] = &["m4a", "mp3", "wav", "aac"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaKind {
    Video,
    Audio,
}

pub fn media_kind(path: &str) -> Option<MediaKind> {
    let ext = extension(path)?;
    if VIDEO_EXTENSIONS.iter().any(|item| *item == ext) {
        Some(MediaKind::Video)
    } else if AUDIO_EXTENSIONS.iter().any(|item| *item == ext) {
        Some(MediaKind::Audio)
    } else {
        None
    }
}

/// Checks the shape of a path before touching the disk.
pub fn media_path_shape(path: &str) -> Result<MediaKind, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_PATH || trimmed.contains('\0') {
        return Err("Choose a media file to record.".into());
    }
    if trimmed.starts_with("\\\\") || trimmed.starts_with("//") {
        return Err("Media files have to be on this computer.".into());
    }
    let kind = media_kind(trimmed).ok_or_else(|| "Use an MP4, MOV, MP3, M4A, or WAV file.".to_string())?;
    let path = Path::new(trimmed);
    if !path.is_absolute() || path.components().any(|part| matches!(part, std::path::Component::ParentDir)) {
        return Err("Choose a media file to record.".into());
    }
    Ok(kind)
}

pub fn validate_media_file(path: &str) -> Result<(PathBuf, MediaKind), String> {
    let kind = media_path_shape(path)?;
    let canonical = Path::new(path.trim())
        .canonicalize()
        .map_err(|_| "That media file could not be opened.".to_string())?;
    if !canonical.is_file() || !is_safe_local_file(&canonical) {
        return Err("That media file could not be opened.".into());
    }
    let canonical_text = canonical.to_string_lossy();
    if media_kind(&canonical_text) != Some(kind) {
        return Err("Use an MP4, MOV, MP3, M4A, or WAV file.".into());
    }
    Ok((canonical, kind))
}

fn extension(path: &str) -> Option<String> {
    let name = path.rsplit(['\\', '/']).next().unwrap_or(path);
    let (_, ext) = name.rsplit_once('.')?;
    if ext.is_empty() || ext.len() > 5 || !ext.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
        return None;
    }
    Some(ext.to_ascii_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn video_and_audio_extensions_are_separate() {
        assert_eq!(media_kind("C:\\clips\\intro.MP4"), Some(MediaKind::Video));
        assert_eq!(media_kind("C:\\clips\\bed.mp3"), Some(MediaKind::Audio));
        assert_eq!(media_kind("C:\\clips\\run.exe"), None);
        assert_eq!(media_kind("C:\\clips\\notes.txt"), None);
    }

    #[test]
    fn hostile_paths_never_reach_the_disk() {
        for path in [
            "intro.mp4",
            "..\\intro.mp4",
            "\\\\server\\share\\intro.mp4",
            "C:\\clips\\run.exe",
            "C:\\clips\\movie.mp4\0.mp3",
        ] {
            assert!(media_path_shape(path).is_err(), "{path}");
        }
    }

    #[test]
    fn a_normal_absolute_file_has_a_kind_before_it_is_opened() {
        assert_eq!(media_path_shape("C:\\clips\\intro.mov").unwrap(), MediaKind::Video);
        assert_eq!(media_path_shape("D:\\music\\bed.wav").unwrap(), MediaKind::Audio);
    }
}
