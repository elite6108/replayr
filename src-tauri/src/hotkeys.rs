use std::collections::HashMap;
use std::str::FromStr;
use std::sync::Mutex;

use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_notification::NotificationExt;

use crate::capture::RecordingState;
use crate::database::AppState;
use crate::detection::DetectionState;
use crate::error::{AppError, AppResult};
use crate::settings::Hotkeys;
use crate::{capture, detection, settings};

#[derive(Default)]
pub struct HotkeyMap {
    bindings: Mutex<HashMap<String, &'static str>>,
}

pub fn handle(app: &AppHandle, shortcut: &Shortcut, event: tauri_plugin_global_shortcut::ShortcutEvent) {
    if event.state != ShortcutState::Pressed {
        return;
    }
    let action = {
        let map = app.state::<HotkeyMap>();
        let Ok(bindings) = map.bindings.lock() else {
            return;
        };
        bindings.get(&shortcut.to_string()).copied()
    };
    let Some(action) = action else {
        return;
    };
    // Global shortcuts fire on the UI thread. Remux/MF work must not run there.
    run_background(app, move |app| match action {
        "save_replay" => match capture::save_clip(app, &app.state::<RecordingState>()) {
            Ok(_) => {}
            Err(err) => notify(app, "Could not save clip", &err.to_string()),
        },
        "toggle_recording" => {
            let rec = app.state::<RecordingState>();
            let detection = app.state::<DetectionState>();
            let snapshot = detection::current_snapshot(&detection);
            let recording = capture::status(&rec).active;
            let result = if recording {
                capture::stop(app, &rec).map(|_| "Recording saved".to_string())
            } else {
                capture::start(app, &rec, snapshot.pid, snapshot.name, snapshot.slug)
                    .map(|_| "Recording started".to_string())
            };
            match result {
                Ok(title) => notify(app, &title, ""),
                Err(err) => notify(app, "Recording", &err.to_string()),
            }
        }
        "screenshot" => match capture::screenshot(app, &app.state::<RecordingState>()) {
            Ok(path) => notify(app, "Screenshot saved", &path),
            Err(err) => notify(app, "Could not save screenshot", &err.to_string()),
        },
        _ => {}
    });
}

fn run_background(app: &AppHandle, work: impl FnOnce(&AppHandle) + Send + 'static) {
    let app = app.clone();
    let _ = std::thread::Builder::new()
        .name("hotkey-action".into())
        .spawn(move || work(&app));
}

pub fn sync(app: &AppHandle) -> AppResult<()> {
    let hotkeys = {
        let db = app.state::<AppState>();
        let conn = db.db.lock().map_err(|err| AppError::Message(err.to_string()))?;
        settings::load(&conn)?.hotkeys
    };
    register_all(app, &hotkeys)
}

pub fn register_all(app: &AppHandle, hotkeys: &Hotkeys) -> AppResult<()> {
    // Parse first so a bad combo never leaves every shortcut unregistered.
    let planned = [
        (hotkeys.save_replay.as_str(), "save_replay"),
        (hotkeys.toggle_recording.as_str(), "toggle_recording"),
        (hotkeys.screenshot.as_str(), "screenshot"),
    ];
    let mut parsed = Vec::with_capacity(planned.len());
    for (combo, action) in planned {
        let combo = combo.trim();
        if combo.is_empty() {
            continue;
        }
        let shortcut = Shortcut::from_str(combo)
            .map_err(|err| AppError::Message(format!("Invalid hotkey {combo}: {err}")))?;
        parsed.push((shortcut, action, combo.to_string()));
    }

    let _ = app.global_shortcut().unregister_all();
    let mut next = HashMap::new();
    for (shortcut, action, combo) in parsed {
        app.global_shortcut()
            .register(shortcut.clone())
            .map_err(|err| AppError::Message(format!("Could not register {combo}: {err}")))?;
        next.insert(shortcut_key(&shortcut), action);
    }
    let map = app.state::<HotkeyMap>();
    if let Ok(mut bindings) = map.bindings.lock() {
        *bindings = next;
    }
    Ok(())
}

fn shortcut_key(shortcut: &Shortcut) -> String {
    shortcut.to_string()
}

fn notify(app: &AppHandle, title: &str, body: &str) {
    let mut builder = app.notification().builder().title(title);
    if !body.is_empty() {
        builder = builder.body(body);
    }
    let _ = builder.show();
}
