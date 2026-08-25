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
    pub upload_bandwidth_limit: String,
    pub custom_bandwidth_kbps: u32,
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
            upload_bandwidth_limit: "unlimited".into(),
            custom_bandwidth_kbps: 10000,
            pause_uploads_while_gaming: true,
            min_free_disk_bytes: 10 * 1024 * 1024 * 1024,
            theme: "dark".into(),
            onboarding_completed: false,
            desktop_shortcut: false,
            desktop_shortcut_prompted: false,
            watermark_exports: true,
        }
    }
}

fn default_mic_gain() -> f32 {
    1.0
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
    if let Ok(settings) = serde_json::from_str::<AppSettings>(json) {
        return settings;
    }
    let mut value = match serde_json::to_value(AppSettings::default()) {
        Ok(value) => value,
        Err(_) => return AppSettings::default(),
    };
    if let Ok(mut stored) = serde_json::from_str::<Value>(json) {
        strip_nulls(&mut stored);
        merge_json(&mut value, stored);
    }
    serde_json::from_value(value).unwrap_or_default()
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
    settings.mic_gain = settings.mic_gain.clamp(0.0, 2.0);
    settings.game_audio_gain = settings.game_audio_gain.clamp(0.0, 2.0);
    settings.discord_audio_gain = settings.discord_audio_gain.clamp(0.0, 2.0);
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
