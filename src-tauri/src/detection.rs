use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use crate::database::AppState;
use crate::games::{detect_games_with, load_catalog, DetectedGameSnapshot, ProcessRef};

/// A different catalog game must stay focused this many polls before it replaces the live one.
const GAME_SWITCH_POLLS: u8 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PendingGameSwitch {
    pid: u32,
    polls: u8,
}
use crate::process::{foreground_window, list_processes};
use crate::unknown_game::{
    learn_unknown_foreground, remember_learned_game, snapshot_from_sighting,
};

pub struct DetectionState {
    pub current: Mutex<DetectedGameSnapshot>,
    empty_polls: Mutex<u8>,
    pending_switch: Mutex<Option<PendingGameSwitch>>,
    last_foreground_pid: Mutex<Option<u32>>,
    unknown: Mutex<Option<crate::unknown_game::UnknownWatch>>,
}

impl Default for DetectionState {
    fn default() -> Self {
        Self {
            current: Mutex::new(DetectedGameSnapshot::empty()),
            empty_polls: Mutex::new(0),
            pending_switch: Mutex::new(None),
            last_foreground_pid: Mutex::new(None),
            unknown: Mutex::new(None),
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

    let window = foreground_window();
    let fg = window.as_ref().map(|item| item.pid);
    let processes = list_processes();
    let detection = app.state::<DetectionState>();
    let preferred_pid = current_snapshot(&detection).pid.filter(|id| *id != 0);
    let visible_pids = crate::game_window::pids_with_capturable_window(
        &processes
            .iter()
            .map(|process| process.pid)
            .collect::<Vec<_>>(),
    );
    let catalog_hit = detect_games_with(&processes, fg, &catalog, preferred_pid, &visible_pids);
    let observed = if catalog_hit.focused {
        catalog_hit
    } else if let Some(pid) = fg {
        let process_name = processes
            .iter()
            .find(|process| process.pid == pid)
            .map(|process| process.name.as_str())
            .unwrap_or("");
        let title = window
            .as_ref()
            .map(|item| item.title.as_str())
            .unwrap_or("");
        let sighting = {
            let mut watch = match detection.unknown.lock() {
                Ok(guard) => guard,
                Err(_) => return,
            };
            learn_unknown_foreground(false, &mut watch, pid, process_name, title)
        };
        if let Some(sighting) = sighting {
            if sighting.just_learned {
                remember_sighting(app, &sighting.process, &sighting.title);
                tracing::info!(process = %sighting.process, "learned foreground game");
            }
            snapshot_from_sighting(&sighting)
        } else if learned_session(&detection) {
            DetectedGameSnapshot::empty()
        } else {
            catalog_hit
        }
    } else {
        catalog_hit
    };
    let mut pending_switch = match detection.pending_switch.lock() {
        Ok(guard) => guard,
        Err(_) => return,
    };
    let mut empty_polls = match detection.empty_polls.lock() {
        Ok(guard) => guard,
        Err(_) => return,
    };
    let mut current = match detection.current.lock() {
        Ok(guard) => guard,
        Err(_) => return,
    };
    let current_pid = current.pid.filter(|id| *id != 0);
    let current_alive = current_pid.is_some_and(crate::process::pid_alive);
    let current_visible = current_pid.is_some_and(|pid| visible_pids.contains(&pid));
    let reconciled = reconcile_detection(
        &current,
        &observed,
        current_alive,
        current_visible,
        &processes,
        &mut pending_switch,
    );

    let next = if reconciled.name.is_none() && current.name.is_some() {
        *empty_polls = empty_polls.saturating_add(1);
        if *empty_polls < 2 {
            current.clone()
        } else {
            reconciled
        }
    } else {
        *empty_polls = 0;
        reconciled
    };

    let changed = *current != next;
    if changed {
        *current = next.clone();
    }
    let snapshot = current.clone();
    drop(current);
    drop(empty_polls);
    drop(pending_switch);

    log_foreground_vs_capture(app, &detection, fg);

    let rec = app.state::<crate::capture::RecordingState>();
    let ir_running = rec.ir_lock().is_some();
    // Health-check a locked IR target every poll; otherwise only sync when
    // detection actually changes (avoids idle scratch churn every 2s).
    if ir_running || changed {
        if let Err(err) = crate::capture::sync_replay(
            app,
            &rec,
            snapshot.pid,
            snapshot.name.clone(),
            snapshot.slug.clone(),
        ) {
            tracing::warn!("replay retarget: {err}");
        }
    }

    // After sync, so a retarget pins Game Audio to the process we just locked.
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
}

fn remember_sighting(app: &AppHandle, process: &str, title: &str) {
    let db_state = app.state::<AppState>();
    let Ok(conn) = db_state.db.lock() else {
        return;
    };
    let _ = remember_learned_game(&conn, process, title);
}

/// Keep a live game through Alt-Tab. A different catalog game has to stay focused.
fn reconcile_detection(
    current: &DetectedGameSnapshot,
    observed: &DetectedGameSnapshot,
    current_alive: bool,
    current_visible: bool,
    processes: &[ProcessRef],
    pending: &mut Option<PendingGameSwitch>,
) -> DetectedGameSnapshot {
    let Some(current_pid) = current.pid.filter(|id| *id != 0 && current.name.is_some()) else {
        *pending = None;
        return observed.clone();
    };
    if !current_alive || !current_visible {
        *pending = None;
        return observed.clone();
    }
    if observed.pid == Some(current_pid) {
        *pending = None;
        return observed.clone();
    }
    if is_game_handoff(current, observed, processes) {
        *pending = None;
        return observed.clone();
    }
    if let Some(next_pid) = different_focused_catalog(current, observed) {
        let polls = match pending.as_ref() {
            Some(existing) if existing.pid == next_pid => existing.polls.saturating_add(1),
            _ => 1,
        };
        if polls >= GAME_SWITCH_POLLS {
            *pending = None;
            return observed.clone();
        }
        *pending = Some(PendingGameSwitch { pid: next_pid, polls });
        let mut held = current.clone();
        held.focused = false;
        return held;
    }
    *pending = None;
    let mut held = current.clone();
    held.focused = false;
    held
}

fn is_game_handoff(
    current: &DetectedGameSnapshot,
    observed: &DetectedGameSnapshot,
    processes: &[ProcessRef],
) -> bool {
    let (Some(current_pid), Some(next_pid)) = (current.pid, observed.pid) else {
        return false;
    };
    if current_pid == next_pid || !observed.focused {
        return false;
    }
    match (current.slug.as_deref(), observed.slug.as_deref()) {
        (Some(current_slug), Some(next_slug)) if current_slug == next_slug => {
            !is_parent_pid(processes, next_pid, current_pid)
        }
        _ => false,
    }
}

fn different_focused_catalog(current: &DetectedGameSnapshot, observed: &DetectedGameSnapshot) -> Option<u32> {
    let next_slug = observed.slug.as_deref()?;
    if !observed.focused {
        return None;
    }
    let next_pid = observed.pid.filter(|id| *id != 0)?;
    if current.pid == Some(next_pid) || current.slug.as_deref() == Some(next_slug) {
        return None;
    }
    Some(next_pid)
}

fn is_parent_pid(processes: &[ProcessRef], parent: u32, child: u32) -> bool {
    processes
        .iter()
        .any(|process| process.pid == child && process.parent_pid == parent)
}

fn learned_session(detection: &DetectionState) -> bool {
    detection
        .current
        .lock()
        .map(|current| current.slug.is_none() && current.name.is_some())
        .unwrap_or(false)
}

fn log_foreground_vs_capture(app: &AppHandle, detection: &DetectionState, fg: Option<u32>) {
    let Ok(mut last_fg) = detection.last_foreground_pid.lock() else {
        return;
    };
    if *last_fg == fg {
        return;
    }
    let old = *last_fg;
    *last_fg = fg;

    let rec = app.state::<crate::capture::RecordingState>();
    let Some((capture_pid, _, _)) = rec.ir_lock() else {
        return;
    };
    tracing::info!(
        old_foreground = old.unwrap_or(0),
        new_foreground = fg.unwrap_or(0),
        capture_pid = capture_pid.unwrap_or(0),
        capture_target_unchanged = true,
        "Foreground changed"
    );
}

#[cfg(windows)]
fn refresh_audio(
    app: &AppHandle,
    catalog: &[crate::games::GameRecord],
    snapshot: &crate::games::DetectedGameSnapshot,
) {
    let settings = {
        let db = app.state::<AppState>();
        db.db
            .lock()
            .ok()
            .and_then(|conn| crate::settings::load(&conn).ok())
    };
    let Some(settings) = settings else {
        return;
    };
    // While Instant Replay owns a process, keep Game Audio pinned to that
    // capture target so Alt-Tab cannot retarget loopback to Discord/etc.
    let pinned = {
        let rec = app.state::<crate::capture::RecordingState>();
        rec.ir_lock().and_then(|(pid, game_id, title)| {
            pid.filter(|id| *id != 0).map(|pid| {
                let mut pinned = snapshot.clone();
                pinned.pid = Some(pid);
                if pinned.slug.is_none() {
                    pinned.slug = game_id;
                }
                if pinned.name.is_none() {
                    pinned.name = Some(title);
                }
                pinned.focused = true;
                pinned
            })
        })
    };
    let audio_snapshot = pinned.as_ref().unwrap_or(snapshot);
    app.state::<crate::audio::AudioRuntime>()
        .apply_with_context(&settings, audio_snapshot, catalog);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn game(slug: &str, name: &str, pid: u32, focused: bool) -> DetectedGameSnapshot {
        DetectedGameSnapshot {
            slug: Some(slug.into()),
            name: Some(name.into()),
            publisher: None,
            process_name: Some(format!("{name}.exe")),
            pid: Some(pid),
            focused,
            running: Vec::new(),
        }
    }

    fn learned(name: &str, pid: u32) -> DetectedGameSnapshot {
        DetectedGameSnapshot {
            slug: None,
            name: Some(name.into()),
            publisher: None,
            process_name: Some("other.exe".into()),
            pid: Some(pid),
            focused: true,
            running: Vec::new(),
        }
    }

    fn proc(pid: u32, parent_pid: u32) -> ProcessRef {
        ProcessRef {
            pid,
            parent_pid,
            name: format!("{pid}.exe"),
        }
    }

    #[test]
    fn alt_tab_to_another_process_keeps_the_live_game() {
        let current = game("roblox", "Roblox", 40, true);
        let observed = learned("Notes", 90);
        let mut pending = None;
        let held = reconcile_detection(&current, &observed, true, true, &[proc(40, 1), proc(90, 1)], &mut pending);
        assert_eq!(held.pid, Some(40));
        assert_eq!(held.name.as_deref(), Some("Roblox"));
        assert!(!held.focused);
        assert_eq!(pending, None);
    }

    #[test]
    fn alt_tab_back_to_the_launcher_keeps_the_game() {
        let current = game("valorant", "Valorant", 80, true);
        let launcher = game("valorant", "Valorant", 10, true);
        let processes = vec![proc(10, 1), proc(80, 10)];
        let mut pending = None;
        let held = reconcile_detection(&current, &launcher, true, true, &processes, &mut pending);
        assert_eq!(held.pid, Some(80));
        assert!(!held.focused);
        assert_eq!(pending, None);
    }

    #[test]
    fn launcher_hands_off_to_the_focused_game() {
        let launcher = game("valorant", "Valorant", 10, true);
        let shipping = game("valorant", "Valorant", 80, true);
        let processes = vec![proc(10, 1), proc(80, 10)];
        let mut pending = None;
        let next = reconcile_detection(&launcher, &shipping, true, true, &processes, &mut pending);
        assert_eq!(next.pid, Some(80));
        assert!(next.focused);
        assert_eq!(pending, None);
    }

    #[test]
    fn a_different_game_switches_only_after_it_stays_focused() {
        let current = game("roblox", "Roblox", 40, true);
        let other = game("cs2", "Counter-Strike 2", 70, true);
        let processes = vec![proc(40, 1), proc(70, 1)];
        let mut pending = None;
        let first = reconcile_detection(&current, &other, true, true, &processes, &mut pending);
        assert_eq!(first.pid, Some(40));
        assert_eq!(pending, Some(PendingGameSwitch { pid: 70, polls: 1 }));
        let second = reconcile_detection(&first, &other, true, true, &processes, &mut pending);
        assert_eq!(second.pid, Some(40));
        assert_eq!(pending, Some(PendingGameSwitch { pid: 70, polls: 2 }));
        let third = reconcile_detection(&second, &other, true, true, &processes, &mut pending);
        assert_eq!(third.pid, Some(70));
        assert_eq!(third.slug.as_deref(), Some("cs2"));
        assert_eq!(pending, None);
    }

    #[test]
    fn one_alt_tab_poll_does_not_retarget() {
        let current = game("roblox", "Roblox", 40, true);
        let other = game("cs2", "Counter-Strike 2", 70, true);
        let mut pending = None;
        let held = reconcile_detection(&current, &other, true, true, &[proc(40, 1), proc(70, 1)], &mut pending);
        assert_eq!(held.pid, Some(40));
        assert_eq!(pending.map(|item| item.polls), Some(1));
    }

    #[test]
    fn a_dead_process_falls_through() {
        let current = game("roblox", "Roblox", 40, true);
        let observed = DetectedGameSnapshot::empty();
        let mut pending = Some(PendingGameSwitch { pid: 70, polls: 2 });
        let next = reconcile_detection(&current, &observed, false, false, &[proc(40, 1)], &mut pending);
        assert!(next.name.is_none());
        assert_eq!(pending, None);
    }

    #[test]
    fn a_closed_window_falls_through() {
        let current = game("roblox", "Roblox", 40, true);
        let observed = game("cs2", "Counter-Strike 2", 70, true);
        let mut pending = None;
        let next = reconcile_detection(&current, &observed, true, false, &[proc(40, 1), proc(70, 1)], &mut pending);
        assert_eq!(next.pid, Some(70));
    }

    #[test]
    fn the_same_process_keeps_its_focus_flag() {
        let current = game("roblox", "Roblox", 40, true);
        let observed = game("roblox", "Roblox", 40, false);
        let mut pending = Some(PendingGameSwitch { pid: 70, polls: 1 });
        let next = reconcile_detection(&current, &observed, true, true, &[proc(40, 1)], &mut pending);
        assert_eq!(next.pid, Some(40));
        assert!(!next.focused);
        assert_eq!(pending, None);
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
