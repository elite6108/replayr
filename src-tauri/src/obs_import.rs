//! Read-only access to OBS Studio scene collections for Import from OBS.
//!
//! Nothing here writes to the OBS folder. File names and paths from the frontend are untrusted:
//! a listed collection is addressed by bare file name inside the OBS scenes folder, and a browsed
//! file must be a local `.json` file under the size cap. The JSON is validated again, field by
//! field, by the frontend converter before anything reaches a scene.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::de::IgnoredAny;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};

const MAX_COLLECTION_BYTES: u64 = 8 * 1024 * 1024;
const MAX_INI_BYTES: u64 = 256 * 1024;
const MAX_COLLECTIONS: usize = 64;
const MAX_PROFILES: usize = 64;
const MAX_FILE_NAME: usize = 200;
const MAX_BROWSED_PATH: usize = 4096;
const MAX_COLLECTION_NAME: usize = 64;
const MAX_IMAGE_PROBES: usize = 256;
const MAX_IMAGE_PATH: usize = 4096;
const MIN_CANVAS: u32 = 16;
const MAX_CANVAS: u32 = 16_384;
const DEFAULT_CANVAS: ObsCanvas = ObsCanvas {
    width: 1920,
    height: 1080,
};

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ObsCanvas {
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObsCollectionInfo {
    /// Bare file name inside the OBS scenes folder. This is the only handle the frontend gets.
    pub file: String,
    pub name: String,
    pub modified_ms: u64,
    /// The collection OBS had open last.
    pub current: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObsMonitor {
    /// `\\.\DISPLAYn`, the id Replayr's display source stores.
    pub id: String,
    /// The device-interface path OBS stores as `monitor_id`. Empty when Windows does not report one.
    pub interface_id: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObsImportContext {
    /// An OBS settings folder exists for this Windows user.
    pub installed: bool,
    pub collections: Vec<ObsCollectionInfo>,
    /// OBS base canvas from the active profile, or 1920x1080.
    pub canvas: ObsCanvas,
    pub monitors: Vec<ObsMonitor>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObsCollectionText {
    pub name: String,
    pub json: String,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImageSize {
    pub width: u32,
    pub height: u32,
}

#[tauri::command]
pub async fn get_obs_import_context(app: AppHandle) -> AppResult<ObsImportContext> {
    let root = obs_root(&app);
    blocking(move || Ok(build_context(root.as_deref()))).await
}

#[tauri::command]
pub async fn read_obs_scene_collection(
    app: AppHandle,
    file: Option<String>,
    path: Option<String>,
) -> AppResult<ObsCollectionText> {
    let root = obs_root(&app);
    blocking(move || {
        let target = match (file, path) {
            (Some(file), None) => listed_collection_path(root.as_deref(), &file)?,
            (None, Some(path)) => browsed_collection_path(&path)?,
            _ => return Err(message("Pick one OBS scene collection.")),
        };
        read_collection(&target)
    })
    .await
}

#[tauri::command]
pub async fn probe_obs_image_sizes(paths: Vec<String>) -> AppResult<Vec<Option<ImageSize>>> {
    if paths.len() > MAX_IMAGE_PROBES {
        return Err(message("That scene collection has too many images to import at once."));
    }
    blocking(move || Ok(paths.iter().map(|path| probe_image(path)).collect())).await
}

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> AppResult<T> + Send + 'static) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| message("Could not read the OBS settings."))?
}

fn message(text: &str) -> AppError {
    AppError::Message(text.to_string())
}

/// `%APPDATA%\obs-studio`, resolved through the known-folder API rather than any frontend input.
fn obs_root(app: &AppHandle) -> Option<PathBuf> {
    app.path().config_dir().ok().map(|dir| dir.join("obs-studio"))
}

fn build_context(root: Option<&Path>) -> ObsImportContext {
    let monitors = list_monitors();
    let Some(root) = root.filter(|dir| dir.is_dir()) else {
        return ObsImportContext {
            installed: false,
            collections: Vec::new(),
            canvas: DEFAULT_CANVAS,
            monitors,
        };
    };
    let basic = read_basic_config(root);
    let collections = list_collections(&scenes_dir(root), basic.collection_file.as_deref());
    let canvas = basic
        .profile_dir
        .as_deref()
        .and_then(|dir| read_profile_canvas(root, dir))
        .or_else(|| first_profile_canvas(root))
        .unwrap_or(DEFAULT_CANVAS);
    ObsImportContext {
        installed: true,
        collections,
        canvas,
        monitors,
    }
}

fn scenes_dir(root: &Path) -> PathBuf {
    root.join("basic").join("scenes")
}

fn profiles_dir(root: &Path) -> PathBuf {
    root.join("basic").join("profiles")
}

#[derive(Debug, Default, PartialEq, Eq)]
struct BasicConfig {
    profile_dir: Option<String>,
    collection_file: Option<String>,
}

/// OBS 31 keeps the active profile and collection in `user.ini`; older versions use `global.ini`.
fn read_basic_config(root: &Path) -> BasicConfig {
    for name in ["user.ini", "global.ini"] {
        let Some(text) = read_small_text(&root.join(name), MAX_INI_BYTES) else {
            continue;
        };
        let config = BasicConfig {
            profile_dir: ini_value(&text, "Basic", "ProfileDir").filter(|dir| is_plain_name(dir)),
            collection_file: ini_value(&text, "Basic", "SceneCollectionFile").filter(|file| is_plain_name(file)),
        };
        if config.profile_dir.is_some() || config.collection_file.is_some() {
            return config;
        }
    }
    BasicConfig::default()
}

fn read_profile_canvas(root: &Path, profile_dir: &str) -> Option<ObsCanvas> {
    if !is_plain_name(profile_dir) {
        return None;
    }
    let text = read_small_text(&profiles_dir(root).join(profile_dir).join("basic.ini"), MAX_INI_BYTES)?;
    canvas_from_ini(&text)
}

fn first_profile_canvas(root: &Path) -> Option<ObsCanvas> {
    let mut names: Vec<String> = fs::read_dir(profiles_dir(root))
        .ok()?
        .filter_map(Result::ok)
        .take(MAX_PROFILES)
        .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| is_plain_name(name))
        .collect();
    names.sort();
    names.iter().find_map(|name| read_profile_canvas(root, name))
}

fn canvas_from_ini(text: &str) -> Option<ObsCanvas> {
    let width = ini_value(text, "Video", "BaseCX")?.parse::<u32>().ok()?;
    let height = ini_value(text, "Video", "BaseCY")?.parse::<u32>().ok()?;
    let valid = |value: u32| (MIN_CANVAS..=MAX_CANVAS).contains(&value);
    (valid(width) && valid(height)).then_some(ObsCanvas { width, height })
}

/// Minimal INI lookup: `[Section]` headers and `key=value` lines, both case-insensitive.
fn ini_value(text: &str, section: &str, key: &str) -> Option<String> {
    let mut in_section = false;
    for line in text.trim_start_matches('\u{feff}').lines() {
        let line = line.trim();
        if let Some(name) = line.strip_prefix('[').and_then(|rest| rest.strip_suffix(']')) {
            in_section = name.trim().eq_ignore_ascii_case(section);
            continue;
        }
        if !in_section {
            continue;
        }
        let Some((name, value)) = line.split_once('=') else {
            continue;
        };
        if name.trim().eq_ignore_ascii_case(key) {
            let value = value.trim();
            return (!value.is_empty()).then(|| value.to_string());
        }
    }
    None
}

fn list_collections(dir: &Path, current: Option<&str>) -> Vec<ObsCollectionInfo> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<ObsCollectionInfo> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let file = entry.file_name().into_string().ok()?;
            if !is_collection_file_name(&file) {
                return None;
            }
            let meta = entry.metadata().ok()?;
            if !meta.is_file() || meta.len() == 0 || meta.len() > MAX_COLLECTION_BYTES {
                return None;
            }
            let path = entry.path();
            let stem = file[..file.len() - ".json".len()].to_string();
            let modified_ms = meta
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as u64)
                .unwrap_or(0);
            Some(ObsCollectionInfo {
                name: collection_name(&path).unwrap_or_else(|| clean_name(&stem)),
                current: current.is_some_and(|value| value.eq_ignore_ascii_case(&stem)),
                file,
                modified_ms,
            })
        })
        .take(MAX_COLLECTIONS)
        .collect();
    out.sort_by(|a, b| b.current.cmp(&a.current).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    out
}

#[derive(Deserialize)]
struct CollectionHeader {
    name: Option<String>,
    #[serde(default)]
    sources: Option<IgnoredAny>,
}

fn collection_name(path: &Path) -> Option<String> {
    let bytes = fs::read(path).ok()?;
    let header: CollectionHeader = serde_json::from_slice(strip_bom(&bytes)).ok()?;
    header.sources?;
    header.name.map(|name| clean_name(&name)).filter(|name| !name.is_empty())
}

fn listed_collection_path(root: Option<&Path>, file: &str) -> AppResult<PathBuf> {
    let root = root.ok_or_else(|| message("OBS Studio settings were not found for this Windows user."))?;
    if !is_collection_file_name(file) {
        return Err(message("That OBS scene collection is not valid."));
    }
    let dir = scenes_dir(root)
        .canonicalize()
        .map_err(|_| message("OBS Studio has no scene collections yet."))?;
    let candidate = dir
        .join(file)
        .canonicalize()
        .map_err(|_| message("That OBS scene collection is no longer on disk."))?;
    if !candidate.starts_with(&dir) || !candidate.is_file() {
        return Err(message("That OBS scene collection is not valid."));
    }
    Ok(candidate)
}

fn browsed_collection_path(raw: &str) -> AppResult<PathBuf> {
    let invalid = || message("Choose an OBS scene collection .json file on this PC.");
    let raw = raw.trim();
    if raw.is_empty() || raw.len() > MAX_BROWSED_PATH || raw.contains('\0') {
        return Err(invalid());
    }
    let path = PathBuf::from(raw);
    if !path.is_absolute() || !has_json_extension(&path) {
        return Err(invalid());
    }
    let canonical = path.canonicalize().map_err(|_| invalid())?;
    if !crate::paths::is_safe_local_file(&canonical) || !canonical.is_file() || !has_json_extension(&canonical) {
        return Err(invalid());
    }
    Ok(canonical)
}

fn read_collection(path: &Path) -> AppResult<ObsCollectionText> {
    let not_obs = || message("That file is not an OBS scene collection.");
    let meta = fs::metadata(path).map_err(|_| message("Could not open that OBS scene collection."))?;
    if meta.len() == 0 {
        return Err(not_obs());
    }
    if meta.len() > MAX_COLLECTION_BYTES {
        return Err(message("That OBS scene collection is too large to import."));
    }
    let bytes = fs::read(path).map_err(|_| message("Could not open that OBS scene collection."))?;
    let text = std::str::from_utf8(strip_bom(&bytes)).map_err(|_| not_obs())?;
    let value: serde_json::Value = serde_json::from_str(text).map_err(|_| not_obs())?;
    let object = value.as_object().ok_or_else(not_obs)?;
    if !object.get("sources").is_some_and(serde_json::Value::is_array) {
        return Err(not_obs());
    }
    let stem = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .map(clean_name)
        .unwrap_or_default();
    let name = object
        .get("name")
        .and_then(serde_json::Value::as_str)
        .map(clean_name)
        .filter(|name| !name.is_empty())
        .unwrap_or(if stem.is_empty() { "OBS".to_string() } else { stem });
    Ok(ObsCollectionText {
        name,
        json: text.to_string(),
    })
}

fn probe_image(raw: &str) -> Option<ImageSize> {
    if raw.is_empty() || raw.len() > MAX_IMAGE_PATH || raw.contains('\0') {
        return None;
    }
    image_dimensions(raw).map(|(width, height)| ImageSize { width, height })
}

#[cfg(windows)]
fn image_dimensions(raw: &str) -> Option<(u32, u32)> {
    crate::recording_compositor::sources::image::image_dimensions(raw)
}

#[cfg(not(windows))]
fn image_dimensions(_raw: &str) -> Option<(u32, u32)> {
    None
}

fn list_monitors() -> Vec<ObsMonitor> {
    crate::displays::list_displays()
        .unwrap_or_default()
        .into_iter()
        .map(|display| ObsMonitor {
            interface_id: crate::displays::monitor_interface_id(&display.id).unwrap_or_default(),
            id: display.id,
            width: display.width,
            height: display.height,
        })
        .collect()
}

fn read_small_text(path: &Path, cap: u64) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > cap {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    Some(String::from_utf8_lossy(strip_bom(&bytes)).into_owned())
}

fn strip_bom(bytes: &[u8]) -> &[u8] {
    bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes)
}

/// A single path segment: no separators, drive letters, parent references or control characters.
fn is_plain_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_FILE_NAME
        && !name.starts_with('.')
        && !name.contains("..")
        && !name.chars().any(|ch| ch.is_control() || matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
}

fn is_collection_file_name(name: &str) -> bool {
    is_plain_name(name) && name.len() > ".json".len() && name.to_ascii_lowercase().ends_with(".json")
}

fn has_json_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("json"))
}

fn clean_name(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .filter(|ch| !ch.is_control())
        .take(MAX_COLLECTION_NAME)
        .collect();
    cleaned.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    const COLLECTION: &str = r#"{"name":"Streaming","sources":[{"id":"scene","name":"Main","settings":{"items":[]}}]}"#;

    fn obs_root_with(files: &[(&str, &str)]) -> tempfile::TempDir {
        let dir = tempdir().unwrap();
        let scenes = scenes_dir(dir.path());
        fs::create_dir_all(&scenes).unwrap();
        for (name, body) in files {
            fs::write(scenes.join(name), body).unwrap();
        }
        dir
    }

    #[test]
    fn plain_names_reject_traversal_and_separators() {
        assert!(is_plain_name("Untitled"));
        assert!(is_plain_name("My Scenes (2)"));
        assert!(!is_plain_name(""));
        assert!(!is_plain_name(".."));
        assert!(!is_plain_name("..\\global.ini"));
        assert!(!is_plain_name("a/b"));
        assert!(!is_plain_name("C:evil"));
        assert!(!is_plain_name(".hidden"));
        assert!(!is_plain_name("bad\u{0}name"));
        assert!(!is_plain_name(&"x".repeat(MAX_FILE_NAME + 1)));
        assert!(is_collection_file_name("untitled.json"));
        assert!(is_collection_file_name("Untitled.JSON"));
        assert!(!is_collection_file_name("untitled.json.bak"));
        assert!(!is_collection_file_name(".json"));
    }

    #[test]
    fn ini_lookup_is_sectioned_and_case_insensitive() {
        let text = "\u{feff}[General]\nBaseCX=1\n[video]\nbasecx = 2560\nBaseCY=1440\n[Basic]\nProfileDir=Main\n";
        assert_eq!(ini_value(text, "Video", "BaseCX").as_deref(), Some("2560"));
        assert_eq!(ini_value(text, "General", "BaseCX").as_deref(), Some("1"));
        assert_eq!(ini_value(text, "Basic", "ProfileDir").as_deref(), Some("Main"));
        assert_eq!(ini_value(text, "Basic", "Missing"), None);
        assert_eq!(canvas_from_ini(text), Some(ObsCanvas { width: 2560, height: 1440 }));
    }

    #[test]
    fn canvas_rejects_absurd_sizes() {
        assert_eq!(canvas_from_ini("[Video]\nBaseCX=0\nBaseCY=1080"), None);
        assert_eq!(canvas_from_ini("[Video]\nBaseCX=99999\nBaseCY=1080"), None);
        assert_eq!(canvas_from_ini("[Video]\nBaseCX=-1\nBaseCY=1080"), None);
        assert_eq!(canvas_from_ini("[Video]\nBaseCX=1920"), None);
    }

    #[test]
    fn context_reads_profile_canvas_and_current_collection() {
        let root = obs_root_with(&[("streaming.json", COLLECTION), ("old.json.bak", COLLECTION)]);
        fs::write(
            root.path().join("global.ini"),
            "[Basic]\nProfileDir=Main\nSceneCollectionFile=streaming\n",
        )
        .unwrap();
        let profile = profiles_dir(root.path()).join("Main");
        fs::create_dir_all(&profile).unwrap();
        fs::write(profile.join("basic.ini"), "[Video]\nBaseCX=2560\nBaseCY=1440\n").unwrap();

        let context = build_context(Some(root.path()));
        assert!(context.installed);
        assert_eq!(context.canvas, ObsCanvas { width: 2560, height: 1440 });
        assert_eq!(context.collections.len(), 1);
        assert_eq!(context.collections[0].file, "streaming.json");
        assert_eq!(context.collections[0].name, "Streaming");
        assert!(context.collections[0].current);
    }

    #[test]
    fn missing_obs_folder_is_not_installed() {
        let dir = tempdir().unwrap();
        let context = build_context(Some(&dir.path().join("obs-studio")));
        assert!(!context.installed);
        assert_eq!(context.canvas, DEFAULT_CANVAS);
    }

    #[test]
    fn listed_collection_stays_inside_the_scenes_folder() {
        let root = obs_root_with(&[("streaming.json", COLLECTION)]);
        fs::write(root.path().join("secret.json"), COLLECTION).unwrap();
        assert!(listed_collection_path(Some(root.path()), "streaming.json").is_ok());
        assert!(listed_collection_path(Some(root.path()), "..\\..\\secret.json").is_err());
        assert!(listed_collection_path(Some(root.path()), "../secret.json").is_err());
        assert!(listed_collection_path(Some(root.path()), "missing.json").is_err());
        assert!(listed_collection_path(Some(root.path()), "streaming.txt").is_err());
        assert!(listed_collection_path(None, "streaming.json").is_err());
    }

    #[test]
    fn browsed_collection_must_be_a_local_json_file() {
        let dir = tempdir().unwrap();
        let good = dir.path().join("scenes.json");
        let text = dir.path().join("scenes.txt");
        fs::write(&good, COLLECTION).unwrap();
        fs::write(&text, COLLECTION).unwrap();
        assert!(browsed_collection_path(good.to_str().unwrap()).is_ok());
        assert!(browsed_collection_path(text.to_str().unwrap()).is_err());
        assert!(browsed_collection_path("scenes.json").is_err());
        assert!(browsed_collection_path(r"\\server\share\scenes.json").is_err());
        assert!(browsed_collection_path("").is_err());
        assert!(browsed_collection_path(dir.path().to_str().unwrap()).is_err());
    }

    #[test]
    fn read_collection_validates_shape_and_size() {
        let dir = tempdir().unwrap();
        let write = |name: &str, body: &[u8]| {
            let path = dir.path().join(name);
            fs::write(&path, body).unwrap();
            path
        };
        let ok = read_collection(&write("a.json", COLLECTION.as_bytes())).unwrap();
        assert_eq!(ok.name, "Streaming");
        assert!(ok.json.contains("\"sources\""));

        let mut bom = vec![0xEF, 0xBB, 0xBF];
        bom.extend_from_slice(br#"{"sources":[]}"#);
        assert_eq!(read_collection(&write("Fallback.json", &bom)).unwrap().name, "Fallback");

        assert!(read_collection(&write("b.json", b"[]")).is_err());
        assert!(read_collection(&write("c.json", br#"{"name":"x"}"#)).is_err());
        assert!(read_collection(&write("d.json", br#"{"sources":{}}"#)).is_err());
        assert!(read_collection(&write("e.json", b"not json")).is_err());
        assert!(read_collection(&write("f.json", &[0xFF, 0xFE, 0x00])).is_err());
        assert!(read_collection(&write("g.json", b"")).is_err());

        let big = write("h.json", &vec![b' '; (MAX_COLLECTION_BYTES + 1) as usize]);
        assert!(read_collection(&big).unwrap_err().to_string().contains("too large"));
    }

    #[test]
    fn collection_names_are_cleaned() {
        assert_eq!(clean_name("  Main\u{7}Scenes  "), "MainScenes");
        assert_eq!(clean_name(&"n".repeat(200)).len(), MAX_COLLECTION_NAME);
    }

    #[test]
    fn image_probe_rejects_bad_input() {
        assert_eq!(probe_image(""), None);
        assert_eq!(probe_image("bad\0path.png"), None);
        assert_eq!(probe_image(&"a".repeat(MAX_IMAGE_PATH + 1)), None);
    }
}
