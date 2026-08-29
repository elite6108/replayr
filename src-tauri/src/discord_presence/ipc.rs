//! Discord IPC only. Payload tests never import this module.

use discord_rich_presence::{activity, DiscordIpc, DiscordIpcClient};

use super::payload::PresencePayload;
use super::DISCORD_CLIENT_ID;

pub(crate) fn connect_client() -> Result<DiscordIpcClient, String> {
    let mut client = DiscordIpcClient::new(DISCORD_CLIENT_ID);
    client.connect().map_err(describe_error)?;
    Ok(client)
}

pub(crate) fn write_activity(client: &mut DiscordIpcClient, payload: &PresencePayload) -> Result<(), String> {
    let buttons: Vec<activity::Button<'_>> = payload
        .buttons
        .iter()
        .map(|button| activity::Button::new(button.label.as_str(), button.url.as_str()))
        .collect();
    let mut activity = activity::Activity::new()
        .details(payload.details.as_str())
        .details_url(payload.details_url.as_str())
        .state(payload.state.as_str())
        .assets(
            activity::Assets::new()
                .large_image(payload.large_image.as_str())
                .large_text(payload.large_text.as_str())
                .small_image(payload.small_image.as_str())
                .small_text(payload.small_text.as_str()),
        );
    if !buttons.is_empty() {
        activity = activity.buttons(buttons);
    }
    client.set_activity(activity).map_err(describe_error)
}

pub(crate) fn clear_presence(client: Option<&mut DiscordIpcClient>) {
    let Some(client) = client else {
        return;
    };
    let _ = client.clear_activity();
    let _ = client.close();
}

fn describe_error(err: impl std::fmt::Display) -> String {
    let text = err.to_string();
    let lower = text.to_ascii_lowercase();
    if lower.contains("os error 2")
        || lower.contains("cannot find")
        || lower.contains("no such file")
        || lower.contains("not found")
        || lower.contains("the system cannot find")
    {
        "Discord is not running".into()
    } else {
        text.chars().take(200).collect()
    }
}
