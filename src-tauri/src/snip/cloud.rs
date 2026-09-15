//! Screenshot uploads go through the Worker as a single POST of the PNG body.
//!
//! This client is independent of `upload.rs` / `UPLOAD_GATE`. Clip multipart can sit behind that
//! mutex for minutes; a screenshot has to copy a link in well under a second on a warm connection.

use std::sync::OnceLock;
use std::time::Duration;

use serde::Deserialize;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const TOTAL_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloudError {
    Unauthorized,
    TooLarge,
    Busy,
    RateLimited,
    Invalid,
    Network,
    Server,
}

impl CloudError {
    pub fn message(&self) -> &'static str {
        match self {
            Self::Unauthorized => "Sign in again to upload screenshots.",
            Self::TooLarge => "That screenshot is too large to upload.",
            Self::Busy => "Wait for an in-flight screenshot to finish.",
            Self::RateLimited => "Slow down. Try again in a moment.",
            Self::Invalid => "That file could not be uploaded.",
            Self::Network => "Could not reach Replayr. The image is saved on this PC.",
            Self::Server => "Upload failed. The image is saved on this PC.",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloudOk {
    pub id: String,
    pub slug: String,
    pub share_url: String,
    pub width: u32,
    pub height: u32,
    pub bytes: u64,
    pub replaced_oldest: bool,
    pub evicted_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadBody {
    id: String,
    slug: String,
    share_url: String,
    width: u32,
    height: u32,
    bytes: u64,
    replaced_oldest: bool,
    #[serde(default)]
    evicted_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct ErrorBody {
    code: Option<String>,
    error: Option<String>,
}

static CLIENT: OnceLock<reqwest::blocking::Client> = OnceLock::new();

fn client() -> &'static reqwest::blocking::Client {
    CLIENT.get_or_init(|| {
        reqwest::blocking::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(TOTAL_TIMEOUT)
            .build()
            .expect("screenshot http client")
    })
}

/// https://replayr.tv and https://www.replayr.tv only. Localhost is debug-only so a release build
/// cannot be pointed at an unexpected host even if the UI is compromised.
pub fn api_base_allowed(api_base: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(api_base) else {
        return false;
    };
    let host = url.host_str().unwrap_or("");
    match host {
        "replayr.tv" | "www.replayr.tv" => url.scheme() == "https",
        "127.0.0.1" | "localhost" => cfg!(debug_assertions) && matches!(url.scheme(), "http" | "https"),
        _ => false,
    }
}

pub fn warm(api_base: &str) {
    if !api_base_allowed(api_base) {
        return;
    }
    let url = format!("{}/v1/health", api_base.trim_end_matches('/'));
    let _ = client().get(url).send();
}

const PNG_MAGIC: &[u8] = &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/// Fetch a public screenshot PNG from a Replayr share URL.
pub fn fetch_png(url: &str) -> Result<Vec<u8>, CloudError> {
    if !api_base_allowed(url) {
        return Err(CloudError::Invalid);
    }
    let response = client().get(url).send().map_err(|_| CloudError::Network)?;
    if !response.status().is_success() {
        return Err(CloudError::Server);
    }
    let bytes = response.bytes().map_err(|_| CloudError::Network)?;
    if bytes.len() < PNG_MAGIC.len() || &bytes[..PNG_MAGIC.len()] != PNG_MAGIC {
        return Err(CloudError::Invalid);
    }
    Ok(bytes.to_vec())
}

pub fn upload(api_base: &str, token: &str, png: &[u8]) -> Result<CloudOk, CloudError> {
    if !api_base_allowed(api_base) {
        return Err(CloudError::Invalid);
    }
    let url = format!("{}/v1/screenshots", api_base.trim_end_matches('/'));
    let response = client()
        .post(url)
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "image/png")
        .header("content-length", png.len())
        .body(png.to_vec())
        .send()
        .map_err(|_| CloudError::Network)?;
    let status = response.status().as_u16();
    let text = response.text().unwrap_or_default();
    if (200..300).contains(&status) {
        let body: UploadBody = serde_json::from_str(&text).map_err(|_| CloudError::Server)?;
        return Ok(CloudOk {
            id: body.id,
            slug: body.slug,
            share_url: body.share_url,
            width: body.width,
            height: body.height,
            bytes: body.bytes,
            replaced_oldest: body.replaced_oldest,
            evicted_ids: body.evicted_ids,
        });
    }
    tracing::warn!(status, body = %text.chars().take(300).collect::<String>(), "screenshot upload http error");
    Err(map_error_body(status, &text))
}

pub fn list_ready_ids(api_base: &str, token: &str) -> Result<Vec<String>, CloudError> {
    let mut ids = Vec::new();
    for page in 1..=20u32 {
        let batch = list_ready_page(api_base, token, page)?;
        let count = batch.len();
        ids.extend(batch);
        if count < 48 {
            break;
        }
    }
    Ok(ids)
}

fn list_ready_page(api_base: &str, token: &str, page: u32) -> Result<Vec<String>, CloudError> {
    if !api_base_allowed(api_base) {
        return Err(CloudError::Invalid);
    }
    let url = format!("{}/v1/screenshots?limit=48&page={page}", api_base.trim_end_matches('/'));
    let response = client()
        .get(url)
        .header("authorization", format!("Bearer {token}"))
        .send()
        .map_err(|_| CloudError::Network)?;
    let status = response.status().as_u16();
    let text = response.text().unwrap_or_default();
    if !(200..300).contains(&status) {
        return Err(map_error_body(status, &text));
    }
    #[derive(Deserialize)]
    struct ListBody {
        screenshots: Vec<ListItem>,
    }
    #[derive(Deserialize)]
    struct ListItem {
        id: String,
        status: String,
    }
    let body: ListBody = serde_json::from_str(&text).map_err(|_| CloudError::Server)?;
    Ok(body.screenshots.into_iter().filter(|item| item.status == "ready").map(|item| item.id).collect())
}

fn looks_like_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes[8] == b'-'
        && bytes[13] == b'-'
        && bytes[18] == b'-'
        && bytes[23] == b'-'
        && bytes.iter().enumerate().all(|(index, byte)| matches!(index, 8 | 13 | 18 | 23) || byte.is_ascii_hexdigit())
}

pub fn delete_remote(api_base: &str, token: &str, cloud_id: &str) -> Result<(), CloudError> {
    if !api_base_allowed(api_base) || !looks_like_uuid(cloud_id) {
        return Err(CloudError::Invalid);
    }
    let url = format!("{}/v1/screenshots/{cloud_id}", api_base.trim_end_matches('/'));
    let response = client()
        .delete(url)
        .header("authorization", format!("Bearer {token}"))
        .send()
        .map_err(|_| CloudError::Network)?;
    let status = response.status().as_u16();
    if (200..300).contains(&status) || status == 404 {
        return Ok(());
    }
    Err(map_error_body(status, &response.text().unwrap_or_default()))
}

pub fn map_error_body(status: u16, body: &str) -> CloudError {
    let code = serde_json::from_str::<ErrorBody>(body).ok().and_then(|value| value.code).unwrap_or_default();
    match (status, code.as_str()) {
        (401, _) | (_, "unauthorized") => CloudError::Unauthorized,
        (413, _) | (_, "screenshot_too_large") => CloudError::TooLarge,
        (429, "screenshot_busy") | (_, "screenshot_busy") => CloudError::Busy,
        (429, _) | (_, "rate_limited") => CloudError::RateLimited,
        (415, _) | (_, "screenshot_not_png") => CloudError::Invalid,
        (0, _) => CloudError::Network,
        _ => CloudError::Server,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowlist_accepts_replayr_https_only() {
        assert!(api_base_allowed("https://www.replayr.tv"));
        assert!(api_base_allowed("https://replayr.tv"));
        assert!(!api_base_allowed("http://www.replayr.tv"));
        assert!(!api_base_allowed("https://evil.example"));
    }

    #[test]
    fn localhost_is_debug_only() {
        let local = api_base_allowed("http://127.0.0.1:8787");
        assert_eq!(local, cfg!(debug_assertions));
    }

    #[test]
    fn maps_json_error_codes() {
        assert_eq!(map_error_body(401, r#"{"error":"Sign in required.","code":"unauthorized"}"#), CloudError::Unauthorized);
        assert_eq!(map_error_body(413, r#"{"code":"screenshot_too_large"}"#), CloudError::TooLarge);
        assert_eq!(map_error_body(429, r#"{"code":"screenshot_busy"}"#), CloudError::Busy);
        assert_eq!(map_error_body(429, r#"{"code":"rate_limited"}"#), CloudError::RateLimited);
        assert_eq!(map_error_body(415, r#"{"code":"screenshot_not_png"}"#), CloudError::Invalid);
        assert_eq!(map_error_body(500, "nope"), CloudError::Server);
    }

    #[test]
    fn upload_body_reads_evicted_ids() {
        let body: UploadBody = serde_json::from_str(
            r#"{"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","slug":"abcdefghijk2","shareUrl":"https://replayr.tv/s/abcdefghijk2","width":8,"height":8,"bytes":80,"replacedOldest":true,"evictedIds":["33333333-3333-4333-8333-333333333333"]}"#,
        )
        .unwrap();
        assert!(body.replaced_oldest);
        assert_eq!(body.evicted_ids.len(), 1);
    }
}
