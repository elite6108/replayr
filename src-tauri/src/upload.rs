use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use reqwest::blocking::Client;
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderValue};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

use crate::database::AppState;
use crate::error::{AppError, AppResult};
use crate::library::{self, LocalClipDto};

const PART_SIZE: usize = 8 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadSession {
    clip_id: String,
    slug: String,
    upload_id: Option<String>,
    thumb_url: Option<String>,
    parts: Vec<PresignedPart>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PresignedPart {
    part_number: u32,
    url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompletedPart {
    part_number: u32,
    etag: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompleteResponse {
    slug: String,
    share_url: Option<String>,
}

pub fn upload_local_clip(
    app: &AppHandle,
    local_id: &str,
    access_token: &str,
    api_base: &str,
) -> AppResult<LocalClipDto> {
    let api_base = api_base.trim_end_matches('/');
    if api_base.is_empty() || api_base.contains("replay.example") {
        return Err(AppError::Message(
            "Cloud API URL is not set. Deploy the Worker and set VITE_PUBLIC_APP_URL.".into(),
        ));
    }
    if access_token.trim().is_empty() {
        return Err(AppError::Message("Sign in before uploading.".into()));
    }

    let clip = {
        let db = app.state::<AppState>();
        let conn = db.db.lock().map_err(|err| AppError::Message(err.to_string()))?;
        let clip = library::get(&conn, local_id)?;
        library::set_cloud(&conn, local_id, "preparing", None, None)?;
        clip
    };
    emit(app, local_id, "preparing", None);

    let path = Path::new(&clip.file_path);
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if ext != "mp4" {
        fail(app, local_id, "Only MP4 clips can be uploaded.")?;
        return Err(AppError::Message("Only MP4 clips can be uploaded.".into()));
    }
    if !path.exists() {
        fail(app, local_id, "That file is no longer on disk.")?;
        return Err(AppError::Message("That file is no longer on disk.".into()));
    }

    // Clips upload as recorded. The watermark is drawn by the players from the
    // per-clip flag the API stamps at upload time, and burned in only on export.
    let file_size = std::fs::metadata(path)?.len();
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|err| AppError::Message(err.to_string()))?;

    let session = match start_session(&client, api_base, access_token, &clip, file_size) {
        Ok(session) => session,
        Err(err) => {
            fail(app, local_id, &err.to_string())?;
            return Err(err);
        }
    };

    {
        let db = app.state::<AppState>();
        let conn = db.db.lock().map_err(|err| AppError::Message(err.to_string()))?;
        library::set_cloud(&conn, local_id, "uploading", Some(&session.clip_id), None)?;
    }
    emit(app, local_id, "uploading", None);

    let etags = match put_parts(&client, path, file_size, &session.parts) {
        Ok(etags) => etags,
        Err(err) => {
            fail(app, local_id, &err.to_string())?;
            return Err(err);
        }
    };
    if let (Some(thumb_url), Some(thumb_path)) = (session.thumb_url.as_deref(), clip.thumbnail_path.as_deref()) {
        let _ = put_thumb(&client, thumb_path, thumb_url);
    }

    {
        let db = app.state::<AppState>();
        let conn = db.db.lock().map_err(|err| AppError::Message(err.to_string()))?;
        library::set_cloud(&conn, local_id, "processing", Some(&session.clip_id), None)?;
    }
    emit(app, local_id, "processing", None);

    match complete_session(&client, api_base, access_token, &session, &etags) {
        Ok(done) => {
            let db = app.state::<AppState>();
            let conn = db.db.lock().map_err(|err| AppError::Message(err.to_string()))?;
            let next = library::set_cloud(&conn, local_id, "completed", Some(&session.clip_id), None)?;
            emit(app, local_id, "completed", done.share_url.as_deref().or(Some(&done.slug)));
            Ok(next)
        }
        Err(err) => {
            fail(app, local_id, &err.to_string())?;
            Err(err)
        }
    }
}

fn start_session(
    client: &Client,
    api_base: &str,
    access_token: &str,
    clip: &LocalClipDto,
    file_size: u64,
) -> AppResult<UploadSession> {
    let mut headers = auth_headers(access_token)?;
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    let response = client
        .post(format!("{api_base}/v1/clips/uploads"))
        .headers(headers)
        .json(&json!({
            "size": file_size,
            "contentType": "video/mp4",
            "durationMs": clip.duration_ms,
            "width": clip.width,
            "height": clip.height,
            "fps": clip.fps,
            "title": clip.title,
            "gameSlug": clip.game_id,
        }))
        .send()
        .map_err(map_reqwest)?;
    parse_json(response)
}

fn put_parts(
    client: &Client,
    path: &Path,
    file_size: u64,
    parts: &[PresignedPart],
) -> AppResult<Vec<CompletedPart>> {
    if parts.is_empty() {
        return Err(AppError::Message("Cloud API did not return upload URLs.".into()));
    }
    let mut file = File::open(path)?;
    let mut completed = Vec::new();
    let mut offset = 0u64;
    for part in parts {
        let remaining = file_size.saturating_sub(offset);
        let take = remaining.min(PART_SIZE as u64) as usize;
        let mut buf = vec![0u8; take];
        file.seek(SeekFrom::Start(offset))?;
        file.read_exact(&mut buf)?;
        let response = client
            .put(&part.url)
            .header(CONTENT_TYPE, "video/mp4")
            .body(buf)
            .send()
            .map_err(map_reqwest)?;
        if !response.status().is_success() {
            return Err(AppError::Message(format!(
                "R2 rejected part {}: HTTP {}",
                part.part_number,
                response.status()
            )));
        }
        let etag = response
            .headers()
            .get("etag")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .trim_matches('"')
            .to_string();
        if etag.is_empty() {
            return Err(AppError::Message(format!(
                "R2 did not return an ETag for part {}.",
                part.part_number
            )));
        }
        completed.push(CompletedPart {
            part_number: part.part_number,
            etag,
        });
        offset += take as u64;
    }
    Ok(completed)
}

fn put_thumb(client: &Client, path: &str, url: &str) -> AppResult<()> {
    let path = Path::new(path);
    if !path.exists() {
        return Ok(());
    }
    let bytes = std::fs::read(path)?;
    if bytes.is_empty() {
        return Ok(());
    }
    let content_type = "image/bmp";
    let response = client
        .put(url)
        .header(CONTENT_TYPE, content_type)
        .body(bytes)
        .send()
        .map_err(map_reqwest)?;
    if !response.status().is_success() {
        return Err(AppError::Message(format!(
            "R2 rejected thumbnail: HTTP {}",
            response.status()
        )));
    }
    Ok(())
}

fn complete_session(
    client: &Client,
    api_base: &str,
    access_token: &str,
    session: &UploadSession,
    parts: &[CompletedPart],
) -> AppResult<CompleteResponse> {
    let mut headers = auth_headers(access_token)?;
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    let response = client
        .post(format!("{api_base}/v1/clips/{}/complete", session.clip_id))
        .headers(headers)
        .json(&json!({
            "uploadId": session.upload_id,
            "parts": parts,
        }))
        .send()
        .map_err(map_reqwest)?;
    parse_json(response)
}

fn auth_headers(access_token: &str) -> AppResult<HeaderMap> {
    let mut headers = HeaderMap::new();
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {access_token}"))
            .map_err(|err| AppError::Message(err.to_string()))?,
    );
    Ok(headers)
}

fn parse_json<T: for<'de> Deserialize<'de>>(response: reqwest::blocking::Response) -> AppResult<T> {
    let status = response.status();
    let text = response.text().map_err(map_reqwest)?;
    if !status.is_success() {
        return Err(AppError::Message(api_error(status.as_u16(), &text)));
    }
    serde_json::from_str(&text).map_err(|err| AppError::Message(format!("Cloud API returned invalid JSON: {err}")))
}

fn api_error(status: u16, body: &str) -> String {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(body) {
        if let Some(error) = value.get("error").and_then(|item| item.as_str()) {
            return error.to_string();
        }
        if let Some(message) = value.get("message").and_then(|item| item.as_str()) {
            return message.to_string();
        }
    }
    let trimmed = body.trim();
    if trimmed.is_empty() {
        format!("Cloud API error HTTP {status}")
    } else {
        format!("Cloud API error HTTP {status}: {trimmed}")
    }
}

pub fn delete_cloud_clip(
    app: &AppHandle,
    clip_id: &str,
    access_token: &str,
    api_base: &str,
) -> AppResult<()> {
    let api_base = api_base.trim_end_matches('/');
    if api_base.is_empty() || api_base.contains("replay.example") {
        return Err(AppError::Message(
            "Cloud API URL is not set. Deploy the Worker and set VITE_PUBLIC_APP_URL.".into(),
        ));
    }
    if access_token.trim().is_empty() {
        return Err(AppError::Message("Sign in before deleting a cloud clip.".into()));
    }
    if clip_id.trim().is_empty() {
        return Err(AppError::Message("Clip id is required.".into()));
    }

    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(map_reqwest)?;
    let response = client
        .delete(format!("{api_base}/v1/clips/{clip_id}"))
        .headers(auth_headers(access_token)?)
        .send()
        .map_err(map_reqwest)?;
    let status = response.status();
    let text = response.text().map_err(map_reqwest)?;
    if !status.is_success() {
        return Err(AppError::Message(api_error(status.as_u16(), &text)));
    }

    let db = app.state::<AppState>();
    let conn = db.db.lock().map_err(|err| AppError::Message(err.to_string()))?;
    library::clear_cloud_link(&conn, clip_id)?;
    let _ = app.emit("cloud-upload", json!({ "status": "deleted", "clipId": clip_id }));
    Ok(())
}

pub fn download_url_to_file(app: &AppHandle, url: &str, dest: &str) -> AppResult<()> {
    if !url.starts_with("https://") && !url.starts_with("http://127.0.0.1") && !url.starts_with("http://localhost") {
        return Err(AppError::Message("Download URL is not allowed.".into()));
    }
    if dest.trim().is_empty() {
        return Err(AppError::Message("Choose a download location.".into()));
    }
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(map_reqwest)?;
    let response = client.get(url).send().map_err(map_reqwest)?;
    if !response.status().is_success() {
        return Err(AppError::Message(format!(
            "Could not download clip: HTTP {}",
            response.status()
        )));
    }
    let bytes = response.bytes().map_err(map_reqwest)?;
    let dest_path = Path::new(dest);
    if let Some(parent) = dest_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    #[cfg(windows)]
    {
        let watermark = crate::export::should_watermark_exports(app)
            && dest_path
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("")
                .eq_ignore_ascii_case("mp4");
        if watermark {
            let stem = dest_path
                .file_stem()
                .and_then(|name| name.to_str())
                .unwrap_or("clip");
            let temp = dest_path.with_file_name(format!(
                "{}.replayr-dl-{}.mp4",
                stem,
                std::process::id()
            ));
            if let Err(err) = std::fs::write(&temp, &bytes) {
                let _ = std::fs::remove_file(&temp);
                return Err(err.into());
            }
            let result = crate::export::write_watermarked_mp4(&temp, dest_path, 60);
            let _ = std::fs::remove_file(&temp);
            if let Err(err) = result {
                let _ = std::fs::remove_file(dest_path);
                return Err(AppError::Message(err));
            }
            return Ok(());
        }
    }
    #[cfg(not(windows))]
    let _ = app;

    std::fs::write(dest, bytes)?;
    Ok(())
}

fn fail(app: &AppHandle, local_id: &str, error: &str) -> AppResult<LocalClipDto> {
    emit(app, local_id, "failed", Some(error));
    let db = app.state::<AppState>();
    let conn = db.db.lock().map_err(|err| AppError::Message(err.to_string()))?;
    library::set_cloud(&conn, local_id, "failed", None, Some(error))
}

fn emit(app: &AppHandle, local_id: &str, status: &str, detail: Option<&str>) {
    let _ = app.emit(
        "cloud-upload",
        json!({
            "localId": local_id,
            "status": status,
            "detail": detail,
        }),
    );
}

fn map_reqwest(err: reqwest::Error) -> AppError {
    AppError::Message(format!("Cloud request failed: {err}"))
}
