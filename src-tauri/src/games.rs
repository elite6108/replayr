use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::error::AppResult;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GameRecord {
    pub slug: String,
    pub cloud_id: Option<String>,
    pub name: String,
    pub publisher: Option<String>,
    pub cover_url: Option<String>,
    pub icon_url: Option<String>,
    pub process_names: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameInput {
    pub slug: String,
    pub cloud_id: Option<String>,
    pub name: String,
    pub publisher: Option<String>,
    pub cover_url: Option<String>,
    pub icon_url: Option<String>,
    pub process_names: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessRef {
    pub pid: u32,
    pub parent_pid: u32,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunningGame {
    pub slug: String,
    pub name: String,
    pub publisher: Option<String>,
    pub process_name: String,
    pub pid: u32,
    pub focused: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DetectedGameSnapshot {
    pub slug: Option<String>,
    pub name: Option<String>,
    pub publisher: Option<String>,
    pub process_name: Option<String>,
    pub pid: Option<u32>,
    pub focused: bool,
    pub running: Vec<RunningGame>,
}

impl DetectedGameSnapshot {
    pub fn empty() -> Self {
        Self {
            slug: None,
            name: None,
            publisher: None,
            process_name: None,
            pid: None,
            focused: false,
            running: Vec::new(),
        }
    }
}

pub fn load_catalog(conn: &Connection) -> AppResult<Vec<GameRecord>> {
    let mut stmt = conn.prepare(
        "SELECT slug, cloud_id, name, publisher, cover_url, icon_url, process_names
         FROM games
         ORDER BY name COLLATE NOCASE",
    )?;
    let rows = stmt.query_map([], |row| {
        let names_json: String = row.get(6)?;
        let process_names: Vec<String> = serde_json::from_str(&names_json).unwrap_or_default();
        Ok(GameRecord {
            slug: row.get(0)?,
            cloud_id: row.get(1)?,
            name: row.get(2)?,
            publisher: row.get(3)?,
            cover_url: row.get(4)?,
            icon_url: row.get(5)?,
            process_names,
        })
    })?;
    let mut games = Vec::new();
    for row in rows {
        games.push(row?);
    }
    Ok(games)
}

pub fn upsert_catalog(conn: &Connection, games: &[GameInput]) -> AppResult<Vec<GameRecord>> {
    let existing = load_catalog(conn)?;
    for game in games {
        let slug = game.slug.trim();
        if slug.is_empty() || game.name.trim().is_empty() {
            continue;
        }
        let current_names = existing
            .iter()
            .find(|item| item.slug == slug)
            .map(|item| item.process_names.as_slice())
            .unwrap_or(&[]);
        let process_names = merge_process_names(current_names, &game.process_names);
        let names = serde_json::to_string(&process_names)?;
        conn.execute(
            "INSERT INTO games (slug, cloud_id, name, publisher, cover_url, icon_url, process_names, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now'))
             ON CONFLICT(slug) DO UPDATE SET
                cloud_id = excluded.cloud_id,
                name = excluded.name,
                publisher = excluded.publisher,
                cover_url = excluded.cover_url,
                icon_url = excluded.icon_url,
                process_names = excluded.process_names,
                updated_at = excluded.updated_at",
            rusqlite::params![
                slug,
                game.cloud_id,
                game.name.trim(),
                game.publisher,
                game.cover_url,
                game.icon_url,
                names
            ],
        )?;
    }
    load_catalog(conn)
}

pub fn normalize_process_name(value: &str) -> String {
    value
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or(value)
        .trim()
        .trim_matches('"')
        .to_ascii_lowercase()
}

pub fn process_name_matches(pattern: &str, process_name: &str) -> bool {
    glob_match(
        &normalize_process_name(pattern),
        &normalize_process_name(process_name),
    )
}

fn glob_match(pattern: &str, text: &str) -> bool {
    fn rec(pattern: &[u8], text: &[u8]) -> bool {
        match (pattern.first().copied(), text.first().copied()) {
            (None, None) => true,
            (Some(b'*'), _) => rec(&pattern[1..], text) || (!text.is_empty() && rec(pattern, &text[1..])),
            (Some(expected), Some(actual)) if expected == actual => rec(&pattern[1..], &text[1..]),
            _ => false,
        }
    }
    rec(pattern.as_bytes(), text.as_bytes())
}

fn merge_process_names(existing: &[String], incoming: &[String]) -> Vec<String> {
    let mut names = Vec::new();
    for name in existing.iter().chain(incoming.iter()) {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            continue;
        }
        if names
            .iter()
            .any(|item: &String| normalize_process_name(item) == normalize_process_name(trimmed))
        {
            continue;
        }
        names.push(trimmed.to_string());
    }
    names
}

pub fn detect_games(
    processes: &[ProcessRef],
    foreground_pid: Option<u32>,
    catalog: &[GameRecord],
) -> DetectedGameSnapshot {
    let mut by_exe: Vec<(&GameRecord, &str)> = Vec::new();
    for game in catalog {
        for exe in &game.process_names {
            by_exe.push((game, exe.as_str()));
        }
    }

    let mut running: Vec<RunningGame> = Vec::new();
    for process in processes {
        let normalized = normalize_process_name(&process.name);
        if normalized.is_empty() {
            continue;
        }
        let Some((game, _)) = by_exe
            .iter()
            .find(|(_, exe)| process_name_matches(exe, &normalized))
        else {
            continue;
        };
        let focused = foreground_pid == Some(process.pid);
        if let Some(existing) = running.iter_mut().find(|item| item.slug == game.slug) {
            if focused || (!existing.focused && process.pid < existing.pid) {
                existing.pid = process.pid;
                existing.process_name = process.name.clone();
                existing.focused = existing.focused || focused;
            }
            continue;
        }
        running.push(RunningGame {
            slug: game.slug.clone(),
            name: game.name.clone(),
            publisher: game.publisher.clone(),
            process_name: process.name.clone(),
            pid: process.pid,
            focused,
        });
    }

    running.sort_by(|a, b| a.name.to_ascii_lowercase().cmp(&b.name.to_ascii_lowercase()));

    let primary = running
        .iter()
        .find(|game| game.focused)
        .cloned()
        .or_else(|| running.first().cloned());

    match primary {
        Some(game) => DetectedGameSnapshot {
            slug: Some(game.slug),
            name: Some(game.name),
            publisher: game.publisher,
            process_name: Some(game.process_name),
            pid: Some(game.pid),
            focused: game.focused,
            running,
        },
        None => DetectedGameSnapshot::empty(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::{migrate, open_path};
    use tempfile::tempdir;

    fn catalog() -> Vec<GameRecord> {
        vec![
            GameRecord {
                slug: "valorant".into(),
                cloud_id: None,
                name: "Valorant".into(),
                publisher: Some("Riot Games".into()),
                cover_url: None,
                icon_url: None,
                process_names: vec!["VALORANT-Win64-Shipping.exe".into()],
            },
            GameRecord {
                slug: "cs2".into(),
                cloud_id: None,
                name: "Counter-Strike 2".into(),
                publisher: Some("Valve".into()),
                cover_url: None,
                icon_url: None,
                process_names: vec!["cs2.exe".into()],
            },
        ]
    }

    #[test]
    fn matches_process_name_case_insensitively() {
        let processes = vec![ProcessRef {
            pid: 20,
            parent_pid: 0,
            name: r"C:\Riot Games\VALORANT\live\VALORANT-Win64-Shipping.exe".into(),
        }];
        let snapshot = detect_games(&processes, Some(20), &catalog());
        assert_eq!(snapshot.slug.as_deref(), Some("valorant"));
        assert!(snapshot.focused);
        assert_eq!(snapshot.running.len(), 1);
    }

    #[test]
    fn keeps_running_game_when_unfocused() {
        let processes = vec![
            ProcessRef {
                pid: 8,
                parent_pid: 0,
                name: "explorer.exe".into(),
            },
            ProcessRef {
                pid: 40,
                parent_pid: 0,
                name: "cs2.exe".into(),
            },
        ];
        let snapshot = detect_games(&processes, Some(8), &catalog());
        assert_eq!(snapshot.slug.as_deref(), Some("cs2"));
        assert!(!snapshot.focused);
    }

    #[test]
    fn prefers_focused_game_when_several_are_running() {
        let processes = vec![
            ProcessRef {
                pid: 11,
                parent_pid: 0,
                name: "cs2.exe".into(),
            },
            ProcessRef {
                pid: 22,
                parent_pid: 0,
                name: "VALORANT-Win64-Shipping.exe".into(),
            },
        ];
        let snapshot = detect_games(&processes, Some(22), &catalog());
        assert_eq!(snapshot.slug.as_deref(), Some("valorant"));
        assert!(snapshot.focused);
        assert_eq!(snapshot.running.len(), 2);
    }

    #[test]
    fn ignores_unknown_processes() {
        let processes = vec![ProcessRef {
            pid: 1,
            parent_pid: 0,
            name: "notepad.exe".into(),
        }];
        let snapshot = detect_games(&processes, Some(1), &catalog());
        assert_eq!(snapshot, DetectedGameSnapshot::empty());
    }

    #[test]
    fn glob_process_names_match_prefix() {
        assert!(process_name_matches("*GTAProcess.exe", "FiveM_b3258_GTAProcess.exe"));
        assert!(process_name_matches("GTA5.exe", "gta5.EXE"));
        assert!(!process_name_matches("*GTAProcess.exe", "FiveM.exe"));
        assert!(!process_name_matches("*GTAProcess.exe", "chrome.exe"));
    }

    #[test]
    fn migration_seeds_game_catalog() {
        let dir = tempdir().unwrap();
        let conn = open_path(&dir.path().join("db.sqlite")).unwrap();
        migrate(&conn).unwrap();
        let games = load_catalog(&conn).unwrap();
        assert!(games.len() >= 80);
        assert!(games.iter().any(|game| game.slug == "valorant"));
        assert!(games.iter().any(|game| game.slug == "cyberpunk-2077"));
        assert!(games.iter().any(|game| game.slug == "dead-by-daylight"));
        let gta = games.iter().find(|game| game.slug == "gta-v").unwrap();
        assert!(gta
            .process_names
            .iter()
            .any(|name| name.eq_ignore_ascii_case("*GTAProcess.exe")));
        assert!(games
            .iter()
            .find(|game| game.slug == "valorant")
            .unwrap()
            .process_names
            .iter()
            .any(|name| normalize_process_name(name) == "valorant-win64-shipping.exe"));
    }

    #[test]
    fn upsert_replaces_process_names_by_slug() {
        let dir = tempdir().unwrap();
        let conn = open_path(&dir.path().join("db.sqlite")).unwrap();
        migrate(&conn).unwrap();
        upsert_catalog(
            &conn,
            &[GameInput {
                slug: "valorant".into(),
                cloud_id: Some("cloud-1".into()),
                name: "Valorant".into(),
                publisher: Some("Riot Games".into()),
                cover_url: None,
                icon_url: None,
                process_names: vec!["VALORANT-Win64-Shipping.exe".into(), "VALORANT.exe".into()],
            }],
        )
        .unwrap();
        let valorant = load_catalog(&conn)
            .unwrap()
            .into_iter()
            .find(|game| game.slug == "valorant")
            .unwrap();
        assert_eq!(valorant.cloud_id.as_deref(), Some("cloud-1"));
        assert!(valorant
            .process_names
            .iter()
            .any(|name| normalize_process_name(name) == "valorant-win64-shipping.exe"));
        assert!(valorant
            .process_names
            .iter()
            .any(|name| normalize_process_name(name) == "valorant.exe"));
    }

    #[test]
    fn matches_fivem_gta_process_wildcard() {
        let catalog = vec![GameRecord {
            slug: "gta-v".into(),
            cloud_id: None,
            name: "Grand Theft Auto V".into(),
            publisher: Some("Rockstar Games".into()),
            cover_url: None,
            icon_url: None,
            process_names: vec![
                "GTA5.exe".into(),
                "GTA5_Enhanced.exe".into(),
                "*GTAProcess.exe".into(),
            ],
        }];
        let snapshot = detect_games(
            &[ProcessRef {
                pid: 6920,
                parent_pid: 0,
                name: "FiveM_b3258_GTAProcess.exe".into(),
            }],
            Some(1),
            &catalog,
        );
        assert_eq!(snapshot.slug.as_deref(), Some("gta-v"));
        assert_eq!(snapshot.process_name.as_deref(), Some("FiveM_b3258_GTAProcess.exe"));
    }
}
