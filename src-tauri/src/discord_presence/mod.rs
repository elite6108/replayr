//! Discord Rich Presence sidecar.
//!
//! Isolated from capture, replay, encoding, and settings persistence. Failures
//! here must never start up the app, block those paths, or fail a settings save.
//!
//! - [`payload`] mapping (card text / art)
//! - [`snapshot`] read-only Replayr state
//! - [`ipc`] Discord client
//! - [`manager`] reconnect / debounce thread

mod ipc;
mod manager;
mod payload;
mod snapshot;

use serde::Serialize;

pub use manager::{refresh, start, status, stop};

pub const DISCORD_CLIENT_ID: &str = match option_env!("DISCORD_CLIENT_ID") {
    Some(id) => id,
    None => "1543040704027037757",
};

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PresenceMode {
    Disabled,
    Disconnected,
    Idle,
    Game,
    Clipping,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiscordPresenceStatus {
    pub mode: PresenceMode,
    pub discord_connected: bool,
    pub current_presence_game: Option<String>,
    pub last_presence_update: Option<u64>,
    pub last_presence_error: Option<String>,
    pub last_details: Option<String>,
    pub last_state: Option<String>,
    pub last_large_image: Option<String>,
}

impl Default for DiscordPresenceStatus {
    fn default() -> Self {
        Self {
            mode: PresenceMode::Disconnected,
            discord_connected: false,
            current_presence_game: None,
            last_presence_update: None,
            last_presence_error: None,
            last_details: None,
            last_state: None,
            last_large_image: None,
        }
    }
}
