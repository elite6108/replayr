use serde::Serialize;
use tauri::State;

use crate::database::AppState;
use crate::error::{AppError, AppResult};

const MAX_PAYLOAD_BYTES: usize = 8 * 1024;
const MAX_PENDING_PER_USER: i64 = 500;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyticsOutboxItem {
    id: String,
    event_name: String,
    payload_json: String,
    occurred_at: String,
    attempts: i64,
}

#[tauri::command]
pub fn analytics_outbox_enqueue(
    state: State<AppState>,
    id: String,
    user_id: String,
    event_name: String,
    payload_json: String,
    occurred_at: String,
) -> AppResult<()> {
    validate(&id, &user_id, &event_name, &payload_json, &occurred_at)?;
    let conn = state
        .db
        .lock()
        .map_err(|err| AppError::Message(err.to_string()))?;
    conn.execute(
        "INSERT OR IGNORE INTO analytics_outbox
         (id, user_id, event_name, payload_json, occurred_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![id, user_id, event_name, payload_json, occurred_at],
    )?;
    conn.execute(
        "DELETE FROM analytics_outbox WHERE created_at < datetime('now', '-1 day')",
        [],
    )?;
    conn.execute(
        "DELETE FROM analytics_outbox
         WHERE user_id = ?1 AND id IN (
           SELECT id FROM analytics_outbox
           WHERE user_id = ?1
           ORDER BY created_at DESC, id DESC
           LIMIT -1 OFFSET ?2
         )",
        rusqlite::params![user_id, MAX_PENDING_PER_USER],
    )?;
    Ok(())
}

#[tauri::command]
pub fn analytics_outbox_list(
    state: State<AppState>,
    user_id: String,
    limit: Option<u32>,
) -> AppResult<Vec<AnalyticsOutboxItem>> {
    if user_id.is_empty() || user_id.len() > 128 {
        return Err(AppError::Message("Invalid analytics account.".into()));
    }
    let conn = state
        .db
        .lock()
        .map_err(|err| AppError::Message(err.to_string()))?;
    let limit = limit.unwrap_or(50).clamp(1, 100) as i64;
    let mut statement = conn.prepare(
        "SELECT id, event_name, payload_json, occurred_at, attempts
         FROM analytics_outbox
         WHERE user_id = ?1
         ORDER BY created_at ASC, id ASC
         LIMIT ?2",
    )?;
    let rows = statement.query_map(rusqlite::params![user_id, limit], |row| {
        Ok(AnalyticsOutboxItem {
            id: row.get(0)?,
            event_name: row.get(1)?,
            payload_json: row.get(2)?,
            occurred_at: row.get(3)?,
            attempts: row.get(4)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

#[tauri::command]
pub fn analytics_outbox_mark_attempt(state: State<AppState>, id: String, user_id: String) -> AppResult<()> {
    let conn = state
        .db
        .lock()
        .map_err(|err| AppError::Message(err.to_string()))?;
    conn.execute(
        "UPDATE analytics_outbox SET attempts = attempts + 1 WHERE id = ?1 AND user_id = ?2",
        rusqlite::params![id, user_id],
    )?;
    Ok(())
}

#[tauri::command]
pub fn analytics_outbox_delete(state: State<AppState>, id: String, user_id: String) -> AppResult<()> {
    let conn = state
        .db
        .lock()
        .map_err(|err| AppError::Message(err.to_string()))?;
    conn.execute(
        "DELETE FROM analytics_outbox WHERE id = ?1 AND user_id = ?2",
        rusqlite::params![id, user_id],
    )?;
    Ok(())
}

#[tauri::command]
pub fn analytics_outbox_clear(state: State<AppState>, user_id: String) -> AppResult<()> {
    let conn = state
        .db
        .lock()
        .map_err(|err| AppError::Message(err.to_string()))?;
    conn.execute(
        "DELETE FROM analytics_outbox WHERE user_id = ?1",
        rusqlite::params![user_id],
    )?;
    Ok(())
}

fn validate(id: &str, user_id: &str, event_name: &str, payload: &str, occurred_at: &str) -> AppResult<()> {
    if id.len() > 64
        || user_id.is_empty()
        || user_id.len() > 128
        || event_name.is_empty()
        || event_name.len() > 80
        || occurred_at.is_empty()
        || occurred_at.len() > 40
        || payload.len() > MAX_PAYLOAD_BYTES
    {
        return Err(AppError::Message("Invalid analytics outbox item.".into()));
    }
    Ok(())
}
