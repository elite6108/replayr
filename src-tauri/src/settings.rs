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

fn default_game_audio_enabled() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Hotkeys {
    pub save_replay: String,
    pub toggle_recording: String,
    pub screenshot: String,
}

impl Default for Hotkeys {
    fn default() -> Self {
        Self {
            save_replay: "CommandOrControl+F10".into(),
            toggle_recording: "CommandOrControl+F9".into(),
            screenshot: "CommandOrControl+F11".into(),
        }
    }
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
    #[serde(default = "default_game_audio_enabled")]
    pub game_audio_enabled: bool,
    #[serde(default = "default_mic_gain")]
    pub game_audio_gain: f32,
    #[serde(default)]
    pub discord_audio_enabled: bool,
    #[serde(default = "default_mic_gain")]
    pub discord_audio_gain: f32,
    #[serde(default)]
    pub extra_apps: Vec<ExtraAudioApp>,
    pub system_audio_enabled: bool,
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
            resolution: "native".into(),
            fps: 60,
            encoder: "auto".into(),
            bitrate: "medium".into(),
            custom_bitrate_kbps: 15000,
            codec: "h264".into(),
            microphone_id: "default".into(),
            audio_output_id: "default".into(),
            mic_enabled: false,
            mic_gain: default_mic_gain(),
            game_audio_enabled: true,
            game_audio_gain: default_mic_gain(),
            discord_audio_enabled: false,
            discord_audio_gain: default_mic_gain(),
            extra_apps: Vec::new(),
            system_audio_enabled: false,
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
        }
    }
}

fn default_cloud_upload_when() -> String {
    "afterGame".into()
}

fn default_mic_gain() -> f32 {
    1.0
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
    settings.webcam.sanitize();
    settings.recording_visuals.sanitize();
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
    settings.mic_gain = settings.mic_gain.clamp(0.0, 2.0);
    settings.game_audio_gain = settings.game_audio_gain.clamp(0.0, 2.0);
    settings.discord_audio_gain = settings.discord_audio_gain.clamp(0.0, 2.0);
    settings.webcam.sanitize();
    settings.recording_visuals.sanitize();
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
