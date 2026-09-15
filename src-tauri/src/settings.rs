use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{AppError, AppResult};

pub const MAX_EXTRA_ISOLATED_APPS: usize = 4;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExtraAudioApp {
    pub id: String,
    pub exe: String,
    pub display_name: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_mic_gain")]
    pub gain: f32,
}

fn default_true() -> bool {
    true
}

fn default_preview_quality() -> String {
    "balanced".into()
}

fn default_game_audio_enabled() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Hotkeys {
    pub save_replay: String,
    pub toggle_recording: String,
    pub screenshot: String,
    /// Drag-to-select screenshot. Independent of Instant Replay and of `screenshot` above.
    #[serde(default = "default_region_screenshot_hotkey")]
    pub region_screenshot: String,
}

impl Default for Hotkeys {
    fn default() -> Self {
        Self {
            save_replay: "CommandOrControl+F10".into(),
            toggle_recording: "CommandOrControl+F9".into(),
            screenshot: "CommandOrControl+F11".into(),
            region_screenshot: default_region_screenshot_hotkey(),
        }
    }
}

/// Ctrl+PrintScreen: the region-capture convention (ShareX), clear of Windows' own PrtScn,
/// Win+Shift+S and Alt+PrtScn, and rarely bound by games. If another tool already holds it,
/// registration fails soft and Settings says so.
fn default_region_screenshot_hotkey() -> String {
    "CommandOrControl+PrintScreen".into()
}

/// Region screenshot behaviour. Hand-mirrored with `ScreenshotSettings` in src/types/settings.ts.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotSettings {
    /// Upload each screenshot and copy its share link. Signed-out users always get the image.
    #[serde(default = "default_true")]
    pub auto_upload: bool,
    /// Keep a PNG in the user Screenshots folder. Off means cloud-only after a successful upload.
    #[serde(default = "default_true")]
    pub save_local: bool,
    /// What lands on the clipboard after an upload succeeds: `"link"` or `"image"`.
    #[serde(default = "default_screenshot_copy_mode")]
    pub copy_mode: String,
    /// Show the on-screen confirmation.
    #[serde(default = "default_true")]
    pub show_overlay: bool,
}

impl Default for ScreenshotSettings {
    fn default() -> Self {
        Self {
            auto_upload: true,
            save_local: true,
            copy_mode: default_screenshot_copy_mode(),
            show_overlay: true,
        }
    }
}

impl ScreenshotSettings {
    pub fn sanitize(&mut self) {
        if !self.auto_upload {
            self.save_local = true;
        }
        self.copy_mode = match self.copy_mode.as_str() {
            "image" => "image".into(),
            _ => default_screenshot_copy_mode(),
        };
    }

    pub fn copies_link(&self) -> bool {
        self.copy_mode == "link"
    }
}

fn default_screenshot_copy_mode() -> String {
    "link".into()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub close_to_tray: bool,
    pub launch_at_startup: bool,
    pub instant_replay_enabled: bool,
    pub replay_duration_seconds: u32,
    pub resolution: String,
    pub fps: u32,
    pub encoder: String,
    pub bitrate: String,
    pub custom_bitrate_kbps: u32,
    pub codec: String,
    pub microphone_id: String,
    pub audio_output_id: String,
    #[serde(default)]
    pub mic_enabled: bool,
    /// Linear microphone gain. 0.0 is mute, 1.0 is 100%, 2.0 is 200%.
    #[serde(default = "default_mic_gain")]
    pub mic_gain: f32,
    /// Per-source channel mode: "auto" | "mono" | "stereo". Default auto.
    #[serde(default = "default_channel_mode")]
    pub mic_channel_mode: String,
    /// Source pan/balance. -1 = left, 0 = center, +1 = right.
    #[serde(default)]
    pub mic_pan: f32,
    #[serde(default = "default_game_audio_enabled")]
    pub game_audio_enabled: bool,
    #[serde(default = "default_mic_gain")]
    pub game_audio_gain: f32,
    #[serde(default = "default_channel_mode")]
    pub game_audio_channel_mode: String,
    #[serde(default)]
    pub game_audio_pan: f32,
    #[serde(default)]
    pub discord_audio_enabled: bool,
    #[serde(default = "default_mic_gain")]
    pub discord_audio_gain: f32,
    #[serde(default)]
    pub extra_apps: Vec<ExtraAudioApp>,
    pub system_audio_enabled: bool,
    /// Linear desktop / system-audio gain. 0.0 is mute, 1.0 is 100%, 2.0 is 200%.
    #[serde(default = "default_mic_gain")]
    pub system_audio_gain: f32,
    #[serde(default = "default_channel_mode")]
    pub system_audio_channel_mode: String,
    #[serde(default)]
    pub system_audio_pan: f32,
    pub save_location: String,
    pub hotkeys: Hotkeys,
    pub auto_upload: String,
    /// When clips upload: "immediate" after save, or "afterGame" when the session ends.
    #[serde(default = "default_cloud_upload_when")]
    pub cloud_upload_when: String,
    pub upload_bandwidth_limit: String,
    pub custom_bandwidth_kbps: u32,
    #[serde(default = "default_true")]
    pub pause_uploads_while_gaming: bool,
    pub min_free_disk_bytes: u64,
    pub theme: String,
    pub onboarding_completed: bool,
    #[serde(default)]
    pub desktop_shortcut: bool,
    #[serde(default)]
    pub desktop_shortcut_prompted: bool,
    /// When true, share / export / upload copies get a Replayr.tv watermark.
    #[serde(default = "default_true")]
    pub watermark_exports: bool,
    /// In-game Replayr overlay after a clip is successfully saved. Default on.
    #[serde(default = "default_true")]
    pub clip_saved_notification: bool,
    /// Show Replayr status on Discord via Rich Presence. Default on.
    #[serde(default = "default_true")]
    pub discord_rich_presence: bool,
    /// Optional webcam as a separate recording source. Off until the user opts in.
    #[serde(default)]
    pub webcam: WebcamSettings,
    /// Recording Visuals defaults for the Record page preview. Export does not apply these yet.
    /// Phase 3 may add optional per-filter params as siblings under this object.
    #[serde(default)]
    pub recording_visuals: RecordingVisualSettings,
    /// Clip studio scene library. Read by the Save Clip path at save time so the F10 hotkey
    /// and the tray work with the Record page closed. Layout and burn layers only: this never
    /// changes what Instant Replay captures, and it is deliberately absent from `CAPTURE_KEYS`
    /// so editing a clip scene cannot restart the buffer.
    #[serde(default)]
    pub clip_studio: ClipStudioSettings,
    /// Region screenshot behaviour.
    #[serde(default)]
    pub screenshots: ScreenshotSettings,
    /// Live Output Preview quality only. Does not change recording encode settings.
    #[serde(default = "default_preview_quality")]
    pub preview_quality: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecordingOverlaySettings {
    #[serde(default)]
    pub rec_indicator: bool,
    #[serde(default)]
    pub timestamp: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecordingVisualSettings {
    #[serde(default = "default_visual_filter")]
    pub filter: String,
    #[serde(default)]
    pub overlays: RecordingOverlaySettings,
}

impl Default for RecordingOverlaySettings {
    fn default() -> Self {
        Self {
            rec_indicator: false,
            timestamp: false,
        }
    }
}

impl Default for RecordingVisualSettings {
    fn default() -> Self {
        Self {
            filter: default_visual_filter(),
            overlays: RecordingOverlaySettings::default(),
        }
    }
}

impl RecordingVisualSettings {
    pub fn sanitize(&mut self) {
        self.filter = match self.filter.as_str() {
            "bodycam" | "dashcam" | "vhs" | "cinematic" => self.filter.clone(),
            _ => default_visual_filter(),
        };
    }
}

/// Mirrors `MAX_SCENE_LIBRARY` in src/recording/sceneLibrary.ts.
pub const MAX_CLIP_SCENES: usize = 32;
/// Mirrors `MAX_SOURCES` in src-tauri/src/recording_compositor/scene.rs.
pub const MAX_CLIP_SOURCES: usize = 16;
/// Mirrors `MAX_SCENE_NAME` in src/recording/scene.ts.
const MAX_CLIP_SCENE_NAME: usize = 64;
/// Mirrors `MAX_TEXT` / `MAX_PATH` in src-tauri/src/recording_compositor/scene.rs.
const MAX_CLIP_TEXT: usize = 280;
const MAX_CLIP_PATH: usize = 1024;

/// Every `RecordingSourceType` in src/recording/scene.ts:17-31. Unknown kinds are dropped
/// rather than defaulted, so a newer frontend cannot smuggle a source past this build.
const CLIP_SOURCE_KINDS: [&str; 14] = [
    "game",
    "display",
    "window",
    "webcam",
    "microphone",
    "desktopAudio",
    "gameAudio",
    "image",
    "text",
    "replayrOverlay",
    "browser",
    "captureCard",
    "videoFile",
    "audioFile",
];

/// Normalized 0-1 rectangle. Hand-mirrored with `SerializedClipRect` in src/types/settings.ts.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClipRect {
    #[serde(default)]
    pub x: f32,
    #[serde(default)]
    pub y: f32,
    #[serde(default = "default_unit")]
    pub w: f32,
    #[serde(default = "default_unit")]
    pub h: f32,
}

impl ClipRect {
    pub const FULL: Self = Self {
        x: 0.0,
        y: 0.0,
        w: 1.0,
        h: 1.0,
    };

    /// Mirrors `clampTransform` (src/recording/scene.ts:160).
    fn sanitize_transform(&mut self) {
        let w = clamp_unit(self.w, 0.06, 1.0);
        let h = clamp_unit(self.h, 0.06, 1.0);
        self.w = w;
        self.h = h;
        self.x = clamp_unit(self.x, 0.0, 1.0 - w);
        self.y = clamp_unit(self.y, 0.0, 1.0 - h);
    }

    /// Mirrors `clampCrop` (src/recording/scene.ts:169), where `MIN_CROP` is 0.05.
    fn sanitize_crop(&mut self) {
        let w = clamp_unit(self.w, 0.05, 1.0);
        let h = clamp_unit(self.h, 0.05, 1.0);
        self.w = w;
        self.h = h;
        self.x = clamp_unit(self.x, 0.0, 1.0 - w);
        self.y = clamp_unit(self.y, 0.0, 1.0 - h);
    }
}

/// Hand-mirrored with `SerializedClipSource` in src/types/settings.ts.
///
/// `capability` and the scene's `outputMode` are deliberately not mirrored: the frontend
/// re-derives both on load. Anything else a clip source carries must be added here, because
/// `set_document` re-serializes the whole document and silently drops unmirrored fields.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClipSceneSource {
    #[serde(default)]
    pub id: String,
    #[serde(rename = "type", default)]
    pub kind: String,
    #[serde(default)]
    pub name: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub locked: bool,
    #[serde(default)]
    pub order: i32,
    #[serde(default)]
    pub transform: Option<ClipRect>,
    #[serde(default)]
    pub crop: Option<ClipRect>,
    /// Type-specific bag mirroring `RecordingSource.settings` (src/recording/scene.ts:85).
    #[serde(default)]
    pub settings: serde_json::Map<String, Value>,
}

/// Hand-mirrored with `SerializedClipScene` in src/types/settings.ts.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClipScene {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub sources: Vec<ClipSceneSource>,
}

/// Hand-mirrored with `ClipStudioSettings` in src/types/settings.ts.
///
/// An empty `scenes` list is the "seed me from current settings" signal to the frontend, so a
/// user who has never opened the Clips tab keeps today's Save Clip behaviour exactly.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClipStudioSettings {
    #[serde(default = "default_clip_library_version")]
    pub version: u32,
    #[serde(default)]
    pub active_id: String,
    #[serde(default)]
    pub scenes: Vec<ClipScene>,
}

impl Default for ClipStudioSettings {
    fn default() -> Self {
        Self {
            version: default_clip_library_version(),
            active_id: String::new(),
            scenes: Vec::new(),
        }
    }
}

impl ClipStudioSettings {
    pub fn sanitize(&mut self) {
        if self.version == 0 || self.version > default_clip_library_version() {
            self.version = default_clip_library_version();
        }
        self.scenes.truncate(MAX_CLIP_SCENES);
        let mut seen_scenes: Vec<String> = Vec::with_capacity(self.scenes.len());
        self.scenes.retain_mut(|scene| {
            let Some(id) = sanitize_clip_scene_id(&scene.id) else {
                return false;
            };
            if seen_scenes.iter().any(|seen| seen == &id) {
                return false;
            }
            seen_scenes.push(id.clone());
            scene.id = id;
            scene.name = sanitize_clip_scene_name(&scene.name);
            scene.sanitize_sources();
            true
        });
        if !self.scenes.iter().any(|scene| scene.id == self.active_id) {
            self.active_id = self
                .scenes
                .first()
                .map(|scene| scene.id.clone())
                .unwrap_or_default();
        }
    }
}

impl ClipScene {
    fn sanitize_sources(&mut self) {
        self.sources.truncate(MAX_CLIP_SOURCES);
        let mut seen: Vec<String> = Vec::with_capacity(self.sources.len());
        self.sources.retain_mut(|source| {
            if !CLIP_SOURCE_KINDS.contains(&source.kind.as_str()) {
                return false;
            }
            if source.id.is_empty() || source.id.len() > 64 || seen.contains(&source.id) {
                return false;
            }
            seen.push(source.id.clone());
            source.name = sanitize_clip_scene_name(&source.name);
            match source.transform.as_mut() {
                Some(transform) => transform.sanitize_transform(),
                None => {}
            }
            match source.crop.as_mut() {
                Some(crop) => crop.sanitize_crop(),
                None => {}
            }
            truncate_clip_setting(&mut source.settings, "text", MAX_CLIP_TEXT);
            truncate_clip_setting(&mut source.settings, "path", MAX_CLIP_PATH);
            true
        });
    }
}

fn default_clip_library_version() -> u32 {
    1
}

fn default_unit() -> f32 {
    1.0
}

/// Mirrors `clampUnit` (src/recording/scene.ts:155): non-finite collapses to `min`.
fn clamp_unit(value: f32, min: f32, max: f32) -> f32 {
    if !value.is_finite() {
        return min;
    }
    value.clamp(min, max.max(min))
}

/// Mirrors `sanitizeSceneId` (src/recording/scene.ts:132).
fn sanitize_clip_scene_id(raw: &str) -> Option<String> {
    if raw.len() > 64 {
        return None;
    }
    let rest = raw.strip_prefix("scene-")?;
    if rest.is_empty() || !rest.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
        return None;
    }
    Some(raw.to_string())
}

/// Mirrors `sanitizeSceneName` (src/recording/scene.ts:125).
fn sanitize_clip_scene_name(raw: &str) -> String {
    let stripped: String = raw
        .chars()
        .filter(|ch| !ch.is_control() && *ch != '\u{7f}')
        .collect();
    let trimmed: String = stripped.trim().chars().take(MAX_CLIP_SCENE_NAME).collect();
    if trimmed.is_empty() {
        "Scene".to_string()
    } else {
        trimmed
    }
}

fn truncate_clip_setting(settings: &mut serde_json::Map<String, Value>, key: &str, max: usize) {
    if let Some(Value::String(text)) = settings.get_mut(key) {
        if text.chars().count() > max {
            *text = text.chars().take(max).collect();
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WebcamSettings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub device_id: String,
    #[serde(default = "default_webcam_name")]
    pub name: String,
    #[serde(default = "default_webcam_width")]
    pub width: u32,
    #[serde(default = "default_webcam_height")]
    pub height: u32,
    #[serde(default = "default_webcam_fps")]
    pub fps: u32,
    #[serde(default = "default_true")]
    pub mirror_preview: bool,
    #[serde(default)]
    pub mirror_recording: bool,
    #[serde(default = "default_webcam_placement")]
    pub default_placement: String,
    #[serde(default = "default_webcam_shape")]
    pub default_shape: String,
    #[serde(default = "default_webcam_overlay_width")]
    pub default_width: f32,
}

impl Default for WebcamSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            device_id: String::new(),
            name: default_webcam_name(),
            width: default_webcam_width(),
            height: default_webcam_height(),
            fps: default_webcam_fps(),
            mirror_preview: true,
            mirror_recording: false,
            default_placement: default_webcam_placement(),
            default_shape: default_webcam_shape(),
            default_width: default_webcam_overlay_width(),
        }
    }
}

impl WebcamSettings {
    pub fn display_name(&self) -> String {
        let name = self.name.trim();
        if name.is_empty() {
            default_webcam_name()
        } else {
            name.chars().take(32).collect()
        }
    }

    pub fn sanitize(&mut self) {
        self.device_id = self.device_id.trim().chars().take(512).collect();
        if self.device_id.contains('\0') || self.device_id.contains("..") {
            self.device_id.clear();
        }
        self.name = self.display_name();
        self.width = match self.width {
            1920 => 1920,
            1280 => 1280,
            640 => 640,
            other if other >= 1600 => 1920,
            other if other >= 960 => 1280,
            _ => 1280,
        };
        self.height = match self.width {
            1920 => 1080,
            640 => 480,
            _ => 720,
        };
        self.fps = match self.fps {
            60 => 60,
            24 => 24,
            15 => 15,
            _ => 30,
        };
        self.default_placement = match self.default_placement.as_str() {
            "top-left" | "top-right" | "bottom-left" => self.default_placement.clone(),
            _ => default_webcam_placement(),
        };
        self.default_shape = match self.default_shape.as_str() {
            "rectangle" | "circle" => self.default_shape.clone(),
            _ => default_webcam_shape(),
        };
        self.default_width = self.default_width.clamp(0.12, 0.40);
    }
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            close_to_tray: true,
            launch_at_startup: false,
            instant_replay_enabled: true,
            replay_duration_seconds: 60,
            resolution: "auto".into(),
            fps: 60,
            encoder: "auto".into(),
            bitrate: "medium".into(),
            custom_bitrate_kbps: 15000,
            codec: "h264".into(),
            microphone_id: "default".into(),
            audio_output_id: "default".into(),
            mic_enabled: false,
            mic_gain: default_mic_gain(),
            mic_channel_mode: default_channel_mode(),
            mic_pan: 0.0,
            game_audio_enabled: true,
            game_audio_gain: default_mic_gain(),
            game_audio_channel_mode: default_channel_mode(),
            game_audio_pan: 0.0,
            discord_audio_enabled: false,
            discord_audio_gain: default_mic_gain(),
            extra_apps: Vec::new(),
            system_audio_enabled: false,
            system_audio_gain: default_mic_gain(),
            system_audio_channel_mode: default_channel_mode(),
            system_audio_pan: 0.0,
            save_location: String::new(),
            hotkeys: Hotkeys::default(),
            auto_upload: "all".into(),
            cloud_upload_when: default_cloud_upload_when(),
            upload_bandwidth_limit: "unlimited".into(),
            custom_bandwidth_kbps: 10000,
            pause_uploads_while_gaming: true,
            min_free_disk_bytes: 10 * 1024 * 1024 * 1024,
            theme: "dark".into(),
            onboarding_completed: false,
            desktop_shortcut: false,
            desktop_shortcut_prompted: false,
            watermark_exports: true,
            clip_saved_notification: true,
            discord_rich_presence: true,
            webcam: WebcamSettings::default(),
            recording_visuals: RecordingVisualSettings::default(),
            clip_studio: ClipStudioSettings::default(),
            screenshots: ScreenshotSettings::default(),
            preview_quality: default_preview_quality(),
        }
    }
}

fn default_cloud_upload_when() -> String {
    "afterGame".into()
}

fn default_mic_gain() -> f32 {
    1.0
}

fn default_channel_mode() -> String {
    "auto".into()
}

fn sanitize_resolution(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "720p" => "720p".into(),
        "1080p" => "1080p".into(),
        "1440p" => "1440p".into(),
        "4k" | "2160p" => "4k".into(),
        "native" => "native".into(),
        "auto" => "auto".into(),
        // Legacy installs that stored unknown values fall back to safe Auto.
        _ => "auto".into(),
    }
}

fn sanitize_codec(value: &str) -> String {
    // Phase 1: H.264 is the only implemented recording codec.
    let _ = value;
    "h264".into()
}

fn sanitize_channel_mode(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "mono" => "mono".into(),
        "stereo" => "stereo".into(),
        _ => default_channel_mode(),
    }
}

fn default_webcam_name() -> String {
    "Webcam".into()
}

fn default_webcam_width() -> u32 {
    1280
}

fn default_webcam_height() -> u32 {
    720
}

fn default_webcam_fps() -> u32 {
    30
}

fn default_webcam_placement() -> String {
    "bottom-right".into()
}

fn default_webcam_shape() -> String {
    "rounded".into()
}

fn default_webcam_overlay_width() -> f32 {
    0.22
}

fn default_visual_filter() -> String {
    "none".into()
}

const SETTINGS_KEY: &str = "document";

pub fn load(conn: &Connection) -> AppResult<AppSettings> {
    let stored: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            [SETTINGS_KEY],
            |row| row.get(0),
        )
        .optional_row()?;
    match stored {
        Some(json) => Ok(parse_settings_json(&json)),
        None => {
            let defaults = AppSettings::default();
            save(conn, &defaults)?;
            Ok(defaults)
        }
    }
}

fn parse_settings_json(json: &str) -> AppSettings {
    let mut settings = if let Ok(settings) = serde_json::from_str::<AppSettings>(json) {
        settings
    } else {
        let mut value = match serde_json::to_value(AppSettings::default()) {
            Ok(value) => value,
            Err(_) => return AppSettings::default(),
        };
        if let Ok(mut stored) = serde_json::from_str::<Value>(json) {
            strip_nulls(&mut stored);
            merge_json(&mut value, stored);
        }
        serde_json::from_value(value).unwrap_or_default()
    };
    migrate_cloud_upload_when(&mut settings, json);
    settings.resolution = sanitize_resolution(&settings.resolution);
    settings.codec = sanitize_codec(&settings.codec);
    settings.webcam.sanitize();
    settings.recording_visuals.sanitize();
    settings.clip_studio.sanitize();
    settings.screenshots.sanitize();
    settings
}

fn migrate_cloud_upload_when(settings: &mut AppSettings, json: &str) {
    let missing = serde_json::from_str::<Value>(json)
        .ok()
        .and_then(|value| value.as_object().map(|map| !map.contains_key("cloudUploadWhen")))
        .unwrap_or(false);
    if missing {
        settings.cloud_upload_when = if settings.pause_uploads_while_gaming {
            "afterGame".into()
        } else {
            "immediate".into()
        };
    }
    if settings.cloud_upload_when != "immediate" && settings.cloud_upload_when != "afterGame" {
        settings.cloud_upload_when = default_cloud_upload_when();
    }
}

fn strip_nulls(value: &mut Value) {
    match value {
        Value::Object(map) => {
            map.retain(|_, child| !child.is_null());
            for child in map.values_mut() {
                strip_nulls(child);
            }
        }
        Value::Array(items) => {
            for item in items {
                strip_nulls(item);
            }
        }
        _ => {}
    }
}

pub fn save(conn: &Connection, settings: &AppSettings) -> AppResult<()> {
    let json = serde_json::to_string(settings)?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![SETTINGS_KEY, json],
    )?;
    Ok(())
}

pub fn set_document(conn: &Connection, patch: Value) -> AppResult<AppSettings> {
    let mut current = serde_json::to_value(load(conn)?)?;
    merge_json(&mut current, patch);
    let mut settings: AppSettings = serde_json::from_value(current)?;
    if settings.cloud_upload_when != "immediate" && settings.cloud_upload_when != "afterGame" {
        settings.cloud_upload_when = default_cloud_upload_when();
    }
    settings.resolution = sanitize_resolution(&settings.resolution);
    settings.codec = sanitize_codec(&settings.codec);
    settings.custom_bitrate_kbps = settings.custom_bitrate_kbps.clamp(1_000, 120_000);
    settings.mic_gain = settings.mic_gain.clamp(0.0, 2.0);
    settings.game_audio_gain = settings.game_audio_gain.clamp(0.0, 2.0);
    settings.discord_audio_gain = settings.discord_audio_gain.clamp(0.0, 2.0);
    settings.system_audio_gain = settings.system_audio_gain.clamp(0.0, 2.0);
    settings.mic_channel_mode = sanitize_channel_mode(&settings.mic_channel_mode);
    settings.game_audio_channel_mode = sanitize_channel_mode(&settings.game_audio_channel_mode);
    settings.system_audio_channel_mode = sanitize_channel_mode(&settings.system_audio_channel_mode);
    settings.mic_pan = settings.mic_pan.clamp(-1.0, 1.0);
    settings.game_audio_pan = settings.game_audio_pan.clamp(-1.0, 1.0);
    settings.system_audio_pan = settings.system_audio_pan.clamp(-1.0, 1.0);
    settings.webcam.sanitize();
    settings.recording_visuals.sanitize();
    settings.clip_studio.sanitize();
    settings.screenshots.sanitize();
    for app in &mut settings.extra_apps {
        app.gain = app.gain.clamp(0.0, 2.0);
        if app.id.trim().is_empty() {
            app.id = crate::games::normalize_process_name(&app.exe);
        }
        if app.exe.trim().is_empty() {
            return Err(AppError::Message("That app is missing an executable name.".into()));
        }
    }
    let extras = settings.extra_apps.len();
    if extras + usize::from(settings.discord_audio_enabled) > MAX_EXTRA_ISOLATED_APPS {
        return Err(AppError::Message(format!(
            "You can isolate up to {MAX_EXTRA_ISOLATED_APPS} apps besides the game. Discord counts as one."
        )));
    }
    save(conn, &settings)?;
    Ok(settings)
}

impl AppSettings {
    pub fn wants_isolated_audio(&self) -> bool {
        self.game_audio_enabled
            || self.discord_audio_enabled
            || self.extra_apps.iter().any(|app| app.enabled)
    }

    pub fn wants_audio_track(&self) -> bool {
        self.system_audio_enabled || self.mic_enabled || self.wants_isolated_audio()
    }
}

fn merge_json(target: &mut Value, patch: Value) {
    match (target, patch) {
        (Value::Object(map), Value::Object(patch_map)) => {
            for (key, value) in patch_map {
                merge_json(map.entry(key).or_insert(Value::Null), value);
            }
        }
        (target_slot, value) => *target_slot = value,
    }
}

trait OptionalRow<T> {
    fn optional_row(self) -> rusqlite::Result<Option<T>>;
}

impl<T> OptionalRow<T> for rusqlite::Result<T> {
    fn optional_row(self) -> rusqlite::Result<Option<T>> {
        match self {
            Ok(value) => Ok(Some(value)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(err) => Err(err),
        }
    }
}

#[allow(dead_code)]
pub fn validate_username(value: &str) -> Result<(), String> {
    let trimmed = value.trim();
    let valid = trimmed.len() >= 3
        && trimmed.len() <= 24
        && trimmed
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_');
    if valid {
        Ok(())
    } else {
        Err("Usernames must be 3–24 characters: letters, numbers, or underscore.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::{migrate, open_path};
    use tempfile::tempdir;

    #[test]
    fn settings_round_trip_and_patch() {
        let dir = tempdir().unwrap();
        let conn = open_path(&dir.path().join("db.sqlite")).unwrap();
        migrate(&conn).unwrap();
        let loaded = load(&conn).unwrap();
        assert!(!loaded.onboarding_completed);
        let updated = set_document(
            &conn,
            serde_json::json!({ "onboardingCompleted": true, "fps": 120 }),
        )
        .unwrap();
        assert!(updated.onboarding_completed);
        assert_eq!(updated.fps, 120);
        assert_eq!(load(&conn).unwrap(), updated);
    }

    #[test]
    fn desktop_shortcut_fields_default_when_missing() {
        let mut value = serde_json::to_value(AppSettings::default()).unwrap();
        let object = value.as_object_mut().unwrap();
        object.remove("desktopShortcut");
        object.remove("desktopShortcutPrompted");
        let loaded: AppSettings = serde_json::from_value(value).unwrap();
        assert!(!loaded.desktop_shortcut);
        assert!(!loaded.desktop_shortcut_prompted);
    }

    #[test]
    fn webcam_defaults_off_when_missing() {
        let mut value = serde_json::to_value(AppSettings::default()).unwrap();
        let object = value.as_object_mut().unwrap();
        object.remove("webcam");
        let loaded: AppSettings = serde_json::from_value(value).unwrap();
        assert!(!loaded.webcam.enabled);
        assert!(loaded.webcam.device_id.is_empty());
        assert_eq!(loaded.webcam.width, 1280);
        assert_eq!(loaded.webcam.height, 720);
        assert_eq!(loaded.webcam.fps, 30);
        assert!(loaded.webcam.mirror_preview);
        assert!(!loaded.webcam.mirror_recording);
        assert_eq!(loaded.webcam.default_placement, "bottom-right");
        assert_eq!(loaded.webcam.default_shape, "rounded");
    }

    #[test]
    fn webcam_sanitize_rejects_path_injection() {
        let mut webcam = WebcamSettings {
            device_id: String::from("..\\not-a-camera"),
            name: String::from("  Facecam  "),
            fps: 90,
            default_width: 2.0,
            ..WebcamSettings::default()
        };
        webcam.sanitize();
        assert!(webcam.device_id.is_empty());
        assert_eq!(webcam.name, "Facecam");
        assert_eq!(webcam.fps, 30);
        assert!((webcam.default_width - 0.40).abs() < f32::EPSILON);
        assert!(!webcam.enabled);
    }

    #[test]
    fn clip_saved_notification_defaults_on_when_missing() {
        let mut value = serde_json::to_value(AppSettings::default()).unwrap();
        let object = value.as_object_mut().unwrap();
        object.remove("clipSavedNotification");
        let loaded: AppSettings = serde_json::from_value(value).unwrap();
        assert!(loaded.clip_saved_notification);
    }

    #[test]
    fn cloud_upload_when_defaults_after_game_when_missing() {
        let mut value = serde_json::to_value(AppSettings::default()).unwrap();
        let object = value.as_object_mut().unwrap();
        object.remove("cloudUploadWhen");
        object.insert("pauseUploadsWhileGaming".into(), Value::Bool(true));
        let loaded = parse_settings_json(&value.to_string());
        assert_eq!(loaded.cloud_upload_when, "afterGame");
    }

    #[test]
    fn cloud_upload_when_migrates_from_pause_off() {
        let mut value = serde_json::to_value(AppSettings::default()).unwrap();
        let object = value.as_object_mut().unwrap();
        object.remove("cloudUploadWhen");
        object.insert("pauseUploadsWhileGaming".into(), Value::Bool(false));
        let loaded = parse_settings_json(&value.to_string());
        assert_eq!(loaded.cloud_upload_when, "immediate");
    }

    #[test]
    fn recording_visuals_default_none_when_missing() {
        let mut value = serde_json::to_value(AppSettings::default()).unwrap();
        let object = value.as_object_mut().unwrap();
        object.remove("recordingVisuals");
        let loaded: AppSettings = serde_json::from_value(value).unwrap();
        assert_eq!(loaded.recording_visuals.filter, "none");
        assert!(!loaded.recording_visuals.overlays.rec_indicator);
        assert!(!loaded.recording_visuals.overlays.timestamp);
    }

    #[test]
    fn screenshot_settings_default_when_missing() {
        // A settings file written before region screenshots existed must still parse strictly,
        // not fall back to the merge path, and pick up the new defaults.
        let mut value = serde_json::to_value(AppSettings::default()).unwrap();
        let object = value.as_object_mut().unwrap();
        object.remove("screenshots");
        object
            .get_mut("hotkeys")
            .and_then(|hotkeys| hotkeys.as_object_mut())
            .unwrap()
            .remove("regionScreenshot");
        let strict: AppSettings = serde_json::from_value(value.clone()).expect("old files parse strictly");
        assert_eq!(strict.hotkeys.region_screenshot, "CommandOrControl+PrintScreen");
        assert!(strict.screenshots.auto_upload, "auto-upload is on by default");
        assert!(strict.screenshots.save_local, "local PNG is kept by default");
        assert_eq!(strict.screenshots.copy_mode, "link");
        assert!(strict.screenshots.show_overlay);
        // The existing Instant Replay screenshot binding is untouched.
        assert_eq!(strict.hotkeys.screenshot, "CommandOrControl+F11");
    }

    #[test]
    fn screenshot_save_local_requires_auto_upload() {
        let mut settings = ScreenshotSettings {
            auto_upload: false,
            save_local: false,
            ..Default::default()
        };
        settings.sanitize();
        assert!(settings.save_local);
    }

    #[test]
    fn screenshot_copy_mode_sanitizes_unknown_values() {
        let mut settings = ScreenshotSettings { copy_mode: "gif".into(), ..Default::default() };
        settings.sanitize();
        assert_eq!(settings.copy_mode, "link");
        let mut image = ScreenshotSettings { copy_mode: "image".into(), ..Default::default() };
        image.sanitize();
        assert!(!image.copies_link());
    }

    #[test]
    fn clip_studio_defaults_when_missing() {
        let mut value = serde_json::to_value(AppSettings::default()).unwrap();
        value.as_object_mut().unwrap().remove("clipStudio");
        let loaded = parse_settings_json(&value.to_string());
        assert_eq!(loaded.clip_studio.version, 1);
        assert_eq!(loaded.clip_studio.active_id, "");
        assert!(loaded.clip_studio.scenes.is_empty());
    }

    fn clip_scene_with(sources: Vec<ClipSceneSource>) -> ClipScene {
        ClipScene {
            id: "scene-abc123".into(),
            name: "Clip".into(),
            sources,
        }
    }

    fn clip_source(id: &str, kind: &str) -> ClipSceneSource {
        ClipSceneSource {
            id: id.into(),
            kind: kind.into(),
            name: kind.into(),
            enabled: true,
            locked: false,
            order: 1,
            transform: None,
            crop: None,
            settings: serde_json::Map::new(),
        }
    }

    #[test]
    fn clip_studio_sanitize_clamps_transform_and_crop() {
        let mut source = clip_source("game-1", "game");
        // Below the 0.06 transform floor, x past the right edge, y negative, h non-finite.
        source.transform = Some(ClipRect {
            x: 1.5,
            y: -3.0,
            w: 0.01,
            h: f32::NAN,
        });
        // Below the 0.05 crop floor.
        source.crop = Some(ClipRect {
            x: 0.5,
            y: 0.5,
            w: 0.0,
            h: 2.0,
        });
        let mut studio = ClipStudioSettings {
            version: 1,
            active_id: "scene-abc123".into(),
            scenes: vec![clip_scene_with(vec![source])],
        };
        studio.sanitize();

        let source = &studio.scenes[0].sources[0];
        let transform = source.transform.unwrap();
        assert_eq!(transform.w, 0.06);
        assert_eq!(transform.h, 0.06);
        assert_eq!(transform.x, 0.94);
        assert_eq!(transform.y, 0.0);
        let crop = source.crop.unwrap();
        assert_eq!(crop.w, 0.05);
        assert_eq!(crop.h, 1.0);
        assert_eq!(crop.x, 0.5);
        assert_eq!(crop.y, 0.0);
    }

    #[test]
    fn clip_studio_sanitize_drops_bad_ids_and_caps_length() {
        let mut long_text = clip_source("text-1", "text");
        long_text
            .settings
            .insert("text".into(), Value::String("x".repeat(MAX_CLIP_TEXT + 40)));

        let mut studio = ClipStudioSettings {
            version: 9,
            active_id: "scene-gone".into(),
            scenes: vec![
                ClipScene {
                    id: "not-a-scene-id".into(),
                    name: "Bad".into(),
                    sources: Vec::new(),
                },
                ClipScene {
                    id: "scene-abc123".into(),
                    name: "  \u{1}Trimmed\u{7f}  ".into(),
                    sources: vec![
                        clip_source("game-1", "game"),
                        clip_source("bogus-1", "notARealKind"),
                        clip_source("game-1", "display"), // duplicate id
                        long_text,
                    ],
                },
            ],
        };
        studio.sanitize();

        assert_eq!(studio.version, 1, "out-of-range versions fall back to 1");
        assert_eq!(studio.scenes.len(), 1, "malformed scene ids are dropped");
        let scene = &studio.scenes[0];
        assert_eq!(scene.name, "Trimmed");
        assert_eq!(
            scene.sources.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
            vec!["game-1", "text-1"],
            "unknown kinds and duplicate ids are dropped"
        );
        let text = scene.sources[1].settings.get("text").unwrap();
        assert_eq!(text.as_str().unwrap().chars().count(), MAX_CLIP_TEXT);
        assert_eq!(
            studio.active_id, "scene-abc123",
            "a dangling activeId falls back to the first surviving scene"
        );
    }

    #[test]
    fn clip_studio_round_trip_preserves_sources() {
        let mut overlay = clip_source("overlay-1", "replayrOverlay");
        overlay.settings.insert("filter".into(), Value::String("vhs".into()));
        overlay.settings.insert("recIndicator".into(), Value::Bool(false));
        overlay.settings.insert("timestamp".into(), Value::Bool(true));
        let mut webcam = clip_source("webcam-1", "webcam");
        webcam.transform = Some(ClipRect {
            x: 0.03,
            y: 0.03,
            w: 0.22,
            h: 0.124,
        });
        webcam.settings.insert("shape".into(), Value::String("circle".into()));

        let mut settings = AppSettings::default();
        settings.clip_studio = ClipStudioSettings {
            version: 1,
            active_id: "scene-abc123".into(),
            scenes: vec![clip_scene_with(vec![
                clip_source("game-1", "game"),
                webcam,
                overlay,
            ])],
        };
        settings.clip_studio.sanitize();

        let json = serde_json::to_string(&settings).unwrap();
        let loaded = parse_settings_json(&json);
        assert_eq!(loaded.clip_studio, settings.clip_studio);
    }

    #[test]
    fn setting_clip_studio_leaves_recording_visuals_and_audio_untouched() {
        let dir = tempdir().unwrap();
        let conn = open_path(&dir.path().join("db.sqlite")).unwrap();
        migrate(&conn).unwrap();

        // Give every key the clip studio must never write a non-default value first.
        let before = set_document(
            &conn,
            serde_json::json!({
                "micEnabled": true,
                "gameAudioEnabled": false,
                "systemAudioEnabled": true,
                "recordingVisuals": { "filter": "cinematic", "overlays": { "recIndicator": true, "timestamp": true } },
                "webcam": { "enabled": true, "defaultPlacement": "top-left", "defaultShape": "circle", "defaultWidth": 0.3 },
            }),
        )
        .unwrap();

        let after = set_document(
            &conn,
            serde_json::json!({
                "clipStudio": {
                    "version": 1,
                    "activeId": "scene-abc123",
                    "scenes": [{
                        "id": "scene-abc123",
                        "name": "Clip",
                        "sources": [{
                            "id": "overlay-1",
                            "type": "replayrOverlay",
                            "name": "Replayr overlay",
                            "enabled": true,
                            "locked": false,
                            "order": 2,
                            "transform": null,
                            "crop": null,
                            "settings": { "filter": "bodycam", "recIndicator": true, "timestamp": false }
                        }]
                    }]
                }
            }),
        )
        .unwrap();

        assert_eq!(after.clip_studio.scenes.len(), 1, "the clip scene was stored");
        assert_eq!(after.recording_visuals, before.recording_visuals);
        assert_eq!(after.mic_enabled, before.mic_enabled);
        assert_eq!(after.game_audio_enabled, before.game_audio_enabled);
        assert_eq!(after.system_audio_enabled, before.system_audio_enabled);
        assert_eq!(after.webcam, before.webcam);
    }

    #[test]
    fn parse_settings_json_fills_missing_recording_visuals() {
        let mut value = serde_json::to_value(AppSettings::default()).unwrap();
        value.as_object_mut().unwrap().remove("recordingVisuals");
        let loaded = parse_settings_json(&value.to_string());
        assert_eq!(loaded.recording_visuals.filter, "none");
        assert!(!loaded.recording_visuals.overlays.rec_indicator);
        assert!(!loaded.recording_visuals.overlays.timestamp);
    }

    #[test]
    fn parse_settings_json_sanitizes_unknown_filter() {
        let mut value = serde_json::to_value(AppSettings::default()).unwrap();
        value["recordingVisuals"]["filter"] = serde_json::json!("hdr-plus");
        let loaded = parse_settings_json(&value.to_string());
        assert_eq!(loaded.recording_visuals.filter, "none");
    }

    #[test]
    fn recording_visuals_sanitize_rejects_unknown_filter() {
        let mut visuals = RecordingVisualSettings {
            filter: String::from("hdr-plus"),
            overlays: RecordingOverlaySettings {
                rec_indicator: true,
                timestamp: true,
            },
        };
        visuals.sanitize();
        assert_eq!(visuals.filter, "none");
        assert!(visuals.overlays.rec_indicator);
        assert!(visuals.overlays.timestamp);
    }

    #[test]
    fn discord_rich_presence_defaults_on_when_missing() {
        let mut value = serde_json::to_value(AppSettings::default()).unwrap();
        let object = value.as_object_mut().unwrap();
        object.remove("discordRichPresence");
        let loaded: AppSettings = serde_json::from_value(value).unwrap();
        assert!(loaded.discord_rich_presence);
    }

    #[test]
    fn mic_fields_default_when_missing() {
        let mut value = serde_json::to_value(AppSettings::default()).unwrap();
        let object = value.as_object_mut().unwrap();
        object.remove("micGain");
        object.remove("micEnabled");
        let loaded: AppSettings = serde_json::from_value(value).unwrap();
        assert!((loaded.mic_gain - 1.0).abs() < f32::EPSILON);
        assert!(!loaded.mic_enabled);
    }

    #[test]
    fn isolated_audio_fields_default_when_missing() {
        let mut value = serde_json::to_value(AppSettings::default()).unwrap();
        let object = value.as_object_mut().unwrap();
        object.remove("gameAudioEnabled");
        object.remove("discordAudioEnabled");
        object.remove("extraApps");
        let loaded: AppSettings = serde_json::from_value(value).unwrap();
        assert!(loaded.game_audio_enabled);
        assert!(!loaded.discord_audio_enabled);
        assert!(loaded.extra_apps.is_empty());
        assert!(!loaded.system_audio_enabled);
    }

    #[test]
    fn extra_app_cap_refuses_fifth_isolated_source() {
        let dir = tempdir().unwrap();
        let conn = open_path(&dir.path().join("db.sqlite")).unwrap();
        migrate(&conn).unwrap();
        let extras: Vec<ExtraAudioApp> = (0..4)
            .map(|index| ExtraAudioApp {
                id: format!("app-{index}"),
                exe: format!("app{index}.exe"),
                display_name: format!("App {index}"),
                enabled: true,
                gain: 1.0,
            })
            .collect();
        let updated = set_document(
            &conn,
            serde_json::json!({ "extraApps": extras, "discordAudioEnabled": false }),
        )
        .unwrap();
        assert_eq!(updated.extra_apps.len(), 4);
        let err = set_document(&conn, serde_json::json!({ "discordAudioEnabled": true })).unwrap_err();
        assert!(err.to_string().contains("up to 4"));
    }

    #[test]
    fn settings_load_recovers_from_null_mic_fields() {
        let dir = tempdir().unwrap();
        let conn = open_path(&dir.path().join("db.sqlite")).unwrap();
        migrate(&conn).unwrap();
        let mut value = serde_json::to_value(AppSettings::default()).unwrap();
        value["micGain"] = Value::Null;
        value["micEnabled"] = Value::Null;
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)",
            rusqlite::params![SETTINGS_KEY, value.to_string()],
        )
        .unwrap();
        let loaded = load(&conn).unwrap();
        assert!((loaded.mic_gain - 1.0).abs() < f32::EPSILON);
        assert!(!loaded.mic_enabled);
    }

    #[test]
    fn username_rules() {
        assert!(validate_username("alex").is_ok());
        assert!(validate_username("A_1").is_ok());
        assert!(validate_username("ab").is_err());
        assert!(validate_username("has space").is_err());
        assert!(validate_username("bad-name").is_err());
    }
}
