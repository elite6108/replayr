use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use crate::database::AppState;
use crate::games::{detect_games, load_catalog, DetectedGameSnapshot};
use crate::process::{foreground_pid, list_processes};

pub struct DetectionState {
    pub current: Mutex<DetectedGameSnapshot>,
    empty_polls: Mutex<u8>,
}

impl Default for DetectionState {
    fn default() -> Self {
        Self {
            current: Mutex::new(DetectedGameSnapshot::empty()),
            empty_polls: Mutex::new(0),
        }
    }
}

pub fn start(app: AppHandle) {
    thread::Builder::new()
        .name("game-detect".into())
        .spawn(move || loop {
            poll_once(&app);
            thread::sleep(Duration::from_secs(2));
        })
        .ok();
}

pub fn current_snapshot(state: &DetectionState) -> DetectedGameSnapshot {
    state
        .current
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or_else(|_| DetectedGameSnapshot::empty())
}

fn poll_once(app: &AppHandle) {
    let catalog = {
        let db_state = app.state::<AppState>();
        let catalog = match db_state.db.lock() {
            Ok(conn) => load_catalog(&conn).unwrap_or_default(),
            Err(_) => return,
        };
        catalog
    };

    let observed = detect_games(&list_processes(), foreground_pid(), &catalog);
    let detection = app.state::<DetectionState>();
    let mut empty_polls = match detection.empty_polls.lock() {
        Ok(guard) => guard,
        Err(_) => return,
    };
    let mut current = match detection.current.lock() {
        Ok(guard) => guard,
        Err(_) => return,
    };

    let next = if observed.slug.is_none() && current.slug.is_some() {
        *empty_polls = empty_polls.saturating_add(1);
        if *empty_polls < 2 {
            current.clone()
        } else {
            observed
        }
    } else {
        *empty_polls = 0;
        observed
    };

    let changed = *current != next;
    if changed {
        *current = next.clone();
    }
    let snapshot = current.clone();
    drop(current);
    drop(empty_polls);

    #[cfg(windows)]
    refresh_audio(app, &catalog, &snapshot);

    if !changed {
        return;
    }

    if let Some(name) = next.name.as_deref() {
        tracing::info!("detected game: {name}");
    } else {
        tracing::info!("no game detected");
    }

    let _ = app.emit("detected-game", &next);
    update_tray_tooltip(app, next.name.as_deref());
    crate::discord_presence::refresh(app);
    let rec = app.state::<crate::capture::RecordingState>();
    if let Err(err) = crate::capture::sync_replay(app, &rec, next.pid, next.name.clone(), next.slug.clone()) {
        tracing::warn!("replay retarget: {err}");
    }
}

#[cfg(windows)]
fn refresh_audio(app: &AppHandle, catalog: &[crate::games::GameRecord], snapshot: &crate::games::DetectedGameSnapshot) {
    let settings = {
        let db = app.state::<AppState>();
        db.db
            .lock()
            .ok()
            .and_then(|conn| crate::settings::load(&conn).ok())
    };
    if let Some(settings) = settings {
        app.state::<crate::audio::AudioRuntime>()
            .apply_with_context(&settings, snapshot, catalog);
    }
}

fn update_tray_tooltip(app: &AppHandle, game_name: Option<&str>) {
    let tooltip = match game_name {
        Some(name) => format!("{} — {name}", crate::branding::APP_NAME),
        None => crate::branding::APP_NAME.to_string(),
    };
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(&tooltip));
    }
}
