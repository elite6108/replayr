use rusqlite::Connection;
use sha2::{Digest, Sha256};

use crate::error::{AppError, AppResult};
use crate::games::{normalize_process_name, DetectedGameSnapshot};

/// Foreground polls required before an unknown executable becomes the session game.
/// Detection polls every 2 seconds, so this is about 30 seconds.
pub const UNKNOWN_STABLE_POLLS: u8 = 15;

const GENERIC_TITLES: &[&str] = &[
    "program manager",
    "windows input experience",
    "windows shell experience",
    "settings",
    "task manager",
    "search",
    "start",
    "replayr",
    "discord",
    "spotify",
    "steam",
    "epic games launcher",
];

const IGNORED_PROCESSES: &[&str] = &[
    "replay.exe",
    "replayr.exe",
    "explorer.exe",
    "searchhost.exe",
    "shellexperiencehost.exe",
    "applicationframehost.exe",
    "startmenuexperiencehost.exe",
    "textinputhost.exe",
    "systemsettings.exe",
    "lockapp.exe",
    "dwm.exe",
    "sihost.exe",
    "taskmgr.exe",
    "gamebar.exe",
    "gamebarftserver.exe",
    "chrome.exe",
    "msedge.exe",
    "firefox.exe",
    "brave.exe",
    "opera.exe",
    "discord.exe",
    "discordptb.exe",
    "discordcanary.exe",
    "spotify.exe",
    "steam.exe",
    "steamwebhelper.exe",
    "epicgameslauncher.exe",
    "epicwebhelper.exe",
    "battle.net.exe",
    "riotclientservices.exe",
    "riotclientux.exe",
    "riotclientuxrender.exe",
    "galaxyclient.exe",
    "upc.exe",
    "eadesktop.exe",
    "origin.exe",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnknownWatch {
    pub pid: u32,
    pub process: String,
    pub title: String,
    pub polls: u8,
    pub accepted: bool,
    pending_title: Option<String>,
    pending_polls: u8,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnknownSighting {
    pub process: String,
    pub title: String,
    pub pid: u32,
    pub just_learned: bool,
}

pub fn is_ignored_process(process_name: &str) -> bool {
    let normalized = normalize_process_name(process_name);
    IGNORED_PROCESSES.contains(&normalized.as_str())
}

pub fn clean_window_title(title: &str) -> Option<String> {
    if title.chars().any(|ch| ch.is_control()) {
        return None;
    }
    let without_marks = title.replace(['™', '®', '©'], "");
    let collapsed = without_marks.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() < 2 {
        return None;
    }
    let shortened = collapsed.chars().take(80).collect::<String>();
    let cleaned = shortened.trim().to_string();
    if cleaned.chars().count() < 2 {
        return None;
    }
    let lower = cleaned.to_ascii_lowercase();
    if GENERIC_TITLES.contains(&lower.as_str()) || lower.starts_with("http://") || lower.starts_with("https://") {
        return None;
    }
    Some(cleaned)
}

pub fn title_is_executable(title: &str, process_name: &str) -> bool {
    let title = title.trim().to_ascii_lowercase();
    let process = normalize_process_name(process_name);
    if title == process {
        return true;
    }
    let stem = process.strip_suffix(".exe").unwrap_or(&process);
    !stem.is_empty() && title == stem
}

/// Track one foreground executable. Ignored apps and one-poll title changes do not become a game.
/// A brief switch to a browser does not reset a game that already stayed in front.
pub fn learn_unknown_foreground(
    catalog_focused: bool,
    watch: &mut Option<UnknownWatch>,
    pid: u32,
    process: &str,
    title: &str,
) -> Option<UnknownSighting> {
    if catalog_focused || pid == 0 {
        return None;
    }
    note_unknown_poll(watch, pid, process, title)
}

fn note_unknown_poll(watch: &mut Option<UnknownWatch>, pid: u32, process: &str, title: &str) -> Option<UnknownSighting> {
    let process = normalize_process_name(process);
    if process.is_empty() || is_ignored_process(&process) {
        return None;
    }
    let Some(title) = clean_window_title(title) else {
        return None;
    };
    if title_is_executable(&title, &process) {
        return None;
    }

    let mut next = match watch.take() {
        Some(existing) if existing.process == process && existing.pid == pid => existing,
        _ => UnknownWatch {
            pid,
            process: process.clone(),
            title: title.clone(),
            polls: 0,
            accepted: false,
            pending_title: None,
            pending_polls: 0,
        },
    };

    let mut just_learned = false;
    if next.title == title {
        next.pending_title = None;
        next.pending_polls = 0;
        if !next.accepted {
            next.polls = next.polls.saturating_add(1);
            if next.polls >= UNKNOWN_STABLE_POLLS {
                next.accepted = true;
                just_learned = true;
            }
        }
    } else if next.accepted {
        if next.pending_title.as_deref() == Some(title.as_str()) {
            next.pending_polls = next.pending_polls.saturating_add(1);
        } else {
            next.pending_title = Some(title.clone());
            next.pending_polls = 1;
        }
        if next.pending_polls >= UNKNOWN_STABLE_POLLS {
            next.title = title;
            next.pending_title = None;
            next.pending_polls = 0;
            just_learned = true;
        }
    } else {
        next.title = title;
        next.polls = 1;
        next.accepted = false;
        next.pending_title = None;
        next.pending_polls = 0;
    }

    let sighting = next.accepted.then(|| UnknownSighting {
        process: next.process.clone(),
        title: next.title.clone(),
        pid: next.pid,
        just_learned,
    });
    *watch = Some(next);
    sighting
}

pub fn snapshot_from_sighting(sighting: &UnknownSighting) -> DetectedGameSnapshot {
    DetectedGameSnapshot {
        slug: None,
        name: Some(sighting.title.clone()),
        publisher: None,
        process_name: Some(sighting.process.clone()),
        pid: Some(sighting.pid),
        focused: true,
        running: Vec::new(),
    }
}

pub fn observation_install_hash(install_id: &str, process_name: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(install_id.as_bytes());
    hasher.update([0xff]);
    hasher.update(normalize_process_name(process_name).as_bytes());
    hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn install_id(conn: &Connection) -> AppResult<String> {
    if let Ok(existing) = conn.query_row(
        "select install_id from install_identity where id = 1",
        [],
        |row| row.get::<_, String>(0),
    ) {
        if !existing.is_empty() {
            return Ok(existing);
        }
    }
    let created = new_install_id();
    conn.execute(
        "insert into install_identity (id, install_id) values (1, ?1) on conflict(id) do nothing",
        [&created],
    )?;
    let stored: String = conn.query_row("select install_id from install_identity where id = 1", [], |row| row.get(0))?;
    Ok(stored)
}

pub fn hash_for_process(conn: &Connection, process_name: &str) -> AppResult<String> {
    let normalized = normalize_process_name(process_name);
    if !is_reportable_process(&normalized) {
        return Err(AppError::Message("Process name is not a Windows executable.".into()));
    }
    let id = install_id(conn)?;
    Ok(observation_install_hash(&id, &normalized))
}

pub fn remember_learned_game(conn: &Connection, process_name: &str, title: &str) -> AppResult<()> {
    let process_name = normalize_process_name(process_name);
    let Some(title) = clean_window_title(title) else {
        return Ok(());
    };
    if !is_reportable_process(&process_name) || is_ignored_process(&process_name) || title_is_executable(&title, &process_name) {
        return Ok(());
    }
    conn.execute(
        "insert into learned_games (process_name, window_title, last_seen_at)
         values (?1, ?2, datetime('now'))
         on conflict(process_name) do update set
           window_title = excluded.window_title,
           last_seen_at = excluded.last_seen_at",
        rusqlite::params![process_name, title],
    )?;
    Ok(())
}

fn is_reportable_process(process_name: &str) -> bool {
    let bytes = process_name.as_bytes();
    if bytes.len() < 5 || bytes.len() > 80 || !process_name.ends_with(".exe") {
        return false;
    }
    bytes.iter().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'+' | b'-'))
}

fn new_install_id() -> String {
    let mut bytes = [0u8; 16];
    fill_random(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(windows)]
fn fill_random(bytes: &mut [u8]) {
    use windows::Win32::Security::Cryptography::{BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG};
    if unsafe { BCryptGenRandom(None, bytes, BCRYPT_USE_SYSTEM_PREFERRED_RNG) }.is_err() {
        fallback_random(bytes);
    }
}

#[cfg(not(windows))]
fn fill_random(bytes: &mut [u8]) {
    fallback_random(bytes);
}

fn fallback_random(bytes: &mut [u8]) {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let mut state = nanos ^ ((std::process::id() as u128) << 32);
    for (index, byte) in bytes.iter_mut().enumerate() {
        state = state.wrapping_mul(0x6a09_e667_f3bc_c909).wrapping_add(index as u128 + 1);
        *byte = (state >> 11) as u8;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::{migrate, open_path};
    use crate::games::{detect_games, GameRecord, ProcessRef};
    use tempfile::tempdir;

    fn valorant() -> GameRecord {
        GameRecord {
            slug: "valorant".into(),
            cloud_id: None,
            name: "Valorant".into(),
            publisher: Some("Riot Games".into()),
            cover_url: None,
            icon_url: None,
            process_names: vec!["VALORANT-Win64-Shipping.exe".into()],
        }
    }

    #[test]
    fn known_catalog_hit_stays_a_catalog_game() {
        let processes = vec![ProcessRef {
            pid: 20,
            parent_pid: 0,
            name: "VALORANT-Win64-Shipping.exe".into(),
        }];
        let snapshot = detect_games(&processes, Some(20), &[valorant()]);
        assert_eq!(snapshot.slug.as_deref(), Some("valorant"));
        assert!(snapshot.focused);
        let mut watch = None;
        assert!(learn_unknown_foreground(snapshot.focused, &mut watch, 20, "VALORANT-Win64-Shipping.exe", "VALORANT").is_none());
        assert!(watch.is_none());
    }

    #[test]
    fn denylisted_browser_never_becomes_a_game() {
        let mut watch = None;
        for _ in 0..20 {
            assert!(learn_unknown_foreground(false, &mut watch, 4, "chrome.exe", "Hood Warfare").is_none());
        }
        assert!(watch.is_none());
    }

    #[test]
    fn hood_warfare_is_learned_from_its_window_title() {
        let mut watch = None;
        let mut learned = None;
        for poll in 1..=UNKNOWN_STABLE_POLLS {
            learned = learn_unknown_foreground(
                false,
                &mut watch,
                9,
                r"C:\Games\HoodWarfare.exe",
                "  Hood   Warfare  ",
            );
            if poll < UNKNOWN_STABLE_POLLS {
                assert!(learned.is_none());
            }
        }
        let sighting = learned.expect("stable title");
        assert_eq!(sighting.title, "Hood Warfare");
        assert_eq!(sighting.process, "hoodwarfare.exe");
        assert!(sighting.just_learned);
        let snapshot = snapshot_from_sighting(&sighting);
        assert_eq!(snapshot.slug, None);
        assert_eq!(snapshot.name.as_deref(), Some("Hood Warfare"));

        let again = learn_unknown_foreground(false, &mut watch, 9, "hoodwarfare.exe", "Hood Warfare").unwrap();
        assert!(!again.just_learned);
    }

    #[test]
    fn executable_title_and_brief_switch_do_not_rename_the_session() {
        let mut watch = None;
        assert!(learn_unknown_foreground(false, &mut watch, 3, "hoodwarfare.exe", "hoodwarfare.exe").is_none());
        assert!(learn_unknown_foreground(false, &mut watch, 3, "hoodwarfare.exe", "HoodWarfare").is_none());

        for _ in 0..UNKNOWN_STABLE_POLLS {
            learn_unknown_foreground(false, &mut watch, 3, "hoodwarfare.exe", "Hood Warfare");
        }
        for _ in 0..5 {
            assert!(learn_unknown_foreground(false, &mut watch, 8, "chrome.exe", "New Tab").is_none());
        }
        let still = learn_unknown_foreground(false, &mut watch, 3, "hoodwarfare.exe", "Hood Warfare").unwrap();
        assert_eq!(still.title, "Hood Warfare");
        assert!(!still.just_learned);

        let switched = learn_unknown_foreground(false, &mut watch, 11, "othergame.exe", "Other Game");
        assert!(switched.is_none());
    }

    #[test]
    fn install_hash_hides_the_install_id_and_stays_stable() {
        let dir = tempdir().unwrap();
        let conn = open_path(&dir.path().join("db.sqlite")).unwrap();
        migrate(&conn).unwrap();
        let first = hash_for_process(&conn, "HoodWarfare.exe").unwrap();
        let second = hash_for_process(&conn, "hoodwarfare.EXE").unwrap();
        let other = hash_for_process(&conn, "othergame.exe").unwrap();
        assert_eq!(first.len(), 64);
        assert_eq!(first, second);
        assert_ne!(first, other);
        let install = install_id(&conn).unwrap();
        assert!(!first.contains(&install));
        remember_learned_game(&conn, "HoodWarfare.exe", "Hood Warfare").unwrap();
        let title: String = conn
            .query_row("select window_title from learned_games where process_name = 'hoodwarfare.exe'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(title, "Hood Warfare");
    }
}
