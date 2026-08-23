use crate::games::{
    normalize_process_name, process_name_matches, DetectedGameSnapshot, GameRecord, ProcessRef,
};
use crate::settings::{ExtraAudioApp, MAX_EXTRA_ISOLATED_APPS};

pub const PROCESS_LOOPBACK_MIN_BUILD: u32 = 19041;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CatalogApp {
    pub id: &'static str,
    pub display_name: &'static str,
    pub process_names: &'static [&'static str],
}

pub const DISCORD: CatalogApp = CatalogApp {
    id: "discord",
    display_name: "Discord",
    process_names: &[
        "Discord.exe",
        "DiscordPTB.exe",
        "DiscordCanary.exe",
        "DiscordDevelopment.exe",
    ],
};

pub const SPOTIFY: CatalogApp = CatalogApp {
    id: "spotify",
    display_name: "Spotify",
    process_names: &["Spotify.exe"],
};

pub const CHROME: CatalogApp = CatalogApp {
    id: "chrome",
    display_name: "Chrome",
    process_names: &["chrome.exe"],
};

pub const EDGE: CatalogApp = CatalogApp {
    id: "edge",
    display_name: "Edge",
    process_names: &["msedge.exe"],
};

pub const FIREFOX: CatalogApp = CatalogApp {
    id: "firefox",
    display_name: "Firefox",
    process_names: &["firefox.exe"],
};

pub const CATALOG_APPS: &[CatalogApp] = &[DISCORD, SPOTIFY, CHROME, EDGE, FIREFOX];
pub const DETECTED_EXTRAS: &[CatalogApp] = &[CHROME, SPOTIFY, EDGE, FIREFOX];

const LAUNCHER_NAMES: &[&str] = &[
    "steam.exe",
    "steamwebhelper.exe",
    "epicgameslauncher.exe",
    "epicwebhelper.exe",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GamePidSet {
    pub primary: Option<u32>,
    pub include_pids: Vec<u32>,
}

impl GamePidSet {
    pub fn empty() -> Self {
        Self {
            primary: None,
            include_pids: Vec::new(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.include_pids.is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AudioSessionRef {
    pub pid: u32,
    pub exe: String,
    pub display_name: String,
}

pub fn process_loopback_supported(build: u32) -> bool {
    build >= PROCESS_LOOPBACK_MIN_BUILD
}

pub fn extra_isolated_count(discord_enabled: bool, extra_apps: &[ExtraAudioApp]) -> usize {
    extra_apps.len() + usize::from(discord_enabled)
}

pub fn can_add_extra_app(discord_enabled: bool, extra_apps: &[ExtraAudioApp]) -> Result<(), String> {
    if extra_isolated_count(discord_enabled, extra_apps) >= MAX_EXTRA_ISOLATED_APPS {
        return Err(format!(
            "You can isolate up to {MAX_EXTRA_ISOLATED_APPS} apps besides the game. Discord counts as one."
        ));
    }
    Ok(())
}

pub fn can_enable_discord(extra_apps: &[ExtraAudioApp]) -> Result<(), String> {
    if extra_isolated_count(true, extra_apps) > MAX_EXTRA_ISOLATED_APPS {
        return Err(format!(
            "You can isolate up to {MAX_EXTRA_ISOLATED_APPS} apps besides the game. Discord counts as one."
        ));
    }
    Ok(())
}

pub fn is_replayr_process(process: &ProcessRef, self_pid: u32) -> bool {
    if process.pid == self_pid {
        return true;
    }
    let name = normalize_process_name(&process.name);
    name == "replay.exe"
        || name == "replayr.exe"
        || name == "msedgewebview2.exe"
        || name.contains("webview2")
}

pub fn catalog_matches(app: &CatalogApp, process_name: &str) -> bool {
    app.process_names
        .iter()
        .any(|pattern| process_name_matches(pattern, process_name))
}

pub fn descendant_pids(primary: u32, processes: &[ProcessRef]) -> Vec<u32> {
    let mut tree = vec![primary];
    let mut changed = true;
    while changed {
        changed = false;
        for process in processes {
            if process.pid == 0 || tree.contains(&process.pid) {
                continue;
            }
            if tree.contains(&process.parent_pid) {
                tree.push(process.pid);
                changed = true;
            }
        }
    }
    tree
}

pub fn resolve_game_pids(
    snapshot: &DetectedGameSnapshot,
    processes: &[ProcessRef],
    catalog: &[GameRecord],
    self_pid: u32,
) -> GamePidSet {
    let Some(slug) = snapshot.slug.as_deref() else {
        return GamePidSet::empty();
    };
    let Some(primary) = snapshot.pid.filter(|pid| *pid != 0) else {
        return GamePidSet::empty();
    };
    let Some(game) = catalog.iter().find(|item| item.slug == slug) else {
        if is_excluded_pid(primary, processes, self_pid) {
            return GamePidSet::empty();
        }
        return GamePidSet {
            primary: Some(primary),
            include_pids: vec![primary],
        };
    };

    let matching: Vec<u32> = processes
        .iter()
        .filter(|process| {
            !is_replayr_process(process, self_pid)
                && game
                    .process_names
                    .iter()
                    .any(|pattern| process_name_matches(pattern, &process.name))
                && !is_unlisted_launcher(process, &game.process_names)
        })
        .map(|process| process.pid)
        .collect();

    if is_excluded_pid(primary, processes, self_pid) && matching.is_empty() {
        return GamePidSet::empty();
    }

    let tree = descendant_pids(primary, processes)
        .into_iter()
        .filter(|pid| !is_excluded_pid(*pid, processes, self_pid))
        .collect::<Vec<_>>();

    let mut union = matching;
    for pid in &tree {
        if !union.contains(pid) {
            union.push(*pid);
        }
    }
    if !is_excluded_pid(primary, processes, self_pid) && !union.contains(&primary) {
        union.insert(0, primary);
    }

    let mut include_pids = Vec::new();
    if !is_excluded_pid(primary, processes, self_pid) {
        include_pids.push(primary);
    }
    for pid in union {
        if pid == primary || tree.contains(&pid) {
            continue;
        }
        if !include_pids.contains(&pid) {
            include_pids.push(pid);
        }
    }

    GamePidSet {
        primary: include_pids.first().copied(),
        include_pids,
    }
}

pub fn resolve_catalog_pid(
    app: &CatalogApp,
    processes: &[ProcessRef],
    sessions: &[AudioSessionRef],
    self_pid: u32,
) -> Option<u32> {
    let session_pid = sessions
        .iter()
        .filter(|session| catalog_matches(app, &session.exe) || catalog_matches(app, &session.display_name))
        .filter(|session| !is_excluded_pid(session.pid, processes, self_pid))
        .map(|session| session.pid)
        .find(|pid| *pid != 0);
    if let Some(pid) = session_pid {
        return Some(pid);
    }
    processes
        .iter()
        .filter(|process| catalog_matches(app, &process.name) && !is_replayr_process(process, self_pid))
        .map(|process| process.pid)
        .find(|pid| *pid != 0)
}

pub fn resolve_extra_app_pid(
    app: &ExtraAudioApp,
    processes: &[ProcessRef],
    sessions: &[AudioSessionRef],
    self_pid: u32,
) -> Option<u32> {
    let session_pid = sessions
        .iter()
        .filter(|session| {
            process_name_matches(&app.exe, &session.exe) || process_name_matches(&app.exe, &session.display_name)
        })
        .filter(|session| !is_excluded_pid(session.pid, processes, self_pid))
        .map(|session| session.pid)
        .find(|pid| *pid != 0);
    if let Some(pid) = session_pid {
        return Some(pid);
    }
    processes
        .iter()
        .filter(|process| process_name_matches(&app.exe, &process.name) && !is_replayr_process(process, self_pid))
        .map(|process| process.pid)
        .find(|pid| *pid != 0)
}

pub fn catalog_for_exe(exe: &str) -> Option<&'static CatalogApp> {
    CATALOG_APPS
        .iter()
        .find(|app| catalog_matches(app, exe))
}

fn is_unlisted_launcher(process: &ProcessRef, catalog_names: &[String]) -> bool {
    let listed = catalog_names
        .iter()
        .any(|pattern| process_name_matches(pattern, &process.name));
    if listed {
        return false;
    }
    LAUNCHER_NAMES
        .iter()
        .any(|name| process_name_matches(name, &process.name))
}

fn is_excluded_pid(pid: u32, processes: &[ProcessRef], self_pid: u32) -> bool {
    if pid == 0 || pid == self_pid {
        return true;
    }
    processes
        .iter()
        .find(|process| process.pid == pid)
        .map(|process| is_replayr_process(process, self_pid))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn process(pid: u32, parent_pid: u32, name: &str) -> ProcessRef {
        ProcessRef {
            pid,
            parent_pid,
            name: name.into(),
        }
    }

    fn game(slug: &str, names: &[&str]) -> GameRecord {
        GameRecord {
            slug: slug.into(),
            cloud_id: None,
            name: slug.into(),
            publisher: None,
            cover_url: None,
            icon_url: None,
            process_names: names.iter().map(|name| (*name).to_string()).collect(),
        }
    }

    fn snapshot(slug: &str, pid: u32) -> DetectedGameSnapshot {
        DetectedGameSnapshot {
            slug: Some(slug.into()),
            name: Some(slug.into()),
            publisher: None,
            process_name: Some("game.exe".into()),
            pid: Some(pid),
            focused: true,
            running: Vec::new(),
        }
    }

    #[test]
    fn empty_when_no_game() {
        let set = resolve_game_pids(&DetectedGameSnapshot::empty(), &[], &[], 1);
        assert!(set.is_empty());
    }

    #[test]
    fn unions_catalog_matches_and_children() {
        let processes = vec![
            process(10, 1, "game.exe"),
            process(11, 10, "game-helper.exe"),
            process(12, 2, "game.exe"),
            process(40, 1, "steam.exe"),
            process(50, 1, "replay.exe"),
        ];
        let set = resolve_game_pids(
            &snapshot("demo", 10),
            &processes,
            &[game("demo", &["game.exe"])],
            99,
        );
        assert_eq!(set.primary, Some(10));
        assert!(set.include_pids.contains(&10));
        assert!(set.include_pids.contains(&12));
        assert!(!set.include_pids.contains(&11), "child is covered by include-tree on primary");
        assert!(!set.include_pids.contains(&40), "steam is not listed for this slug");
        assert!(!set.include_pids.contains(&50));
    }

    #[test]
    fn extra_client_only_for_pids_outside_primary_tree() {
        let processes = vec![
            process(10, 1, "VALORANT-Win64-Shipping.exe"),
            process(11, 10, "VALORANT-Win64-Shipping.exe"),
            process(20, 5, "VALORANT.exe"),
        ];
        let set = resolve_game_pids(
            &snapshot("valorant", 10),
            &processes,
            &[game(
                "valorant",
                &["VALORANT-Win64-Shipping.exe", "VALORANT.exe"],
            )],
            99,
        );
        assert_eq!(set.include_pids, vec![10, 20]);
    }

    #[test]
    fn excludes_replayr_and_webview() {
        let processes = vec![
            process(8, 1, "replay.exe"),
            process(9, 8, "msedgewebview2.exe"),
            process(10, 1, "game.exe"),
        ];
        assert!(is_replayr_process(&processes[0], 1));
        assert!(is_replayr_process(&processes[1], 1));
        assert!(!is_replayr_process(&processes[2], 1));
        let set = resolve_game_pids(
            &snapshot("demo", 8),
            &processes,
            &[game("demo", &["game.exe"])],
            8,
        );
        assert!(!set.include_pids.contains(&8));
        assert!(set.include_pids.contains(&10));
    }

    #[test]
    fn discord_catalog_matches_builds() {
        assert!(catalog_matches(&DISCORD, "Discord.exe"));
        assert!(catalog_matches(&DISCORD, "discordptb.exe"));
        assert!(catalog_matches(&DISCORD, "DiscordCanary.exe"));
        assert!(catalog_matches(&DISCORD, "DiscordDevelopment.exe"));
        assert!(!catalog_matches(&DISCORD, "chrome.exe"));
    }

    #[test]
    fn prefers_session_owning_pid() {
        let processes = vec![
            process(21, 1, "Discord.exe"),
            process(22, 21, "Discord.exe"),
        ];
        let sessions = vec![AudioSessionRef {
            pid: 22,
            exe: "Discord.exe".into(),
            display_name: "Discord".into(),
        }];
        assert_eq!(
            resolve_catalog_pid(&DISCORD, &processes, &sessions, 1),
            Some(22)
        );
    }

    #[test]
    fn extra_app_cap_refuses_over_four() {
        let extras = vec![
            ExtraAudioApp {
                id: "1".into(),
                exe: "chrome.exe".into(),
                display_name: "Chrome".into(),
                enabled: true,
                gain: 1.0,
            },
            ExtraAudioApp {
                id: "2".into(),
                exe: "spotify.exe".into(),
                display_name: "Spotify".into(),
                enabled: true,
                gain: 1.0,
            },
            ExtraAudioApp {
                id: "3".into(),
                exe: "msedge.exe".into(),
                display_name: "Edge".into(),
                enabled: false,
                gain: 1.0,
            },
        ];
        assert!(can_add_extra_app(true, &extras).is_err());
        assert!(can_add_extra_app(false, &extras).is_ok());
        extras_plus_one_still_ok_without_discord(&extras);
        assert!(can_enable_discord(&extras).is_ok());
        let four = {
            let mut next = extras.clone();
            next.push(ExtraAudioApp {
                id: "4".into(),
                exe: "firefox.exe".into(),
                display_name: "Firefox".into(),
                enabled: true,
                gain: 1.0,
            });
            next
        };
        assert!(can_add_extra_app(false, &four).is_err());
        assert!(can_enable_discord(&four).is_err());
    }

    fn extras_plus_one_still_ok_without_discord(extras: &[ExtraAudioApp]) {
        assert_eq!(extra_isolated_count(false, extras), 3);
    }

    #[test]
    fn serde_defaults_keep_game_on_desktop_legacy() {
        let json = r#"{"closeToTray":true,"launchAtStartup":false,"instantReplayEnabled":true,"replayDurationSeconds":60,"resolution":"native","fps":60,"encoder":"auto","bitrate":"medium","customBitrateKbps":15000,"codec":"h264","microphoneId":"default","audioOutputId":"default","micEnabled":false,"systemAudioEnabled":true,"saveLocation":"","hotkeys":{"saveReplay":"CommandOrControl+F10","toggleRecording":"CommandOrControl+F9","screenshot":"CommandOrControl+F11"},"autoUpload":"all","uploadBandwidthLimit":"unlimited","customBandwidthKbps":10000,"pauseUploadsWhileGaming":true,"minFreeDiskBytes":1,"theme":"dark","onboardingCompleted":true}"#;
        let settings: crate::settings::AppSettings = serde_json::from_str(json).unwrap();
        assert!(settings.game_audio_enabled);
        assert!(!settings.discord_audio_enabled);
        assert!(settings.extra_apps.is_empty());
        assert!(settings.system_audio_enabled);
    }
}
