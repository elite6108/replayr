use tauri::menu::{MenuBuilder, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

use crate::branding::APP_NAME;
use crate::capture::{self, RecordingState};
use crate::database::AppState;
use crate::detection::{self, DetectionState};
use crate::error::{AppError, AppResult};
use crate::settings;

pub fn setup_tray(app: &AppHandle) -> AppResult<()> {
    let open = item(app, "open", "Open", true)?;
    let save_clip = item(app, "save_clip", "Save Clip", true)?;
    let start = item(app, "start_recording", "Start Recording", true)?;
    let stop = item(app, "stop_recording", "Stop Recording", true)?;
    let replay = item(app, "instant_replay", "Toggle Instant Replay", true)?;
    let library = item(app, "uploads", "Library", true)?;
    let settings_item = item(app, "settings", "Settings", true)?;
    let exit = item(app, "exit", "Exit", true)?;

    let menu = MenuBuilder::new(app)
        .item(&open)
        .separator()
        .item(&save_clip)
        .item(&start)
        .item(&stop)
        .item(&replay)
        .separator()
        .item(&library)
        .item(&settings_item)
        .separator()
        .item(&exit)
        .build()
        .map_err(|err| AppError::Message(err.to_string()))?;

    TrayIconBuilder::with_id("main")
        .icon(
            app.default_window_icon()
                .cloned()
                .ok_or_else(|| AppError::Message("missing window icon".into()))?,
        )
        .tooltip(APP_NAME)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "save_clip" => {
                let app = app.clone();
                std::thread::spawn(move || {
                    let rec = app.state::<RecordingState>();
                    if let Err(err) = capture::save_clip(&app, &rec) {
                        tracing::warn!("tray save clip: {err}");
                    }
                });
            }
            "start_recording" => {
                let rec = app.state::<RecordingState>();
                let detection = app.state::<DetectionState>();
                let snapshot = detection::current_snapshot(&detection);
                if let Err(err) = capture::start(app, &rec, snapshot.pid, snapshot.name, snapshot.slug) {
                    tracing::warn!("tray start recording: {err}");
                }
            }
            "stop_recording" => {
                let rec = app.state::<RecordingState>();
                if let Err(err) = capture::stop(app, &rec) {
                    tracing::warn!("tray stop recording: {err}");
                }
            }
            "instant_replay" => {
                let rec = app.state::<RecordingState>();
                let detection = app.state::<DetectionState>();
                let snapshot = detection::current_snapshot(&detection);
                let enabled = toggle_instant_replay(app);
                if let Err(err) = capture::sync_replay(app, &rec, snapshot.pid, snapshot.name, snapshot.slug) {
                    tracing::warn!("tray instant replay ({enabled}): {err}");
                }
            }
            "uploads" => {
                show_main(app);
                let _ = app.emit("navigate", "/library/cloud");
            }
            "settings" => {
                show_main(app);
                let _ = app.emit("navigate", "/settings");
            }
            "exit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        })
        .build(app)
        .map_err(|err| AppError::Message(err.to_string()))?;

    Ok(())
}

fn item(app: &AppHandle, id: &str, title: &str, enabled: bool) -> AppResult<MenuItem<tauri::Wry>> {
    MenuItem::with_id(app, id, title, enabled, None::<&str>).map_err(|err| AppError::Message(err.to_string()))
}

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn toggle_instant_replay(app: &AppHandle) -> bool {
    let db = app.state::<AppState>();
    let Ok(conn) = db.db.lock() else {
        return true;
    };
    let Ok(current) = settings::load(&conn) else {
        return true;
    };
    let next = !current.instant_replay_enabled;
    let _ = settings::set_document(&conn, serde_json::json!({ "instantReplayEnabled": next }));
    next
}
