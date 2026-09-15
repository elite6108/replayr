//! Pull a Supabase session from the frontend per upload.
//!
//! supabase-js stops auto-refresh when the document is hidden, and Replayr hides to the tray, so a
//! token pushed into Rust would die within an hour. The desktop emits `screenshot-session-request`
//! and waits; the UI reads a fresh session and calls `screenshot_provide_session`. Unknown
//! request ids are ignored so a late reply after timeout cannot land in the next snip.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, SyncSender};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloudSession {
    pub access_token: String,
    pub api_base: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionRequest {
    request_id: u64,
    force_refresh: bool,
}

pub struct SessionBroker {
    next: AtomicU64,
    pending: Mutex<HashMap<u64, SyncSender<Option<CloudSession>>>>,
}

impl SessionBroker {
    pub fn new() -> Self {
        Self { next: AtomicU64::new(1), pending: Mutex::new(HashMap::new()) }
    }

    pub fn request(&self, app: &AppHandle, force_refresh: bool, timeout: Duration) -> Option<CloudSession> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::sync_channel(1);
        if let Ok(mut pending) = self.pending.lock() {
            pending.insert(id, tx);
        } else {
            return None;
        }
        let _ = app.emit("screenshot-session-request", SessionRequest { request_id: id, force_refresh });
        match rx.recv_timeout(timeout) {
            Ok(session) => session,
            Err(RecvTimeoutError::Timeout) | Err(RecvTimeoutError::Disconnected) => {
                if let Ok(mut pending) = self.pending.lock() {
                    pending.remove(&id);
                }
                None
            }
        }
    }

    /// Tests and the timeout path insert a waiter without emitting.
    pub fn insert_waiter(&self) -> (u64, std::sync::mpsc::Receiver<Option<CloudSession>>) {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::sync_channel(1);
        self.pending.lock().expect("session broker").insert(id, tx);
        (id, rx)
    }

    pub fn provide(&self, request_id: u64, session: Option<CloudSession>) {
        let sender = self.pending.lock().ok().and_then(|mut pending| pending.remove(&request_id));
        if let Some(sender) = sender {
            let _ = sender.send(session);
        }
    }
}

impl Default for SessionBroker {
    fn default() -> Self {
        Self::new()
    }
}

static BROKER: std::sync::OnceLock<SessionBroker> = std::sync::OnceLock::new();

pub fn broker() -> &'static SessionBroker {
    BROKER.get_or_init(SessionBroker::new)
}

pub const SESSION_TIMEOUT: Duration = Duration::from_secs(4);

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn unknown_request_id_is_ignored() {
        let broker = SessionBroker::new();
        broker.provide(99, Some(CloudSession { access_token: "x".into(), api_base: "https://www.replayr.tv".into() }));
        let (id, rx) = broker.insert_waiter();
        assert!(rx.recv_timeout(Duration::from_millis(20)).is_err());
        broker.provide(id, None);
        assert_eq!(rx.recv_timeout(Duration::from_millis(50)).unwrap(), None);
    }

    #[test]
    fn waiter_times_out_to_none() {
        let broker = SessionBroker::new();
        let (_id, rx) = broker.insert_waiter();
        assert!(matches!(rx.recv_timeout(Duration::from_millis(30)), Err(RecvTimeoutError::Timeout)));
    }
}
