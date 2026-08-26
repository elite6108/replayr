//! Background renderer/uploader for burned-in watermarked download derivatives.
//!
//! Cloud clips upload clean (`original.mp4`) and stay shareable immediately.
//! For clips whose plan requires a watermark, the Worker keeps downloads in a
//! "preparing" state until this queue renders `watermarked-v{N}.mp4` with the
//! existing Media Foundation pipeline and uploads it next to the original.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use reqwest::blocking::Client;
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

use crate::database::AppState;
use crate::error::{AppError, AppResult};
use crate::upload::{api_error, auth_headers, map_reqwest, put_parts, CompletedPart, PresignedPart};

/// Must match WATERMARK_RENDER_VERSION in worker/src/shared.ts. The Worker is
/// the source of truth (its value arrives with every session/pending payload);
/// this is only the fallback when a payload omits it.
pub const WATERMARK_RENDER_VERSION: i64 = 1;

/// One processing pass at a time; uploads and app start may both trigger it.
static PROCESSING: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WatermarkSession {
    #[serde(default)]
    already_ready: bool,
    #[serde(default)]
    upload_id: Option<String>,
    #[serde(default)]
    parts: Vec<PresignedPart>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StatusResponse {
    #[serde(default)]
    watermark_status: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingResponse {
    #[serde(default)]
    render_version: Option<i64>,
    #[serde(default)]
    clips: Vec<PendingClip>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingClip {
    id: String,
}

#[derive(Debug, Clone)]
struct Job {
    cloud_clip_id: String,
    local_clip_id: String,
    render_version: i64,
    attempts: i64,
}

pub fn enqueue(conn: &Connection, cloud_clip_id: &str, local_clip_id: &str, render_version: i64) -> AppResult<()> {
    conn.execute(
        "INSERT INTO watermark_queue (cloud_clip_id, local_clip_id, render_version, status, attempts, last_error, next_attempt_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'pending', 0, NULL, 0, datetime('now'), datetime('now'))
         ON CONFLICT(cloud_clip_id) DO UPDATE SET
            local_clip_id = excluded.local_clip_id,
            -- A version bump or a finished-then-invalidated job starts over.
            status = CASE
                WHEN watermark_queue.render_version <> excluded.render_version THEN 'pending'
                WHEN watermark_queue.status = 'completed' THEN 'completed'
                ELSE watermark_queue.status
            END,
            attempts = CASE
                WHEN watermark_queue.render_version <> excluded.render_version THEN 0
                ELSE watermark_queue.attempts
            END,
            next_attempt_at = CASE
                WHEN watermark_queue.render_version <> excluded.render_version THEN 0
                ELSE watermark_queue.next_attempt_at
            END,
            render_version = excluded.render_version,
            updated_at = datetime('now')",
        rusqlite::params![cloud_clip_id, local_clip_id, render_version],
    )?;
    Ok(())
}

/// Syncs the queue with the Worker's list of clips that still need a
/// derivative (missing, failed, stuck, legacy, or rendered with a stale
/// version). Enqueues every one whose source file is still on this PC.
pub fn sync_jobs(app: &AppHandle, access_token: &str, api_base: &str) -> AppResult<usize> {
    let api_base = normalized_api_base(api_base)?;
    if access_token.trim().is_empty() {
        return Err(AppError::Message("Sign in before syncing watermark jobs.".into()));
    }
    let client = http_client()?;
    let response = client
        .get(format!("{api_base}/v1/clips/watermark/pending"))
        .headers(auth_headers(access_token)?)
        .send()
        .map_err(map_reqwest)?;
    let status = response.status().as_u16();
    let text = response.text().map_err(map_reqwest)?;
    if !(200..300).contains(&status) {
        return Err(AppError::Message(api_error(status, &text)));
    }
    let pending: PendingResponse = serde_json::from_str(&text)
        .map_err(|err| AppError::Message(format!("Cloud API returned invalid JSON: {err}")))?;
    let render_version = pending.render_version.unwrap_or(WATERMARK_RENDER_VERSION);

    let db = app.state::<AppState>();
    let conn = db.db.lock().map_err(|err| AppError::Message(err.to_string()))?;
    let mut queued = 0usize;
    for clip in pending.clips {
        let local: Option<(String, String)> = conn
            .query_row(
                "SELECT local_id, file_path FROM local_clips WHERE cloud_clip_id = ?1",
                [&clip.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .ok();
        let Some((local_id, file_path)) = local else {
            continue;
        };
        if !Path::new(&file_path).exists() {
            continue;
        }
        enqueue(&conn, &clip.id, &local_id, render_version)?;
        // The Worker says this derivative is still needed, so a locally
        // finished job is stale; jobs actively rendering/uploading are left alone.
        conn.execute(
            "UPDATE watermark_queue
             SET status = 'pending', attempts = 0, next_attempt_at = 0, updated_at = datetime('now')
             WHERE cloud_clip_id = ?1 AND status IN ('completed', 'failed')",
            [&clip.id],
        )?;
        queued += 1;
    }
    Ok(queued)
}

/// Works through every due queue entry: render to a partial temp file, upload
/// the derivative, and mark it ready on the Worker. Returns how many
/// derivatives were completed this pass.
pub fn process_jobs(app: &AppHandle, access_token: &str, api_base: &str) -> AppResult<usize> {
    let api_base = normalized_api_base(api_base)?;
    if access_token.trim().is_empty() {
        return Err(AppError::Message("Sign in before uploading watermarked clips.".into()));
    }
    if PROCESSING.swap(true, Ordering::SeqCst) {
        return Ok(0);
    }
    let result = process_jobs_inner(app, access_token, &api_base);
    PROCESSING.store(false, Ordering::SeqCst);
    result
}

fn process_jobs_inner(app: &AppHandle, access_token: &str, api_base: &str) -> AppResult<usize> {
    reset_stale_jobs(app)?;
    let client = http_client()?;
    let mut completed = 0usize;
    loop {
        let Some(job) = next_due_job(app)? else {
            break;
        };
        match run_job(app, &client, access_token, api_base, &job) {
            Ok(JobOutcome::Completed) => {
                mark_job(app, &job.cloud_clip_id, "completed", None, None)?;
                emit_status(app, &job.cloud_clip_id, "ready", None);
                completed += 1;
            }
            Ok(JobOutcome::Dropped) => {
                remove_job(app, &job.cloud_clip_id)?;
            }
            Err(err) => {
                let message = err.to_string();
                tracing::warn!("watermark job {} failed: {message}", job.cloud_clip_id);
                let _ = report_status(&client, access_token, api_base, &job.cloud_clip_id, "failed", Some(&message));
                let backoff = backoff_seconds(job.attempts + 1);
                mark_job(app, &job.cloud_clip_id, "failed", Some(&message), Some(backoff))?;
                emit_status(app, &job.cloud_clip_id, "failed", Some(&message));
            }
        }
    }
    Ok(completed)
}

enum JobOutcome {
    Completed,
    Dropped,
}

fn run_job(
    app: &AppHandle,
    client: &Client,
    access_token: &str,
    api_base: &str,
    job: &Job,
) -> AppResult<JobOutcome> {
    let clip = {
        let db = app.state::<AppState>();
        let conn = db.db.lock().map_err(|err| AppError::Message(err.to_string()))?;
        crate::library::get(&conn, &job.local_clip_id)
    };
    let Ok(clip) = clip else {
        // The local clip is gone; a reconcile re-adds the job if it comes back.
        return Ok(JobOutcome::Dropped);
    };
    let source = PathBuf::from(&clip.file_path);
    if !source.exists()
        || !source
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .eq_ignore_ascii_case("mp4")
    {
        return Ok(JobOutcome::Dropped);
    }

    mark_job(app, &job.cloud_clip_id, "rendering", None, None)?;
    emit_status(app, &job.cloud_clip_id, "rendering", None);
    match report_status(client, access_token, api_base, &job.cloud_clip_id, "rendering", None) {
        Ok(ReportResult::AlreadyReady) => return Ok(JobOutcome::Completed),
        Ok(ReportResult::ClipGone) => return Ok(JobOutcome::Dropped),
        Ok(ReportResult::Recorded) => {}
        Err(err) => return Err(err),
    }

    let fps = clip.fps.unwrap_or(60).clamp(1, 240) as u32;
    let rendered = render_watermarked(&source, fps, job.render_version)?;
    let file_size = std::fs::metadata(&rendered)?.len();
    if file_size == 0 {
        let _ = std::fs::remove_file(&rendered);
        return Err(AppError::Message("Watermarked render produced an empty file.".into()));
    }

    mark_job(app, &job.cloud_clip_id, "uploading", None, None)?;
    emit_status(app, &job.cloud_clip_id, "uploading", None);
    let session = start_watermark_upload(client, access_token, api_base, &job.cloud_clip_id, file_size)?;
    let session = match session {
        SessionResult::AlreadyReady => {
            let _ = std::fs::remove_file(&rendered);
            return Ok(JobOutcome::Completed);
        }
        SessionResult::ClipGone => {
            let _ = std::fs::remove_file(&rendered);
            return Ok(JobOutcome::Dropped);
        }
        SessionResult::Session(session) => session,
    };

    let outcome = (|| -> AppResult<()> {
        let etags = put_parts(client, &rendered, file_size, &session.parts)?;
        complete_watermark_upload(client, access_token, api_base, &job.cloud_clip_id, &session, &etags)
    })();
    match outcome {
        Ok(()) => {
            let _ = std::fs::remove_file(&rendered);
            Ok(JobOutcome::Completed)
        }
        // Keep the rendered temp so a retry can reuse it instead of
        // re-rendering the same clip.
        Err(err) => Err(err),
    }
}

/// Renders the burned-in derivative to a partial temp file and promotes it to
/// the reusable cache name only after the render fully succeeds. A valid cached
/// render from an earlier (failed-upload) attempt is reused as-is.
#[cfg(windows)]
fn render_watermarked(source: &Path, fps: u32, render_version: i64) -> AppResult<PathBuf> {
    let stem = source.file_stem().and_then(|name| name.to_str()).unwrap_or("clip");
    let dest = source.with_file_name(format!("{stem}.watermark-v{render_version}.mp4"));
    if crate::export::watermark_temp_reusable(source, &dest) {
        tracing::info!("reusing watermarked derivative {}", dest.display());
        return Ok(dest);
    }
    let partial = source.with_file_name(format!(
        "{stem}.watermark-v{render_version}.partial-{}.mp4",
        std::process::id()
    ));
    let result = crate::export::write_watermarked_mp4(source, &partial, fps);
    if let Err(err) = result {
        let _ = std::fs::remove_file(&partial);
        return Err(AppError::Message(err));
    }
    let _ = std::fs::remove_file(&dest);
    std::fs::rename(&partial, &dest).map_err(|err| {
        let _ = std::fs::remove_file(&partial);
        AppError::Message(err.to_string())
    })?;
    Ok(dest)
}

#[cfg(not(windows))]
fn render_watermarked(_source: &Path, _fps: u32, _render_version: i64) -> AppResult<PathBuf> {
    Err(AppError::Message("Watermark rendering requires Windows.".into()))
}

enum ReportResult {
    Recorded,
    AlreadyReady,
    ClipGone,
}

fn report_status(
    client: &Client,
    access_token: &str,
    api_base: &str,
    cloud_clip_id: &str,
    status: &str,
    error: Option<&str>,
) -> AppResult<ReportResult> {
    let response = client
        .post(format!("{api_base}/v1/clips/{cloud_clip_id}/watermark/status"))
        .headers(auth_headers(access_token)?)
        .json(&json!({ "status": status, "error": error }))
        .send()
        .map_err(map_reqwest)?;
    let http_status = response.status().as_u16();
    let text = response.text().map_err(map_reqwest)?;
    if http_status == 404 || http_status == 400 {
        return Ok(ReportResult::ClipGone);
    }
    if !(200..300).contains(&http_status) {
        return Err(AppError::Message(api_error(http_status, &text)));
    }
    let parsed: StatusResponse = serde_json::from_str(&text).unwrap_or(StatusResponse { watermark_status: None });
    if parsed.watermark_status.as_deref() == Some("ready") {
        return Ok(ReportResult::AlreadyReady);
    }
    Ok(ReportResult::Recorded)
}

enum SessionResult {
    Session(WatermarkSession),
    AlreadyReady,
    ClipGone,
}

fn start_watermark_upload(
    client: &Client,
    access_token: &str,
    api_base: &str,
    cloud_clip_id: &str,
    size: u64,
) -> AppResult<SessionResult> {
    let response = client
        .post(format!("{api_base}/v1/clips/{cloud_clip_id}/watermark/uploads"))
        .headers(auth_headers(access_token)?)
        .json(&json!({ "size": size }))
        .send()
        .map_err(map_reqwest)?;
    let http_status = response.status().as_u16();
    let text = response.text().map_err(map_reqwest)?;
    // 404: clip deleted. 400: the clip no longer requires a watermark (or the
    // render is unusable) — retrying the same file cannot fix either.
    if http_status == 404 || http_status == 400 {
        return Ok(SessionResult::ClipGone);
    }
    if !(200..300).contains(&http_status) {
        return Err(AppError::Message(api_error(http_status, &text)));
    }
    let session: WatermarkSession = serde_json::from_str(&text)
        .map_err(|err| AppError::Message(format!("Cloud API returned invalid JSON: {err}")))?;
    if session.already_ready {
        return Ok(SessionResult::AlreadyReady);
    }
    if session.parts.is_empty() {
        return Err(AppError::Message("Cloud API did not return upload URLs.".into()));
    }
    Ok(SessionResult::Session(session))
}

fn complete_watermark_upload(
    client: &Client,
    access_token: &str,
    api_base: &str,
    cloud_clip_id: &str,
    session: &WatermarkSession,
    parts: &[CompletedPart],
) -> AppResult<()> {
    let response = client
        .post(format!("{api_base}/v1/clips/{cloud_clip_id}/watermark/complete"))
        .headers(auth_headers(access_token)?)
        .json(&json!({ "uploadId": session.upload_id, "parts": parts }))
        .send()
        .map_err(map_reqwest)?;
    let http_status = response.status().as_u16();
    let text = response.text().map_err(map_reqwest)?;
    if !(200..300).contains(&http_status) {
        return Err(AppError::Message(api_error(http_status, &text)));
    }
    Ok(())
}

fn next_due_job(app: &AppHandle) -> AppResult<Option<Job>> {
    let db = app.state::<AppState>();
    let conn = db.db.lock().map_err(|err| AppError::Message(err.to_string()))?;
    let job = conn
        .query_row(
            "SELECT cloud_clip_id, local_clip_id, render_version, attempts
             FROM watermark_queue
             WHERE status IN ('pending', 'failed') AND next_attempt_at <= ?1
             ORDER BY created_at ASC
             LIMIT 1",
            [now_secs()],
            |row| {
                Ok(Job {
                    cloud_clip_id: row.get(0)?,
                    local_clip_id: row.get(1)?,
                    render_version: row.get(2)?,
                    attempts: row.get(3)?,
                })
            },
        )
        .ok();
    Ok(job)
}

/// Jobs stuck in rendering/uploading are leftovers from a crashed pass; the
/// PROCESSING guard means none can be legitimately in flight when a pass starts.
fn reset_stale_jobs(app: &AppHandle) -> AppResult<()> {
    let db = app.state::<AppState>();
    let conn = db.db.lock().map_err(|err| AppError::Message(err.to_string()))?;
    conn.execute(
        "UPDATE watermark_queue SET status = 'pending', updated_at = datetime('now')
         WHERE status IN ('rendering', 'uploading')",
        [],
    )?;
    Ok(())
}

fn mark_job(
    app: &AppHandle,
    cloud_clip_id: &str,
    status: &str,
    error: Option<&str>,
    backoff_secs: Option<i64>,
) -> AppResult<()> {
    let db = app.state::<AppState>();
    let conn = db.db.lock().map_err(|err| AppError::Message(err.to_string()))?;
    let bump_attempts = i64::from(status == "failed");
    let next_attempt_at = backoff_secs.map(|secs| now_secs() + secs).unwrap_or(0);
    conn.execute(
        "UPDATE watermark_queue
         SET status = ?2,
             last_error = ?3,
             attempts = attempts + ?4,
             next_attempt_at = ?5,
             updated_at = datetime('now')
         WHERE cloud_clip_id = ?1",
        rusqlite::params![cloud_clip_id, status, error, bump_attempts, next_attempt_at],
    )?;
    Ok(())
}

fn remove_job(app: &AppHandle, cloud_clip_id: &str) -> AppResult<()> {
    let db = app.state::<AppState>();
    let conn = db.db.lock().map_err(|err| AppError::Message(err.to_string()))?;
    conn.execute("DELETE FROM watermark_queue WHERE cloud_clip_id = ?1", [cloud_clip_id])?;
    Ok(())
}

fn emit_status(app: &AppHandle, cloud_clip_id: &str, status: &str, detail: Option<&str>) {
    let _ = app.emit(
        "watermark-upload",
        json!({
            "cloudClipId": cloud_clip_id,
            "status": status,
            "detail": detail,
        }),
    );
}

fn backoff_seconds(attempts: i64) -> i64 {
    let shift = attempts.clamp(1, 6) as u32;
    (60i64 << (shift - 1)).min(3600)
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs() as i64)
        .unwrap_or(0)
}

fn http_client() -> AppResult<Client> {
    Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|err| AppError::Message(err.to_string()))
}

fn normalized_api_base(api_base: &str) -> AppResult<String> {
    let api_base = api_base.trim_end_matches('/');
    if api_base.is_empty() || api_base.contains("replay.example") {
        return Err(AppError::Message(
            "Cloud API URL is not set. Deploy the Worker and set VITE_PUBLIC_APP_URL.".into(),
        ));
    }
    Ok(api_base.to_string())
}
