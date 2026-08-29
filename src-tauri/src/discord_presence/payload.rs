//! Pure Discord presence mapping. Inspect this file when card text or art is wrong.
//! Does not talk to Discord, capture, or the database.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

const SITE_URL: &str = "https://replayr.tv";
const VISIT_LABEL: &str = "Visit Replayr";
const VIEW_CLIPS_LABEL: &str = "View Clips";
const FALLBACK_ASSET: &str = "replayr_logo";

/// Explicit Discord Developer Portal asset keys. Do not synthesize keys.
const ASSET_REGISTRY: &[(&str, &str)] = &[("gta-v", "gta_v")];

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct PresenceButton {
    pub label: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct PresencePayload {
    pub details: String,
    pub details_url: String,
    pub state: String,
    pub large_image: String,
    pub large_text: String,
    pub small_image: String,
    pub small_text: String,
    pub buttons: Vec<PresenceButton>,
}

impl PresencePayload {
    pub(crate) fn fingerprint(&self) -> u64 {
        let mut hasher = DefaultHasher::new();
        self.hash(&mut hasher);
        hasher.finish()
    }
}

pub(crate) fn large_image_key(slug: Option<&str>, artwork_url: Option<&str>) -> String {
    if let Some(url) = https_artwork(artwork_url) {
        return url;
    }
    slug.and_then(|slug| {
        ASSET_REGISTRY
            .iter()
            .find(|(id, _)| *id == slug)
            .map(|(_, key)| (*key).to_string())
    })
    .unwrap_or_else(|| FALLBACK_ASSET.to_string())
}

fn https_artwork(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim();
    if trimmed.len() > 512 || trimmed.contains('\0') || trimmed.to_ascii_lowercase().contains(".exe") {
        return None;
    }
    if trimmed.starts_with("https://") {
        Some(trimmed.to_string())
    } else {
        None
    }
}

fn normalize_url(value: &str) -> String {
    value.trim().trim_end_matches('/').to_string()
}

pub(crate) fn presence_buttons(profile_url: Option<&str>) -> Vec<PresenceButton> {
    let mut buttons = vec![PresenceButton {
        label: VISIT_LABEL.into(),
        url: SITE_URL.into(),
    }];
    if let Some(clips_url) = distinct_clips_url(profile_url) {
        buttons.push(PresenceButton {
            label: VIEW_CLIPS_LABEL.into(),
            url: clips_url,
        });
    }
    buttons
}

fn distinct_clips_url(profile_url: Option<&str>) -> Option<String> {
    let url = https_artwork(profile_url)?;
    if normalize_url(&url) == normalize_url(SITE_URL) {
        None
    } else {
        Some(url)
    }
}

pub(crate) fn presence_game_name(slug: Option<&str>, catalog_name: Option<&str>) -> Option<String> {
    match slug {
        Some("gta-v") => Some("GTA V".into()),
        Some(_) => {
            let name = catalog_name.unwrap_or("").trim();
            if name.is_empty() {
                None
            } else {
                Some(name.to_string())
            }
        }
        None => None,
    }
}

fn large_image_text(slug: Option<&str>, catalog_name: Option<&str>) -> String {
    if slug == Some("gta-v") {
        return "Grand Theft Auto V".into();
    }
    let name = catalog_name.unwrap_or("").trim();
    if name.is_empty() {
        crate::branding::APP_NAME.to_string()
    } else {
        name.to_string()
    }
}

pub(crate) fn build_payload(
    slug: Option<&str>,
    catalog_name: Option<&str>,
    clipping: bool,
    artwork_url: Option<&str>,
    profile_url: Option<&str>,
) -> PresencePayload {
    let buttons = presence_buttons(profile_url);
    match presence_game_name(slug, catalog_name) {
        None => PresencePayload {
            details: "Ready to capture".into(),
            details_url: SITE_URL.into(),
            state: "Replayr is running".into(),
            large_image: FALLBACK_ASSET.into(),
            large_text: crate::branding::APP_NAME.into(),
            small_image: FALLBACK_ASSET.into(),
            small_text: crate::branding::APP_NAME.into(),
            buttons,
        },
        Some(name) => PresencePayload {
            details: if clipping {
                format!("Clipping {name}")
            } else {
                name
            },
            details_url: SITE_URL.into(),
            state: "with Replayr".into(),
            large_image: large_image_key(slug, artwork_url),
            large_text: large_image_text(slug, catalog_name),
            small_image: FALLBACK_ASSET.into(),
            small_text: crate::branding::APP_NAME.into(),
            buttons,
        },
    }
}

pub(crate) fn set_idle() -> PresencePayload {
    build_payload(None, None, false, None, None)
}

pub(crate) fn set_game_presence(
    game_name: Option<&str>,
    game_id: Option<&str>,
    clipping_active: bool,
    artwork_url: Option<&str>,
    profile_url: Option<&str>,
) -> PresencePayload {
    build_payload(game_id, game_name, clipping_active, artwork_url, profile_url)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_no_process_name(payload: &PresencePayload) {
        let mut blob = format!(
            "{} {} {} {} {}",
            payload.details, payload.details_url, payload.state, payload.large_text, payload.small_text
        );
        for button in &payload.buttons {
            blob.push_str(&button.label);
            blob.push_str(&button.url);
        }
        if payload.large_image.to_ascii_lowercase().contains(".exe") {
            panic!("presence leaked a process name in artwork: {}", payload.large_image);
        }
        assert!(
            !blob.to_ascii_lowercase().contains(".exe"),
            "presence leaked a process name: {blob}"
        );
        assert!(
            !blob.contains("FiveM"),
            "presence leaked FiveM process branding: {blob}"
        );
        assert!(
            !blob.contains("GTAProcess"),
            "presence leaked a GTA process name: {blob}"
        );
    }

    fn assert_visit_replayr(payload: &PresencePayload) {
        assert_eq!(payload.details_url, "https://replayr.tv");
        assert_eq!(payload.buttons.len(), 1);
        assert_eq!(payload.buttons[0].label, "Visit Replayr");
        assert_eq!(payload.buttons[0].url, "https://replayr.tv");
        assert_eq!(payload.small_image, "replayr_logo");
        assert_eq!(payload.small_text, "Replayr");
    }

    #[test]
    fn idle_payload_when_no_game() {
        let payload = build_payload(None, None, false, None, None);
        assert_eq!(payload.details, "Ready to capture");
        assert_eq!(payload.state, "Replayr is running");
        assert_eq!(payload.large_image, "replayr_logo");
        assert_visit_replayr(&payload);
        assert_no_process_name(&payload);
    }

    #[test]
    fn gta_v_without_clipping() {
        let payload = build_payload(Some("gta-v"), Some("Grand Theft Auto V"), false, None, None);
        assert_eq!(payload.details, "GTA V");
        assert_eq!(payload.state, "with Replayr");
        assert_eq!(payload.large_image, "gta_v");
        assert_eq!(payload.large_text, "Grand Theft Auto V");
        assert_visit_replayr(&payload);
        assert_no_process_name(&payload);
    }

    #[test]
    fn gta_v_with_clipping() {
        let payload = build_payload(Some("gta-v"), Some("Grand Theft Auto V"), true, None, None);
        assert_eq!(payload.details, "Clipping GTA V");
        assert_eq!(payload.state, "with Replayr");
        assert_eq!(payload.large_image, "gta_v");
        assert_visit_replayr(&payload);
        assert_no_process_name(&payload);
    }

    #[test]
    fn fivem_always_surfaces_as_gta_v() {
        let payload = build_payload(Some("gta-v"), Some("Grand Theft Auto V"), true, None, None);
        assert_eq!(payload.details, "Clipping GTA V");
        assert_eq!(presence_game_name(Some("gta-v"), Some("FiveM")).as_deref(), Some("GTA V"));
        assert_no_process_name(&payload);
        let leaked = build_payload(Some("gta-v"), Some("FiveM_b3258_GTAProcess.exe"), true, None, None);
        assert_eq!(leaked.details, "Clipping GTA V");
        assert_eq!(leaked.large_text, "Grand Theft Auto V");
        assert_no_process_name(&leaked);
    }

    #[test]
    fn unknown_game_uses_catalog_name_and_fallback_asset() {
        let payload = build_payload(Some("fortnite"), Some("Fortnite"), true, None, None);
        assert_eq!(payload.details, "Clipping Fortnite");
        assert_eq!(payload.state, "with Replayr");
        assert_eq!(payload.large_image, "replayr_logo");
        assert_eq!(large_image_key(Some("valorant"), None), "replayr_logo");
        assert_visit_replayr(&payload);
        assert_no_process_name(&payload);
    }

    #[test]
    fn https_cover_art_wins_over_registry_key() {
        let art = "https://cdn.cloudflare.steamstatic.com/steam/apps/271590/header.jpg";
        let payload = build_payload(Some("gta-v"), Some("Grand Theft Auto V"), true, Some(art), None);
        assert_eq!(payload.large_image, art);
        assert_eq!(payload.small_image, "replayr_logo");
        assert_visit_replayr(&payload);
    }

    #[test]
    fn http_or_exe_artwork_is_rejected() {
        assert_eq!(
            large_image_key(Some("gta-v"), Some("http://example.com/cover.jpg")),
            "gta_v"
        );
        assert_eq!(
            large_image_key(Some("gta-v"), Some("https://evil.example/FiveM_b3258_GTAProcess.exe")),
            "gta_v"
        );
    }

    #[test]
    fn same_site_profile_url_does_not_add_second_button() {
        let payload = build_payload(
            Some("gta-v"),
            Some("Grand Theft Auto V"),
            true,
            None,
            Some("https://replayr.tv/"),
        );
        assert_eq!(payload.buttons.len(), 1);
        assert_eq!(payload.buttons[0].label, "Visit Replayr");
    }

    #[test]
    fn distinct_profile_url_adds_view_clips() {
        let payload = build_payload(
            Some("gta-v"),
            Some("Grand Theft Auto V"),
            true,
            None,
            Some("https://replayr.tv/u/alex"),
        );
        assert_eq!(payload.buttons.len(), 2);
        assert_eq!(payload.buttons[0].label, "Visit Replayr");
        assert_eq!(payload.buttons[0].url, "https://replayr.tv");
        assert_eq!(payload.buttons[1].label, "View Clips");
        assert_eq!(payload.buttons[1].url, "https://replayr.tv/u/alex");
    }

    #[test]
    fn identical_payloads_share_fingerprint() {
        let a = build_payload(Some("gta-v"), Some("Grand Theft Auto V"), true, None, None);
        let b = build_payload(Some("gta-v"), Some("Grand Theft Auto V"), true, None, None);
        assert_eq!(a.fingerprint(), b.fingerprint());
        let idle = build_payload(None, None, false, None, None);
        assert_ne!(a.fingerprint(), idle.fingerprint());
    }

    #[test]
    fn build_payload_has_no_process_name_argument() {
        let payload = build_payload(Some("gta-v"), Some("Grand Theft Auto V"), true, None, None);
        assert!(!payload.details.contains("FiveM_b3258_GTAProcess.exe"));
    }

    #[test]
    fn fivem_process_detection_never_leaks_into_presence() {
        let catalog = [crate::games::GameRecord {
            slug: "gta-v".into(),
            cloud_id: None,
            name: "Grand Theft Auto V".into(),
            publisher: Some("Rockstar Games".into()),
            cover_url: Some("https://cdn.cloudflare.steamstatic.com/steam/apps/271590/header.jpg".into()),
            icon_url: None,
            process_names: vec!["*GTAProcess.exe".into()],
        }];
        let snapshot = crate::games::detect_games(
            &[crate::games::ProcessRef {
                pid: 42,
                parent_pid: 1,
                name: "FiveM_b3258_GTAProcess.exe".into(),
            }],
            Some(42),
            &catalog,
        );
        assert_eq!(snapshot.slug.as_deref(), Some("gta-v"));
        assert_eq!(
            snapshot.process_name.as_deref(),
            Some("FiveM_b3258_GTAProcess.exe")
        );
        let payload = build_payload(
            snapshot.slug.as_deref(),
            snapshot.name.as_deref(),
            true,
            catalog[0].cover_url.as_deref(),
            None,
        );
        assert_eq!(payload.details, "Clipping GTA V");
        assert_eq!(
            payload.large_image,
            "https://cdn.cloudflare.steamstatic.com/steam/apps/271590/header.jpg"
        );
        assert_visit_replayr(&payload);
        assert_no_process_name(&payload);
        let blob = format!(
            "{} {} {} {}",
            payload.details, payload.state, payload.large_text, payload.small_text
        );
        assert!(!blob.contains(snapshot.process_name.as_deref().unwrap()));
    }
}
