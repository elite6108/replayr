//! Presence thread: debounce, reconnect, setting-OFF clear-once.

use std::panic::AssertUnwindSafe;
use std::sync::mpsc::{self, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use discord_rich_presence::DiscordIpcClient;
use tauri::{AppHandle, Manager};

use super::ipc::{clear_presence, connect_client, write_activity};
use super::payload::{presence_game_name, set_game_presence, set_idle, PresencePayload};
use super::snapshot::{clipping_active, current_game, load_enabled};
use super::{DiscordPresenceStatus, PresenceMode};

const MIN_WRITE_INTERVAL: Duration = Duration::from_secs(2);
const POLL_INTERVAL: Duration = Duration::from_secs(2);
const MAX_BACKOFF: Duration = Duration::from_secs(30);

pub(crate) enum Cmd {
    Tick,
    Stop,
}

pub(crate) struct DiscordPresence {
    pub tx: Mutex<Option<SyncSender<Cmd>>>,
    pub status: Arc<Mutex<DiscordPresenceStatus>>,
}

pub fn start(app: &AppHandle) {
    let (tx, rx) = mpsc::sync_channel(1);
    let wakeup = tx.clone();
    let status = Arc::new(Mutex::new(DiscordPresenceStatus::default()));
    app.manage(DiscordPresence {
        tx: Mutex::new(Some(tx)),
        status: status.clone(),
    });
    let handle = app.clone();
    if let Err(err) = thread::Builder::new().name("discord-rpc".into()).spawn(move || {
        let result = std::panic::catch_unwind(AssertUnwindSafe(|| run_loop(&handle, rx, &status)));
        if let Err(panic) = result {
            tracing::warn!("discord presence thread panicked: {panic:?}");
            if let Ok(mut slot) = status.lock() {
                slot.mode = PresenceMode::Disconnected;
                slot.discord_connected = false;
                slot.last_presence_error = Some("presence thread panicked".into());
            }
        }
    }) {
        tracing::warn!("discord presence thread did not start: {err}");
        return;
    }
    let _ = wakeup.try_send(Cmd::Tick);
}

pub fn refresh(app: &AppHandle) {
    notify(app, Cmd::Tick);
}

pub fn stop(app: &AppHandle) {
    notify(app, Cmd::Stop);
}

pub fn status(app: &AppHandle) -> DiscordPresenceStatus {
    app.try_state::<DiscordPresence>()
        .and_then(|state| state.status.lock().ok().map(|guard| guard.clone()))
        .unwrap_or_default()
}

fn notify(app: &AppHandle, cmd: Cmd) {
    let Some(state) = app.try_state::<DiscordPresence>() else {
        return;
    };
    let Ok(guard) = state.tx.lock() else {
        return;
    };
    let Some(tx) = guard.as_ref() else {
        return;
    };
    let _ = tx.try_send(cmd);
}

fn run_loop(app: &AppHandle, rx: mpsc::Receiver<Cmd>, status: &Arc<Mutex<DiscordPresenceStatus>>) {
    let mut client: Option<DiscordIpcClient> = None;
    let mut connected = false;
    let mut enabled = true;
    let mut cleared_while_disabled = false;
    let mut last_written: Option<PresencePayload> = None;
    let mut pending: Option<PresencePayload> = None;
    let mut last_write_at: Option<Instant> = None;
    let mut last_write_ms: Option<u64> = None;
    let mut backoff = POLL_INTERVAL;

    loop {
        let wait = next_wait(enabled, connected, pending.is_some(), last_write_at, backoff);
        match rx.recv_timeout(wait) {
            Ok(Cmd::Stop) => {
                clear_presence(client.as_mut());
                publish_status(status, PresenceMode::Disabled, false, None, last_write_ms, None, None);
                return;
            }
            Ok(Cmd::Tick) | Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                clear_presence(client.as_mut());
                return;
            }
        }

        enabled = load_enabled(app).unwrap_or(enabled);
        if !enabled {
            if !cleared_while_disabled {
                clear_presence(client.as_mut());
                client = None;
                connected = false;
                last_written = None;
                pending = None;
                cleared_while_disabled = true;
            }
            publish_status(status, PresenceMode::Disabled, false, None, last_write_ms, None, None);
            continue;
        }
        cleared_while_disabled = false;

        if !connected {
            match connect_client() {
                Ok(next) => {
                    tracing::info!("discord presence connected");
                    client = Some(next);
                    connected = true;
                    backoff = POLL_INTERVAL;
                    last_written = None;
                    pending = None;
                    publish_status(status, PresenceMode::Idle, true, None, last_write_ms, None, None);
                }
                Err(err) => {
                    tracing::debug!("discord presence connect: {err}");
                    backoff = (backoff * 2).min(MAX_BACKOFF);
                    publish_status(
                        status,
                        PresenceMode::Disconnected,
                        false,
                        None,
                        last_write_ms,
                        None,
                        Some(err),
                    );
                    continue;
                }
            }
        }

        let snapshot = current_game(app);
        let clipping = clipping_active(app);
        let desired = match snapshot.slug.as_deref() {
            None => set_idle(),
            Some(_) => set_game_presence(
                snapshot.catalog_name.as_deref(),
                snapshot.slug.as_deref(),
                clipping,
                snapshot.artwork_url.as_deref(),
                None,
            ),
        };
        if last_written.as_ref().map(PresencePayload::fingerprint) != Some(desired.fingerprint()) {
            pending = Some(desired);
        }

        let Some(payload) = pending.clone() else {
            let mode = mode_for(true, snapshot.slug.is_some(), clipping);
            let game = presence_game_name(snapshot.slug.as_deref(), snapshot.catalog_name.as_deref());
            publish_status(status, mode, true, game, last_write_ms, last_written.as_ref(), None);
            continue;
        };

        let ready = last_write_at.map(|at| at.elapsed() >= MIN_WRITE_INTERVAL).unwrap_or(true);
        if !ready {
            continue;
        }

        let Some(ipc) = client.as_mut() else {
            connected = false;
            continue;
        };
        match write_activity(ipc, &payload) {
            Ok(()) => {
                last_written = Some(payload.clone());
                pending = None;
                last_write_at = Some(Instant::now());
                last_write_ms = Some(unix_ms());
                let game = presence_game_name(snapshot.slug.as_deref(), snapshot.catalog_name.as_deref());
                let mode = mode_for(true, snapshot.slug.is_some(), clipping);
                publish_status(status, mode, true, game, last_write_ms, Some(&payload), None);
            }
            Err(err) => {
                tracing::debug!("discord presence write: {err}");
                clear_presence(Some(ipc));
                client = None;
                connected = false;
                last_written = None;
                pending = None;
                backoff = POLL_INTERVAL;
                publish_status(
                    status,
                    PresenceMode::Disconnected,
                    false,
                    None,
                    last_write_ms,
                    Some(&payload),
                    Some(err),
                );
            }
        }
    }
}

fn next_wait(
    enabled: bool,
    connected: bool,
    has_pending: bool,
    last_write_at: Option<Instant>,
    backoff: Duration,
) -> Duration {
    if !enabled {
        return POLL_INTERVAL;
    }
    if !connected {
        return backoff;
    }
    if has_pending {
        let elapsed = last_write_at.map(|at| at.elapsed()).unwrap_or(MIN_WRITE_INTERVAL);
        return MIN_WRITE_INTERVAL.saturating_sub(elapsed);
    }
    POLL_INTERVAL
}

fn mode_for(connected: bool, has_game: bool, clipping: bool) -> PresenceMode {
    if !connected {
        PresenceMode::Disconnected
    } else if !has_game {
        PresenceMode::Idle
    } else if clipping {
        PresenceMode::Clipping
    } else {
        PresenceMode::Game
    }
}

fn publish_status(
    status: &Arc<Mutex<DiscordPresenceStatus>>,
    mode: PresenceMode,
    connected: bool,
    game: Option<String>,
    last_write_ms: Option<u64>,
    card: Option<&PresencePayload>,
    error: Option<String>,
) {
    let Ok(mut slot) = status.lock() else {
        return;
    };
    slot.mode = mode;
    slot.discord_connected = connected;
    slot.current_presence_game = game;
    slot.last_presence_update = last_write_ms;
    if let Some(card) = card {
        slot.last_details = Some(card.details.clone());
        slot.last_state = Some(card.state.clone());
        slot.last_large_image = Some(card.large_image.clone());
    }
    if let Some(error) = error {
        slot.last_presence_error = Some(error);
    } else {
        slot.last_presence_error = None;
    }
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}
