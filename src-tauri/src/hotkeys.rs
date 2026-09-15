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
    /// Shortcuts that could not be bound on the last sync, kept so Settings can explain them.
    failures: Mutex<Vec<HotkeyFailure>>,
}

/// One shortcut that could not be bound.
///
/// Registration is best-effort: another app holding a combo (ShareX and Greenshot commonly take
/// Ctrl+PrintScreen) must never stop Replayr from launching or disable the other shortcuts.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyFailure {
    pub action: &'static str,
    pub combo: String,
    pub reason: HotkeyFailureReason,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "detail")]
pub enum HotkeyFailureReason {
    /// The combo text does not parse.
    Invalid(String),
    /// Two actions were given the same combo; the later one loses.
    Duplicate(&'static str),
    /// The OS refused the registration, almost always because another app holds it.
    InUse(String),
}

/// A shortcut that parsed and is ready to register.
#[derive(Debug, Clone)]
pub(crate) struct PlannedHotkey {
    pub shortcut: Shortcut,
    pub action: &'static str,
    pub combo: String,
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
    if action == "region_screenshot" {
        // Owns its own thread and single-snip guard; nothing to do on the hotkey thread.
        crate::snip::start(app, crate::snip::SnipTrigger::Hotkey);
        return;
    }
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
                capture::start(app, &rec, snapshot.pid, snapshot.name, snapshot.slug, None)
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

/// Load hotkeys from settings and bind them. Only reading settings can fail; binding failures are
/// returned as data so a conflict never aborts app startup.
pub fn sync(app: &AppHandle) -> AppResult<Vec<HotkeyFailure>> {
    let hotkeys = {
        let db = app.state::<AppState>();
        let conn = db.db.lock().map_err(|err| AppError::Message(err.to_string()))?;
        settings::load(&conn)?.hotkeys
    };
    Ok(register_all(app, &hotkeys))
}

/// Every configurable action and its combo, in registration priority order.
fn bindings(hotkeys: &Hotkeys) -> [(&str, &'static str); 4] {
    [
        (hotkeys.save_replay.as_str(), "save_replay"),
        (hotkeys.toggle_recording.as_str(), "toggle_recording"),
        (hotkeys.screenshot.as_str(), "screenshot"),
        (hotkeys.region_screenshot.as_str(), "region_screenshot"),
    ]
}

/// Parse and de-duplicate combos without touching the OS. Pure, so it is unit-testable.
///
/// An invalid or duplicated combo becomes a failure for that one action; every other action is
/// still planned. Empty combos mean "unbound" and are skipped silently.
pub(crate) fn plan_registrations(
    entries: &[(&str, &'static str)],
) -> (Vec<PlannedHotkey>, Vec<HotkeyFailure>) {
    let mut planned: Vec<PlannedHotkey> = Vec::with_capacity(entries.len());
    let mut failures = Vec::new();
    for (combo, action) in entries.iter().copied() {
        let combo = combo.trim();
        if combo.is_empty() {
            continue;
        }
        let shortcut = match Shortcut::from_str(combo) {
            Ok(shortcut) => shortcut,
            Err(err) => {
                failures.push(HotkeyFailure {
                    action,
                    combo: combo.to_string(),
                    reason: HotkeyFailureReason::Invalid(err.to_string()),
                });
                continue;
            }
        };
        let key = shortcut_key(&shortcut);
        if let Some(owner) = planned.iter().find(|item| shortcut_key(&item.shortcut) == key) {
            failures.push(HotkeyFailure {
                action,
                combo: combo.to_string(),
                reason: HotkeyFailureReason::Duplicate(owner.action),
            });
            continue;
        }
        planned.push(PlannedHotkey { shortcut, action, combo: combo.to_string() });
    }
    (planned, failures)
}

/// Bind every hotkey that can be bound and record the rest.
///
/// Each shortcut is registered on its own, and the binding map is always replaced with whatever
/// succeeded — previously the first failure returned early and left the old map in place, so
/// freshly registered shortcuts did nothing.
pub fn register_all(app: &AppHandle, hotkeys: &Hotkeys) -> Vec<HotkeyFailure> {
    let (planned, mut failures) = plan_registrations(&bindings(hotkeys));

    let _ = app.global_shortcut().unregister_all();
    let mut next = HashMap::new();
    for item in planned {
        match app.global_shortcut().register(item.shortcut.clone()) {
            Ok(()) => {
                next.insert(shortcut_key(&item.shortcut), item.action);
            }
            Err(err) => failures.push(HotkeyFailure {
                action: item.action,
                combo: item.combo,
                reason: HotkeyFailureReason::InUse(err.to_string()),
            }),
        }
    }

    let map = app.state::<HotkeyMap>();
    if let Ok(mut bindings) = map.bindings.lock() {
        *bindings = next;
    }
    if let Ok(mut stored) = map.failures.lock() {
        *stored = failures.clone();
    }
    for failure in &failures {
        tracing::warn!(action = failure.action, combo = %failure.combo, reason = ?failure.reason, "hotkey not bound");
    }
    failures
}

/// Shortcuts that failed on the last sync, for the Settings Shortcuts pane.
pub fn last_failures(app: &AppHandle) -> Vec<HotkeyFailure> {
    app.state::<HotkeyMap>()
        .failures
        .lock()
        .map(|failures| failures.clone())
        .unwrap_or_default()
}

/// Human-readable summary, used when a settings save needs to report partial success.
pub fn describe_failures(failures: &[HotkeyFailure]) -> String {
    failures
        .iter()
        .map(|failure| match &failure.reason {
            HotkeyFailureReason::Invalid(_) => format!("{} is not a valid shortcut", failure.combo),
            HotkeyFailureReason::Duplicate(owner) => {
                format!("{} is already used by another Replayr shortcut ({owner})", failure.combo)
            }
            HotkeyFailureReason::InUse(_) => format!("{} is in use by another app", failure.combo),
        })
        .collect::<Vec<_>>()
        .join("; ")
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_combo_does_not_drop_valid_ones() {
        let (planned, failures) = plan_registrations(&[
            ("CommandOrControl+F10", "save_replay"),
            ("NotAKey+Banana", "toggle_recording"),
            ("CommandOrControl+F11", "screenshot"),
        ]);
        assert_eq!(
            planned.iter().map(|item| item.action).collect::<Vec<_>>(),
            vec!["save_replay", "screenshot"]
        );
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0].action, "toggle_recording");
        assert!(matches!(failures[0].reason, HotkeyFailureReason::Invalid(_)));
    }

    #[test]
    fn duplicate_combo_fails_only_the_later_action() {
        let (planned, failures) = plan_registrations(&[
            ("CommandOrControl+F10", "save_replay"),
            ("CommandOrControl+F10", "toggle_recording"),
        ]);
        assert_eq!(planned.len(), 1);
        assert_eq!(planned[0].action, "save_replay");
        assert_eq!(
            failures,
            vec![HotkeyFailure {
                action: "toggle_recording",
                combo: "CommandOrControl+F10".into(),
                reason: HotkeyFailureReason::Duplicate("save_replay"),
            }]
        );
    }

    #[test]
    fn empty_combo_means_unbound_not_failure() {
        let (planned, failures) = plan_registrations(&[("   ", "save_replay"), ("", "screenshot")]);
        assert!(planned.is_empty());
        assert!(failures.is_empty());
    }

    #[test]
    fn print_screen_combos_parse() {
        // The region screenshot default. Parsing must succeed or it would silently never bind.
        for combo in ["CommandOrControl+PrintScreen", "Shift+PrintScreen", "PrintScreen"] {
            assert!(Shortcut::from_str(combo).is_ok(), "{combo} should parse");
        }
    }

    #[test]
    fn describe_failures_is_readable() {
        let text = describe_failures(&[HotkeyFailure {
            action: "screenshot",
            combo: "CommandOrControl+PrintScreen".into(),
            reason: HotkeyFailureReason::InUse("os error".into()),
        }]);
        assert_eq!(text, "CommandOrControl+PrintScreen is in use by another app");
    }
}
