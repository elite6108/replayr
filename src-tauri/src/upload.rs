use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use reqwest::blocking::Client;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

use crate::database::AppState;
use crate::error::{AppError, AppResult};
use crate::library::{self, LocalClipDto};

const PART_SIZE: usize = 8 * 1024 * 1024;

/// One compose+upload at a time so webcam re-encode cannot run in parallel.
static UPLOAD_GATE: Mutex<()> = Mutex::new(());

/// Temp composed upload file. Removed on drop so failed uploads do not litter disk.
struct UploadComposeGuard(Option<PathBuf>);

impl Drop for UploadComposeGuard {
    fn drop(&mut self) {
        if let Some(path) = self.0.take() {
            let _ = std::fs::remove_file(path);
        }
    }
}

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

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CompletedPart {
    part_number: u32,
    etag: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadResume {
    clip_id: String,
    upload_id: Option<String>,
    file_size: u64,
    composed_path: Option<String>,
    parts: Vec<CompletedPart>,
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

    let _gate = UPLOAD_GATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    let clip = {
        let db = app.state::<AppState>();
        let conn = db
            .db
            .lock()
            .map_err(|err| AppError::Message(err.to_string()))?;
        let clip = library::get(&conn, local_id)?;
        library::set_cloud(&conn, local_id, "preparing", None, None)?;
        clip
    };
    emit(app, local_id, "preparing", Some("Preparing…"));

    let gameplay = PathBuf::from(&clip.file_path);
    let ext = gameplay
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if ext != "mp4" {
        fail(app, local_id, "Only MP4 clips can be uploaded.")?;
        return Err(AppError::Message("Only MP4 clips can be uploaded.".into()));
    }
    if !gameplay.exists() {
        fail(app, local_id, "That file is no longer on disk.")?;
        return Err(AppError::Message("That file is no longer on disk.".into()));
    }

    let prior_resume = {
        let db = app.state::<AppState>();
        let conn = db
            .db
            .lock()
            .map_err(|err| AppError::Message(err.to_string()))?;
        library::load_upload_resume(&conn, local_id)?
            .and_then(|text| serde_json::from_str::<UploadResume>(&text).ok())
    };

    // Burn webcam into the bytes uploaded to cloud so share links, web players,
    // and website downloads all show the camera. Watermark stays player-side.
    if library::valid_webcam_source(&clip).is_some() {
        emit(app, local_id, "preparing", Some("Adding webcam…"));
    }
    let mut compose_ms: Option<u64> = None;
    let (upload_path, mut compose_guard) =
        match prepare_cloud_upload_mp4(app, local_id, &clip, prior_resume.as_ref()) {
            Ok(prepared) => {
                compose_ms = prepared.2;
                (prepared.0, prepared.1)
            }
            Err(err) => {
                fail(app, local_id, &err.to_string())?;
                return Err(err);
            }
        };
    let path = upload_path.as_path();
    let file_size = std::fs::metadata(path)?.len();
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|err| AppError::Message(err.to_string()))?;

    let (session, mut completed) = match try_resume_session(
        &client,
        api_base,
        access_token,
        prior_resume.as_ref(),
        file_size,
    ) {
        Ok(Some(resumed)) => resumed,
        Ok(None) => {
            let (width, height) = composed_upload_size(&clip, compose_guard.0.is_some());
            let session = match start_session(
                &client,
                api_base,
                access_token,
                &clip,
                file_size,
                width,
                height,
            ) {
                Ok(session) => session,
                Err(err) => {
                    fail(app, local_id, &err.to_string())?;
                    return Err(err);
                }
            };
            (session, Vec::new())
        }
        Err(err) => {
            fail(app, local_id, &err.to_string())?;
            return Err(err);
        }
    };

    {
        let db = app.state::<AppState>();
        let conn = db
            .db
            .lock()
            .map_err(|err| AppError::Message(err.to_string()))?;
        library::set_cloud(&conn, local_id, "uploading", Some(&session.clip_id), None)?;
        let resume = UploadResume {
            clip_id: session.clip_id.clone(),
            upload_id: session.upload_id.clone(),
            file_size,
            composed_path: compose_guard.0.as_ref().map(|p| p.display().to_string()),
            parts: completed.clone(),
        };
        if let Ok(text) = serde_json::to_string(&resume) {
            let _ = library::save_upload_resume(&conn, local_id, &text, 0);
        }
    }
    emit_progress(app, local_id, "uploading", None, Some(0), Some(file_size));

    let etags = match put_parts(
        app,
        local_id,
        &client,
        path,
        file_size,
        &session,
        &mut completed,
        compose_guard.0.as_ref().map(|p| p.display().to_string()),
    ) {
        Ok(etags) => etags,
        Err(err) => {
            // Keep composed bytes on disk for resume.
            compose_guard.0 = None;
            fail(app, local_id, &err.to_string())?;
            return Err(err);
        }
    };
    if let (Some(thumb_url), Some(thumb_path)) =
        (session.thumb_url.as_deref(), clip.thumbnail_path.as_deref())
    {
        let _ = put_thumb(&client, thumb_path, thumb_url);
    }

    {
        let db = app.state::<AppState>();
        let conn = db
            .db
            .lock()
            .map_err(|err| AppError::Message(err.to_string()))?;
        library::set_cloud(&conn, local_id, "processing", Some(&session.clip_id), None)?;
    }
    emit(app, local_id, "processing", None);

    match complete_session(
        &client,
        api_base,
        access_token,
        &session,
        &etags,
        compose_ms,
    ) {
        Ok(done) => {
            let db = app.state::<AppState>();
            let conn = db
                .db
                .lock()
                .map_err(|err| AppError::Message(err.to_string()))?;
            let _ = library::clear_upload_resume(&conn, local_id);
            let next =
                library::set_cloud(&conn, local_id, "completed", Some(&session.clip_id), None)?;
            emit(
                app,
                local_id,
                "completed",
                done.share_url.as_deref().or(Some(&done.slug)),
            );
            Ok(next)
        }
        Err(err) => {
            compose_guard.0 = None;
            fail(app, local_id, &err.to_string())?;
            Err(err)
        }
    }
}

/// Returns `(path_to_upload, temp_guard)`. When a webcam sidecar exists, burns it
/// into a temp MP4 so cloud playback matches the desktop overlay.
fn prepare_cloud_upload_mp4(
    app: &AppHandle,
    local_id: &str,
    clip: &LocalClipDto,
    resume: Option<&UploadResume>,
) -> AppResult<(PathBuf, UploadComposeGuard, Option<u64>)> {
    let gameplay = PathBuf::from(&clip.file_path);
    if let Some(resume) = resume {
        if let Some(composed) = resume.composed_path.as_deref() {
            let path = PathBuf::from(composed);
            if path.exists() {
                if let Ok(meta) = std::fs::metadata(&path) {
                    if meta.len() == resume.file_size && meta.len() > 0 {
                        // Rewriting bytes would invalidate already-uploaded parts.
                        if resume.parts.is_empty() {
                            finalize_composed_upload(&path)?;
                        }
                        return Ok((path.clone(), UploadComposeGuard(Some(path)), None));
                    }
                }
            }
        }
    }
    #[cfg(windows)]
    {
        if let Some(webcam) = library::valid_webcam_source(clip) {
            let layout = crate::overlay::OverlayLayout::from_json(webcam.layout_json.as_deref());
            let stem = gameplay
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("clip");
            // Stable name so a crash mid-upload can resume without recompose.
            let output = gameplay.with_file_name(format!("{stem}.upload-composed.mp4"));
            let fps = clip.fps.unwrap_or(60).clamp(24, 60) as u32;
            let duration_hns = clip.duration_ms.unwrap_or(0).saturating_mul(10_000);
            tracing::info!(
                gameplay = %gameplay.display(),
                webcam = %webcam.file_path,
                "composing webcam into cloud upload"
            );
            let timeout = compose_timeout(clip.duration_ms);
            let started = std::time::Instant::now();
            let progress = {
                let app = app.clone();
                let local_id = local_id.to_string();
                std::sync::Arc::new(move |done: u32, total: u32| {
                    emit_progress(
                        &app,
                        &local_id,
                        "preparing",
                        Some("Adding webcam…"),
                        Some(u64::from(done)),
                        Some(u64::from(total)),
                    );
                })
            };
            match crate::export::compose_webcam_mp4_timed(
                &gameplay,
                Path::new(&webcam.file_path),
                &output,
                &layout,
                0,
                duration_hns,
                fps,
                false,
                timeout,
                crate::export::WebcamComposeOpts::cloud(Some(progress)),
            ) {
                Ok(_) => {
                    let compose_ms = started.elapsed().as_millis() as u64;
                    tracing::info!(
                        path = %output.display(),
                        compose_ms,
                        "composed webcam into cloud upload"
                    );
                    finalize_composed_upload(&output)?;
                    return Ok((
                        output.clone(),
                        UploadComposeGuard(Some(output)),
                        Some(compose_ms),
                    ));
                }
                Err(err) => {
                    // Leave `output` alone — a timed-out compose thread may still
                    // be writing it. Upload gameplay so the clip is not stuck.
                    tracing::warn!(
                        %err,
                        gameplay = %gameplay.display(),
                        "webcam compose failed; uploading gameplay only"
                    );
                }
            }
        }
    }
    let _ = (app, local_id);
    Ok((gameplay, UploadComposeGuard(None), None))
}

/// Copy-remux the GPU compose through a standards-compliant ISO-BMFF writer.
/// Does not re-encode. The original compose file is replaced only after
/// verification succeeds; on failure it is left untouched.
fn finalize_composed_upload(path: &Path) -> AppResult<()> {
    match crate::export::remux_composed_mp4_in_place(path) {
        Ok(stats) => {
            tracing::info!(
                path = %path.display(),
                video_samples = stats.video_samples,
                audio_samples = stats.audio_samples,
                remux_ms = stats.elapsed_ms,
                "copy-remuxed composed MP4 for iOS streaming"
            );
            Ok(())
        }
        Err(err) => {
            tracing::error!(
                path = %path.display(),
                %err,
                "ISO-BMFF remux failed; original compose file was kept"
            );
            Err(AppError::Message(format!(
                "Could not remux the composed clip for iOS streaming. The original file was kept. {err}"
            )))
        }
    }
}

fn composed_upload_size(clip: &LocalClipDto, composed: bool) -> (Option<i64>, Option<i64>) {
    #[cfg(windows)]
    if composed {
        if let (Some(width), Some(height)) = (clip.width, clip.height) {
            if width > 0 && height > 0 {
                let (fit_w, fit_h) = crate::export::fit_compose_size(
                    width as u32,
                    height as u32,
                    crate::export::CLOUD_COMPOSE_MAX_WIDTH,
                    crate::export::CLOUD_COMPOSE_MAX_HEIGHT,
                );
                return (Some(i64::from(fit_w)), Some(i64::from(fit_h)));
            }
        }
    }
    #[cfg(not(windows))]
    let _ = composed;
    (clip.width, clip.height)
}

fn try_resume_session(
    client: &Client,
    api_base: &str,
    access_token: &str,
    resume: Option<&UploadResume>,
    file_size: u64,
) -> AppResult<Option<(UploadSession, Vec<CompletedPart>)>> {
    let Some(resume) = resume else {
        return Ok(None);
    };
    if resume.file_size != file_size || resume.clip_id.is_empty() {
        return Ok(None);
    }
    let done_numbers: Vec<u32> = resume.parts.iter().map(|part| part.part_number).collect();
    let total_parts = if file_size > PART_SIZE as u64 {
        ((file_size + PART_SIZE as u64 - 1) / PART_SIZE as u64) as u32
    } else {
        1
    };
    let remaining: Vec<u32> = (1..=total_parts)
        .filter(|n| !done_numbers.contains(n))
        .collect();
    if remaining.is_empty() && !resume.parts.is_empty() {
        return Ok(Some((
            UploadSession {
                clip_id: resume.clip_id.clone(),
                slug: String::new(),
                upload_id: resume.upload_id.clone(),
                thumb_url: None,
                parts: Vec::new(),
            },
            resume.parts.clone(),
        )));
    }
    match continue_session(
        client,
        api_base,
        access_token,
        &resume.clip_id,
        resume.upload_id.as_deref(),
        &remaining,
    ) {
        Ok(session) => Ok(Some((session, resume.parts.clone()))),
        Err(err) => {
            tracing::warn!(error = %err, "upload resume rejected; starting a new session");
            Ok(None)
        }
    }
}

fn continue_session(
    client: &Client,
    api_base: &str,
    access_token: &str,
    clip_id: &str,
    upload_id: Option<&str>,
    part_numbers: &[u32],
) -> AppResult<UploadSession> {
    let mut headers = auth_headers(access_token)?;
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    let response = client
        .post(format!("{api_base}/v1/clips/{clip_id}/upload-parts"))
        .headers(headers)
        .json(&json!({
            "uploadId": upload_id,
            "partNumbers": part_numbers,
        }))
        .send()
        .map_err(map_reqwest)?;
    parse_json(response)
}

fn compose_timeout(duration_ms: Option<i64>) -> std::time::Duration {
    let secs = duration_ms
        .unwrap_or(30_000)
        .max(15_000)
        .saturating_mul(6)
        .saturating_div(1000)
        .clamp(180, 900) as u64;
    std::time::Duration::from_secs(secs)
}

fn start_session(
    client: &Client,
    api_base: &str,
    access_token: &str,
    clip: &LocalClipDto,
    file_size: u64,
    width: Option<i64>,
    height: Option<i64>,
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
            "width": width,
            "height": height,
            "fps": clip.fps,
            "title": clip.title,
            "gameSlug": clip.game_id,
        }))
        .send()
        .map_err(map_reqwest)?;
    parse_json(response)
}

fn put_parts(
    app: &AppHandle,
    local_id: &str,
    client: &Client,
    path: &Path,
    file_size: u64,
    session: &UploadSession,
    completed: &mut Vec<CompletedPart>,
    composed_path: Option<String>,
) -> AppResult<Vec<CompletedPart>> {
    if session.parts.is_empty() && completed.is_empty() {
        return Err(AppError::Message(
            "Cloud API did not return upload URLs.".into(),
        ));
    }
    let mut file = File::open(path)?;
    for part in &session.parts {
        if completed
            .iter()
            .any(|done| done.part_number == part.part_number)
        {
            continue;
        }
        let offset = (u64::from(part.part_number.saturating_sub(1))) * PART_SIZE as u64;
        let remaining = file_size.saturating_sub(offset);
        let take = remaining.min(PART_SIZE as u64) as usize;
        let etag =
            put_part_with_retry(client, &part.url, &mut file, offset, take, part.part_number)?;
        completed.push(CompletedPart {
            part_number: part.part_number,
            etag,
        });
        let uploaded = completed
            .iter()
            .map(|done| {
                let start = (u64::from(done.part_number.saturating_sub(1))) * PART_SIZE as u64;
                file_size.saturating_sub(start).min(PART_SIZE as u64)
            })
            .sum::<u64>();
        if let Ok(text) = serde_json::to_string(&UploadResume {
            clip_id: session.clip_id.clone(),
            upload_id: session.upload_id.clone(),
            file_size,
            composed_path: composed_path.clone(),
            parts: completed.clone(),
        }) {
            let db = app.state::<AppState>();
            if let Ok(conn) = db.db.lock() {
                let _ = library::save_upload_resume(&conn, local_id, &text, uploaded);
            };
        }
        emit_progress(
            app,
            local_id,
            "uploading",
            None,
            Some(uploaded),
            Some(file_size),
        );
    }
    completed.sort_by_key(|part| part.part_number);
    Ok(completed.clone())
}

fn put_part_with_retry(
    client: &Client,
    url: &str,
    file: &mut File,
    offset: u64,
    take: usize,
    part_number: u32,
) -> AppResult<String> {
    let mut last_err = String::new();
    for attempt in 0u64..3 {
        if attempt > 0 {
            std::thread::sleep(std::time::Duration::from_millis(250 * attempt));
        }
        let mut buf = vec![0u8; take];
        file.seek(SeekFrom::Start(offset))?;
        file.read_exact(&mut buf)?;
        let response = match client
            .put(url)
            .header(CONTENT_TYPE, "video/mp4")
            .body(buf)
            .send()
        {
            Ok(response) => response,
            Err(err) => {
                last_err = err.to_string();
                continue;
            }
        };
        if response.status().is_server_error() || response.status().as_u16() == 429 {
            last_err = format!("HTTP {}", response.status());
            continue;
        }
        if !response.status().is_success() {
            return Err(AppError::Message(format!(
                "R2 rejected part {part_number}: HTTP {}",
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
                "R2 did not return an ETag for part {part_number}."
            )));
        }
        return Ok(etag);
    }
    Err(AppError::Message(format!(
        "R2 rejected part {part_number} after retries: {last_err}"
    )))
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
    compose_ms: Option<u64>,
) -> AppResult<CompleteResponse> {
    let mut headers = auth_headers(access_token)?;
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    let response = client
        .post(format!("{api_base}/v1/clips/{}/complete", session.clip_id))
        .headers(headers)
        .json(&json!({
            "uploadId": session.upload_id,
            "parts": parts,
            "composeMs": compose_ms,
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
    serde_json::from_str(&text)
        .map_err(|err| AppError::Message(format!("Cloud API returned invalid JSON: {err}")))
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
        return Err(AppError::Message(
            "Sign in before deleting a cloud clip.".into(),
        ));
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
    let conn = db
        .db
        .lock()
        .map_err(|err| AppError::Message(err.to_string()))?;
    library::clear_cloud_link(&conn, clip_id)?;
    let _ = app.emit(
        "cloud-upload",
        json!({ "status": "deleted", "clipId": clip_id }),
    );
    Ok(())
}

pub fn download_url_to_file(
    app: &AppHandle,
    url: &str,
    dest: &str,
    skip_watermark: bool,
    authorization: Option<&str>,
) -> AppResult<()> {
    if !url.starts_with("https://")
        && !url.starts_with("http://127.0.0.1")
        && !url.starts_with("http://localhost")
    {
        return Err(AppError::Message("Download URL is not allowed.".into()));
    }
    if dest.trim().is_empty() {
        return Err(AppError::Message("Choose a download location.".into()));
    }
    crate::paths::assert_export_dest_allowed(app, dest)?;
    let mut headers = reqwest::header::HeaderMap::new();
    // Bunny pull zones return hotlink-block HTML without an allowed Referer.
    headers.insert(
        reqwest::header::REFERER,
        reqwest::header::HeaderValue::from_static("https://www.replayr.tv/"),
    );
    headers.insert(
        reqwest::header::ORIGIN,
        reqwest::header::HeaderValue::from_static("https://www.replayr.tv"),
    );
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .default_headers(headers)
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(map_reqwest)?;
    let mut request = client.get(url);
    if let Some(token) = authorization
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    let response = request.send().map_err(map_reqwest)?;
    if response.status().as_u16() == 202 {
        return Err(AppError::Message(
            "Branded download is still preparing. Try again in a moment.".into(),
        ));
    }
    if !response.status().is_success() {
        return Err(AppError::Message(format!(
            "Could not download clip: HTTP {}",
            response.status()
        )));
    }
    let bytes = response.bytes().map_err(map_reqwest)?;
    // Reject Bunny/CDN hotlink HTML/JSON error pages saved as fake MP4s.
    {
        let prefix = std::str::from_utf8(&bytes[..bytes.len().min(96)]).unwrap_or("");
        let trimmed = prefix.trim_start();
        let looks_like_text = trimmed.starts_with('<') || trimmed.starts_with('{');
        let has_ftyp = bytes.windows(4).take(64).any(|window| window == b"ftyp");
        if looks_like_text || !has_ftyp {
            return Err(AppError::Message(
                "Download did not return a video file. Wait for the branded download to finish and try again."
                    .into(),
            ));
        }
    }
    let dest_path = Path::new(dest);
    if let Some(parent) = dest_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    #[cfg(windows)]
    {
        let watermark = !skip_watermark
            && crate::export::should_watermark_exports(app)
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
            let temp =
                dest_path.with_file_name(format!("{}.replayr-dl-{}.mp4", stem, std::process::id()));
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
    let _ = (app, skip_watermark);

    std::fs::write(dest, bytes)?;
    Ok(())
}

fn fail(app: &AppHandle, local_id: &str, error: &str) -> AppResult<LocalClipDto> {
    emit(app, local_id, "failed", Some(error));
    let db = app.state::<AppState>();
    let conn = db
        .db
        .lock()
        .map_err(|err| AppError::Message(err.to_string()))?;
    library::set_cloud(&conn, local_id, "failed", None, Some(error))
}

fn emit(app: &AppHandle, local_id: &str, status: &str, detail: Option<&str>) {
    emit_progress(app, local_id, status, detail, None, None);
}

fn emit_progress(
    app: &AppHandle,
    local_id: &str,
    status: &str,
    detail: Option<&str>,
    bytes_uploaded: Option<u64>,
    bytes_total: Option<u64>,
) {
    let _ = app.emit(
        "cloud-upload",
        json!({
            "localId": local_id,
            "status": status,
            "detail": detail,
            "phase": status,
            "bytesUploaded": bytes_uploaded,
            "bytesTotal": bytes_total,
        }),
    );
}

fn map_reqwest(err: reqwest::Error) -> AppError {
    AppError::Message(format!("Cloud request failed: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compose_timeout_clamps_between_three_and_fifteen_minutes() {
        assert_eq!(compose_timeout(Some(1_000)).as_secs(), 180);
        assert_eq!(compose_timeout(Some(60_000)).as_secs(), 360);
        assert_eq!(compose_timeout(Some(10_000_000)).as_secs(), 900);
    }

    #[test]
    fn upload_resume_round_trips_json() {
        let resume = UploadResume {
            clip_id: "abc".into(),
            upload_id: Some("up".into()),
            file_size: 16 * 1024 * 1024,
            composed_path: Some("C:\\clips\\a.upload-composed.mp4".into()),
            parts: vec![CompletedPart {
                part_number: 1,
                etag: "etag1".into(),
            }],
        };
        let text = serde_json::to_string(&resume).unwrap();
        let parsed: UploadResume = serde_json::from_str(&text).unwrap();
        assert_eq!(parsed.clip_id, "abc");
        assert_eq!(parsed.parts.len(), 1);
        assert_eq!(parsed.parts[0].etag, "etag1");
    }
}
