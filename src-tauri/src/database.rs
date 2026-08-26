use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::Connection;
use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};

pub struct AppState {
    pub db: Mutex<Connection>,
}

const MIGRATIONS: &[(i64, &str)] = &[
    (1, include_str!("../migrations/001_init.sql")),
    (2, include_str!("../migrations/002_games.sql")),
    (3, include_str!("../migrations/003_gta_fivem.sql")),
    (4, include_str!("../migrations/004_more_games.sql")),
    (5, include_str!("../migrations/005_clip_lineage.sql")),
    (6, include_str!("../migrations/006_editor_crop.sql")),
    (7, include_str!("../migrations/007_clip_sources.sql")),
];

pub fn database_path(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|err| AppError::Message(err.to_string()))?;
    Ok(dir.join("replay.sqlite"))
}

pub fn open_path(path: &Path) -> AppResult<Connection> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    Ok(conn)
}

pub fn migrate(conn: &Connection) -> AppResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            applied_at TEXT NOT NULL
        );",
    )?;
    let current: i64 = conn.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
        [],
        |row| row.get(0),
    )?;
    for (version, sql) in MIGRATIONS {
        if *version > current {
            conn.execute_batch(sql)?;
            conn.execute(
                "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, datetime('now'))",
                [*version],
            )?;
        }
    }
    Ok(())
}

pub fn open_for_app(app: &AppHandle) -> AppResult<Connection> {
    let path = database_path(app)?;
    let conn = open_path(&path)?;
    migrate(&conn)?;
    Ok(conn)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn migrations_apply_to_empty_database() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("test.sqlite");
        let conn = open_path(&path).unwrap();
        migrate(&conn).unwrap();
        migrate(&conn).unwrap();

        let version: i64 = conn
            .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, 7);

        let tables: Vec<String> = {
            let mut stmt = conn
                .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
                .unwrap();
            stmt.query_map([], |row| row.get(0))
                .unwrap()
                .map(|row| row.unwrap())
                .collect()
        };
        assert!(tables.contains(&"settings".to_string()));
        assert!(tables.contains(&"local_clips".to_string()));
        assert!(tables.contains(&"upload_queue".to_string()));
        assert!(tables.contains(&"games".to_string()));
        assert!(tables.contains(&"clip_sources".to_string()));
    }
}
