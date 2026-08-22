use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::AppResult;

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
    pub mic_enabled: bool,
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
            mic_enabled: true,
            system_audio_enabled: true,
            save_location: String::new(),
            hotkeys: Hotkeys::default(),
            auto_upload: "all".into(),
            upload_bandwidth_limit: "unlimited".into(),
            custom_bandwidth_kbps: 10000,
            pause_uploads_while_gaming: true,
            min_free_disk_bytes: 10 * 1024 * 1024 * 1024,
            theme: "dark".into(),
            onboarding_completed: false,
        }
    }
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
        Some(json) => Ok(serde_json::from_str(&json)?),
        None => {
            let defaults = AppSettings::default();
            save(conn, &defaults)?;
            Ok(defaults)
        }
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
    let settings: AppSettings = serde_json::from_value(current)?;
    save(conn, &settings)?;
    Ok(settings)
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
    fn username_rules() {
        assert!(validate_username("alex").is_ok());
        assert!(validate_username("A_1").is_ok());
        assert!(validate_username("ab").is_err());
        assert!(validate_username("has space").is_err());
        assert!(validate_username("bad-name").is_err());
    }
}
