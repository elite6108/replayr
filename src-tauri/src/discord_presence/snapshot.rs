//! Read-only Replayr state for presence. Never takes the replay-buffer lock.

use tauri::{AppHandle, Manager};

use crate::capture::RecordingState;
use crate::database::AppState;
use crate::detection::DetectionState;

pub(crate) struct GameView {
    pub slug: Option<String>,
    pub catalog_name: Option<String>,
    pub artwork_url: Option<String>,
}

pub(crate) fn load_enabled(app: &AppHandle) -> Option<bool> {
    let db = app.try_state::<AppState>()?;
    let conn = db.db.lock().ok()?;
    crate::settings::load(&conn).ok().map(|settings| settings.discord_rich_presence)
}

pub(crate) fn current_game(app: &AppHandle) -> GameView {
    let Some(detection) = app.try_state::<DetectionState>() else {
        return GameView {
            slug: None,
            catalog_name: None,
            artwork_url: None,
        };
    };
    let snapshot = crate::detection::current_snapshot(&detection);
    let artwork_url = snapshot
        .slug
        .as_deref()
        .and_then(|slug| lookup_artwork(app, slug));
    GameView {
        slug: snapshot.slug,
        catalog_name: snapshot.name,
        artwork_url,
    }
}

fn lookup_artwork(app: &AppHandle, slug: &str) -> Option<String> {
    let db = app.try_state::<AppState>()?;
    let conn = db.db.lock().ok()?;
    let catalog = crate::games::load_catalog(&conn).ok()?;
    catalog
        .into_iter()
        .find(|game| game.slug == slug)
        .and_then(|game| game.cover_url)
}

pub(crate) fn clipping_active(app: &AppHandle) -> bool {
    let Some(rec) = app.try_state::<RecordingState>() else {
        return false;
    };
    let recording = rec.status.lock().map(|status| status.active).unwrap_or(false);
    let replay = rec.replay.lock().map(|status| status.active).unwrap_or(false);
    recording || replay
}
