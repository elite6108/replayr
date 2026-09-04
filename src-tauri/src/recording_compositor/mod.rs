//! Session-recording-only GPU compositor. Instant Replay and clips never
//! consume this output.

mod diagnostics;
mod scene;
mod transforms;

#[cfg(windows)]
mod compositor;
#[cfg(windows)]
mod gpu;
#[cfg(windows)]
mod hw_encode;
#[cfg(windows)]
mod nv12;
#[cfg(windows)]
mod sources;
#[cfg(windows)]
mod filters;
#[cfg(windows)]
mod still_blend;
#[cfg(windows)]
mod session_aac;
#[cfg(windows)]
mod preview_tap;

pub use scene::RecordingComposition;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager};

use crate::camera::CameraEngine;
use crate::capture::{RecordingState, RecordingStatus, SavedClipEvent};
use crate::database::AppState;
use crate::error::{AppError, AppResult};
use crate::settings::{self, AppSettings};

pub struct ComposedRecordingState {
    inner: Mutex<Option<ActiveComposed>>,
}

struct ActiveComposed {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<Result<FinishedComposed, String>>>,
    path: std::path::PathBuf,
    started: Instant,
    started_at: String,
    target: String,
    width: u32,
    height: u32,
    fps: u32,
    webcam_layout: Option<crate::overlay::OverlayLayout>,
}

struct FinishedComposed {
    path: std::path::PathBuf,
    duration_ms: u64,
    width: u32,
    height: u32,
    fps: u32,
    frames: u64,
    game_id: Option<String>,
    title: String,
}

impl Default for ComposedRecordingState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }
}

impl ComposedRecordingState {
    pub fn is_active(&self) -> bool {
        self.inner.lock().map(|inner| inner.is_some()).unwrap_or(true)
    }

    pub fn status(&self) -> Option<RecordingStatus> {
        let inner = self.inner.lock().ok()?;
        let session = inner.as_ref()?;
        Some(RecordingStatus {
            active: true,
            path: Some(session.path.display().to_string()),
            target: Some(session.target.clone()),
            started_at: Some(session.started_at.clone()),
            duration_ms: session.started.elapsed().as_millis() as u64,
            error: None,
            composed: true,
        })
    }
}

pub fn start(
    app: &AppHandle,
    rec: &RecordingState,
    composed: &ComposedRecordingState,
    camera: &CameraEngine,
    payload: RecordingComposition,
    webcam_layout: Option<crate::overlay::OverlayLayout>,
) -> AppResult<RecordingStatus> {
    #[cfg(not(windows))]
    {
        let _ = (app, rec, composed, camera, payload, webcam_layout);
        return Err(AppError::Message(
            "Composed recording is only available on Windows.".into(),
        ));
    }
    #[cfg(windows)]
    {
        start_windows(app, rec, composed, camera, payload, webcam_layout)
    }
}

pub fn stop(
    app: &AppHandle,
    rec: &RecordingState,
    composed: &ComposedRecordingState,
    camera: &CameraEngine,
) -> AppResult<RecordingStatus> {
    #[cfg(not(windows))]
    {
        let _ = (app, rec, composed, camera);
        return Err(AppError::Message("Not recording.".into()));
    }
    #[cfg(windows)]
    {
        stop_windows(app, rec, composed, camera)
    }
}

#[cfg(windows)]
fn start_windows(
    app: &AppHandle,
    rec: &RecordingState,
    composed: &ComposedRecordingState,
    camera: &CameraEngine,
    payload: RecordingComposition,
    webcam_layout: Option<crate::overlay::OverlayLayout>,
) -> AppResult<RecordingStatus> {
    let spec = payload.validate().map_err(AppError::Message)?;
    if rec.wgc_session_active() {
        return Err(AppError::Message(
            "Turn off Instant Replay or use Legacy recording. Composed recording cannot share the Instant Replay capture session.".into(),
        ));
    }
    let cam_status = camera.status();
    if cam_status.rolling || cam_status.recording {
        return Err(AppError::Message(
            "Webcam is in use by Instant Replay. Turn off Instant Replay or use Legacy recording.".into(),
        ));
    }
    let mut slot = composed
        .inner
        .lock()
        .map_err(|err| AppError::Message(err.to_string()))?;
    if slot.is_some() {
        return Err(AppError::Message("Composed recording is already running.".into()));
    }

    let settings = load_settings(app)?;
    let save = save_dir(app, &settings)?;
    crate::disk::ensure_free_space(&save, settings.min_free_disk_bytes)?;
    rec.shared.preview.suspend_standalone();
    rec.set_session_webcam_layout(webcam_layout.clone());
    camera.stop_preview();

    let detection = crate::detection::current_snapshot(&app.state::<crate::detection::DetectionState>());
    let pid = detection.pid;
    let game_id = detection.slug.clone();
    let title = detection
        .name
        .clone()
        .unwrap_or_else(|| "Recording".into());
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let slug = game_id.as_deref().unwrap_or("recording");
    let path = output_path(&save, slug, "mp4");
    let bitrate = bitrate_of(&settings);
    let audio_plan = ComposedAudioPlan {
        include: spec.audio.include(),
        mic: spec.audio.microphone.routed(),
        game: spec.audio.game_audio.routed(),
        desktop: spec.audio.desktop_audio.routed(),
    };
    let audio = (*app.state::<crate::audio::AudioRuntime>()).clone();
    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = Arc::clone(&stop);
    let thread_path = path.clone();
    let thread_spec = spec.clone();
    let thread_title = title.clone();
    let thread_game_id = game_id.clone();
    let thread_pid = pid;
    let (ready_tx, ready_rx) = std::sync::mpsc::channel();

    let thread_settings = settings.clone();
    let thread_preview = rec.shared.preview.clone();
    let handle = std::thread::Builder::new()
        .name("composed-record".into())
        .spawn(move || {
            run_composed_session(
                thread_spec,
                thread_path,
                thread_pid,
                thread_game_id,
                thread_title,
                bitrate,
                audio_plan,
                audio,
                thread_settings,
                thread_preview,
                thread_stop,
                ready_tx,
            )
        })
        .map_err(|err| {
            rec.shared.preview.resume_if_wanted();
            AppError::Message(err.to_string())
        })?;

    let started_at = stamp.to_string();
    *slot = Some(ActiveComposed {
        stop: Arc::clone(&stop),
        thread: Some(handle),
        path: path.clone(),
        started: Instant::now(),
        started_at: started_at.clone(),
        target: title.clone(),
        width: 0,
        height: 0,
        fps: spec.fps,
        webcam_layout,
    });
    drop(slot);

    let ready = ready_rx.recv_timeout(Duration::from_secs(20));
    match ready {
        Ok(Ok((width, height))) => {
            let mut slot = composed
                .inner
                .lock()
                .map_err(|err| AppError::Message(err.to_string()))?;
            let Some(session) = slot.as_mut() else {
                // Stop already reaped the session during initialization.
                return Ok(RecordingStatus {
                    composed: true,
                    ..RecordingStatus::default()
                });
            };
            session.width = width;
            session.height = height;
            let status = RecordingStatus {
                active: true,
                path: Some(path.display().to_string()),
                target: Some(title),
                started_at: Some(started_at),
                duration_ms: 0,
                error: None,
                composed: true,
            };
            drop(slot);
            let _ = app.emit("recording-status", &status);
            Ok(status)
        }
        Ok(Err(err)) => {
            reap_composed_slot(composed);
            rec.shared.preview.resume_if_wanted();
            diagnostics::log_fail("start", &err);
            Err(AppError::Message(err))
        }
        Err(_) => {
            stop.store(true, Ordering::SeqCst);
            reap_composed_slot(composed);
            rec.shared.preview.resume_if_wanted();
            let err = "Composed recording did not start in time. Use Legacy recording or try again.".to_string();
            diagnostics::log_fail("start", &err);
            Err(AppError::Message(err))
        }
    }
}

#[cfg(windows)]
fn reap_composed_slot(composed: &ComposedRecordingState) {
    let Ok(mut slot) = composed.inner.lock() else {
        return;
    };
    let Some(mut session) = slot.take() else {
        return;
    };
    session.stop.store(true, Ordering::SeqCst);
    let thread = session.thread.take();
    drop(slot);
    if let Some(handle) = thread {
        let _ = handle.join();
    }
}

#[cfg(windows)]
fn stop_windows(
    app: &AppHandle,
    rec: &RecordingState,
    composed: &ComposedRecordingState,
    _camera: &CameraEngine,
) -> AppResult<RecordingStatus> {
    let mut slot = composed
        .inner
        .lock()
        .map_err(|err| AppError::Message(err.to_string()))?;
    let Some(mut session) = slot.take() else {
        return Ok(RecordingStatus {
            composed: true,
            ..RecordingStatus::default()
        });
    };
    session.stop.store(true, Ordering::SeqCst);
    let thread = session.thread.take();
    drop(slot);
    let finished = match thread {
        Some(handle) => handle.join().unwrap_or_else(|_| Err("Composed recording thread panicked.".into())),
        None => Err("Composed recording was already stopping.".into()),
    };
    rec.shared.preview.resume_if_wanted();
    match finished {
        Ok(done) => {
            let local_id = crate::library::insert(
                app,
                &done.path,
                done.duration_ms,
                done.width,
                done.height,
                done.fps,
                done.game_id,
                done.title.clone(),
                None,
                session.webcam_layout,
            )?;
            let _ = app.emit(
                "local-clip-saved",
                SavedClipEvent {
                    path: done.path.display().to_string(),
                    kind: "recording".into(),
                    local_id,
                },
            );
            let status = RecordingStatus {
                active: false,
                path: Some(done.path.display().to_string()),
                target: Some(done.title),
                started_at: None,
                duration_ms: done.duration_ms,
                error: None,
                composed: true,
            };
            let _ = app.emit("recording-status", &status);
            Ok(status)
        }
        Err(err) => {
            diagnostics::log_fail("stop", &err);
            let status = RecordingStatus {
                active: false,
                path: Some(session.path.display().to_string()),
                target: Some(session.target),
                started_at: None,
                duration_ms: session.started.elapsed().as_millis() as u64,
                error: Some(err.clone()),
                composed: true,
            };
            let _ = app.emit("recording-status", &status);
            Err(AppError::Message(err))
        }
    }
}

#[cfg(windows)]
fn run_composed_session(
    spec: scene::ValidatedComposition,
    path: std::path::PathBuf,
    pid: Option<u32>,
    game_id: Option<String>,
    title: String,
    bitrate: u32,
    audio_plan: ComposedAudioPlan,
    audio: crate::audio::AudioRuntime,
    settings: crate::settings::AppSettings,
    preview: crate::preview::PreviewHub,
    stop: Arc<AtomicBool>,
    ready: std::sync::mpsc::Sender<Result<(u32, u32), String>>,
) -> Result<FinishedComposed, String> {
    use crate::audio_timeline::{frames_from_hns, AUDIO_LEAD_HNS};
    use crate::camera::SessionClock;
    use compositor::{ComposeInput, RecordingCompositor};
    use gpu::SharedGpu;
    use sources::capture::ComposedCapture;
    use sources::webcam::ComposedWebcam;

    diagnostics::log_start(spec.canvas_w, spec.canvas_h, spec.fps, spec.webcam.is_some(), &path.display().to_string());

    let fail_ready = {
        let ready = ready.clone();
        move |err: String| {
            diagnostics::log_fail("start", &err);
            let _ = ready.send(Err(err.clone()));
            err
        }
    };
    let init_started = Instant::now();
    let mut sources = ComposedSourceGuard {
        capture: Some(
            ComposedCapture::start(spec.capture.kind, pid, spec.capture.monitor_id.as_deref())
                .map_err(|err| fail_ready(err))?,
        ),
        webcam: None,
    };
    if let Some(cam) = spec.webcam.as_ref() {
        match ComposedWebcam::start(cam) {
            Ok(session) => sources.webcam = Some(session),
            Err(err) => return Err(fail_ready(err)),
        }
    }

    let first = match wait_first_frame(sources.capture.as_ref().expect("capture"), &stop) {
        Ok(frame) => frame,
        Err(err) => return Err(fail_ready(err)),
    };
    let gpu = match SharedGpu::open() {
        Ok(gpu) => gpu,
        Err(err) => return Err(fail_ready(format!("{err} Use Legacy recording or try again."))),
    };
    let mut compositor = match RecordingCompositor::open(gpu, &spec, &first) {
        Ok(compositor) => compositor,
        Err(err) => return Err(fail_ready(err)),
    };
    if let Err(err) = compositor.load_session_resources(&spec) {
        return Err(fail_ready(err));
    }
    if let Some(hud) = spec.hud.as_ref() {
        if let Err(err) = compositor.refresh_hud(hud, 0) {
            return Err(fail_ready(err));
        }
    }

    let clock = SessionClock::start();
    tracing::info!(
        mic = audio_plan.mic,
        game = audio_plan.game,
        desktop = audio_plan.desktop,
        include = audio_plan.include,
        "composed_audio"
    );
    audio.apply_composed_mix_routing(audio_plan.mic, audio_plan.game, audio_plan.desktop);
    let mut audio_guard = AudioSessionGuard {
        audio: Some(audio.clone()),
        desktop: false,
        restore: Some(settings),
    };
    if audio_plan.include {
        audio.begin_session(clock.qpc_origin_hns());
        if audio_plan.desktop {
            audio_guard.desktop = audio.begin_composed_desktop();
            if !audio_guard.desktop {
                tracing::warn!("composed desktop recording loopback did not start");
            }
        }
    }

    let mut preview_tap = match preview_tap::ActiveComposedPreview::open(&compositor, preview.clone()) {
        Ok(tap) => Some(tap),
        Err(err) => {
            tracing::warn!("composed preview tap unavailable: {err}");
            None
        }
    };

    let mut encoder = match hw_encode::ComposedGpuEncoder::open(
        compositor.device(),
        compositor.manager(),
        &path,
        compositor.out_w,
        compositor.out_h,
        spec.fps,
        bitrate,
        audio_plan.include,
    ) {
        Ok(encoder) => encoder,
        Err(err) => {
            return Err(fail_ready(format!(
                "Composed GPU encoding could not start: {err} Use Legacy recording."
            )));
        }
    };
    let encoder_name = encoder.name().to_string();
    let mut stats = diagnostics::SessionStats {
        capture_w: first.width,
        capture_h: first.height,
        output_w: compositor.out_w,
        output_h: compositor.out_h,
        fps: spec.fps,
        encoder: "h264-gpu-mft",
        init_ms: init_started.elapsed().as_millis(),
        ..diagnostics::SessionStats::default()
    };
    if compositor.out_w != 1920 || compositor.out_h != 1080 {
        tracing::warn!(
            compositor = format!("{}x{}", compositor.out_w, compositor.out_h),
            encoder = "1920x1080",
            "composed compositor canvas differs from encoder 1920x1080; Desktop 1080p60 is the supported test"
        );
    }
    diagnostics::log_ready(&encoder_name, encoder.has_audio(), compositor.adapter(), stats.init_ms);
    if ready
        .send(Ok((compositor.out_w, compositor.out_h)))
        .is_err()
    {
        let _ = encoder.finish();
        return Err("Composed recording was cancelled.".into());
    }

    let frame_gap = Duration::from_nanos(1_000_000_000 / u64::from(spec.fps.max(1)));
    let mut last_capture_hns = 0i64;
    let mut last_hud_ms = 0u64;
    let started = Instant::now();
    let width = compositor.out_w;
    let height = compositor.out_h;
    let mut fatal: Option<String> = None;

    while !stop.load(Ordering::SeqCst) {
        let Some(capture_frame) = sources.capture.as_ref().and_then(|cap| cap.latest()) else {
            std::thread::sleep(Duration::from_millis(2));
            continue;
        };
        stats.frames_received = stats.frames_received.saturating_add(1);
        let cam_frame = sources.webcam.as_ref().and_then(|cam| cam.latest());
        let elapsed_ms = started.elapsed().as_millis() as u64;
        if let Some(hud) = spec.hud.as_ref() {
            if hud.timestamp && elapsed_ms.saturating_sub(last_hud_ms) >= 1000 {
                if let Err(err) = compositor.refresh_hud(hud, elapsed_ms) {
                    if compositor.check_device().is_err() {
                        fatal = Some(err);
                        break;
                    }
                }
                last_hud_ms = elapsed_ms;
            }
        }
        let capture_hns = clock.capture_hns();
        if capture_hns + 1_000 < last_capture_hns {
            continue;
        }
        let duration = encoder.frame_duration_hns();
        let compose_started = Instant::now();
        let slot = match encoder.acquire() {
            Ok(slot) => slot,
            Err(err) => {
                fatal = Some(err);
                break;
            }
        };
        let time = encoder.sample_time_hns(stats.frames_encoded);
        let dest = encoder.texture(slot).clone();
        match compositor.compose(
            &spec,
            ComposeInput {
                capture: &capture_frame,
                webcam: cam_frame.as_ref(),
            },
            &dest,
        ) {
            Ok(()) => {
                stats.note_compose(compose_started.elapsed());
                if let Some(tap) = preview_tap.as_mut() {
                    tap.try_offer(&compositor, &preview);
                }
                if let Err(err) = encoder.submit(slot, time, duration) {
                    if compositor.check_device().is_err() {
                        fatal = Some(err);
                    } else {
                        fatal = Some(err);
                    }
                    break;
                }
                if encoder.has_audio() {
                    let pcm = audio.read_audio(frames_from_hns(capture_hns) - frames_from_hns(AUDIO_LEAD_HNS));
                    let _ = encoder.write_pcm(&pcm);
                }
                last_capture_hns = capture_hns;
                stats.frames_encoded = stats.frames_encoded.saturating_add(1);
                if stats.frames_encoded == 1 || stats.frames_encoded % 120 == 0 {
                    let pipe = encoder.pipeline_stats();
                    tracing::info!(
                        capture_frames = stats.frames_received,
                        composed_frames = stats.frames_composed,
                        process_input_count = pipe.process_input,
                        process_output_count = pipe.process_output,
                        encoded_packet_count = pipe.process_output,
                        muxed_video_packet_count = pipe.muxed,
                        last_input_hns = pipe.last_input_hns,
                        last_encoded_hns = pipe.last_encoded_hns,
                        last_mux_hns = pipe.last_mux_hns,
                        in_flight_max = pipe.max_in_flight,
                        "composed encoder live pipeline"
                    );
                }
            }
            Err(err) => {
                stats.frames_dropped = stats.frames_dropped.saturating_add(1);
                if compositor.check_device().is_err() {
                    fatal = Some(err);
                    break;
                }
                tracing::warn!("composed blit failed: {err}");
                std::thread::sleep(Duration::from_millis(2));
            }
        }
        let spent = started.elapsed();
        let expected = frame_gap.saturating_mul(stats.frames_encoded as u32);
        if expected > spent {
            std::thread::sleep(expected - spent);
        }
    }

    drop(preview_tap);
    drop(sources);
    if encoder.has_audio() {
        let pcm = audio.read_audio(frames_from_hns(clock.capture_hns()) - frames_from_hns(AUDIO_LEAD_HNS));
        let _ = encoder.write_pcm_closing(&pcm);
    }
    let (desktop_received, desktop_mixed) = audio.desktop_capture_stats();
    let (mic_received, mic_mixed) = audio.mic_capture_stats();
    let (game_received, game_mixed) = audio.game_capture_stats();
    let desktop_capture_started = audio_guard.desktop;
    audio_guard.release();
    let finish_err = encoder.finish().err();
    let pipe = encoder.pipeline_stats();
    diagnostics::log_stop(
        &stats,
        started.elapsed().as_millis(),
        &pipe,
        &diagnostics::AudioStopStats {
            desktop_capture_started,
            desktop_enabled: audio_plan.desktop,
            desktop_samples_received: desktop_received,
            desktop_samples_mixed: desktop_mixed,
            mic_samples_received: mic_received,
            mic_samples_mixed: mic_mixed,
            game_samples_received: game_received,
            game_samples_mixed: game_mixed,
        },
    );
    if let Some(err) = fatal.or(finish_err) {
        if stats.frames_encoded == 0 {
            return Err(err);
        }
        tracing::warn!("composed session ended with encoder error after {} frames: {err}", stats.frames_encoded);
    }
    if stats.frames_encoded == 0 {
        return Err("Composed recording captured no frames.".into());
    }
    Ok(FinishedComposed {
        path,
        duration_ms: started.elapsed().as_millis() as u64,
        width,
        height,
        fps: spec.fps,
        frames: stats.frames_encoded,
        game_id,
        title,
    })
}

#[cfg(windows)]
struct ComposedSourceGuard {
    capture: Option<sources::capture::ComposedCapture>,
    webcam: Option<sources::webcam::ComposedWebcam>,
}

#[cfg(windows)]
impl Drop for ComposedSourceGuard {
    fn drop(&mut self) {
        if let Some(mut capture) = self.capture.take() {
            capture.stop();
        }
        if let Some(webcam) = self.webcam.take() {
            webcam.stop();
        }
    }
}

#[cfg(windows)]
#[derive(Clone, Copy)]
struct ComposedAudioPlan {
    include: bool,
    mic: bool,
    game: bool,
    desktop: bool,
}

#[cfg(windows)]
struct AudioSessionGuard {
    audio: Option<crate::audio::AudioRuntime>,
    desktop: bool,
    restore: Option<crate::settings::AppSettings>,
}

#[cfg(windows)]
impl AudioSessionGuard {
    fn release(&mut self) {
        if let Some(audio) = self.audio.take() {
            if self.desktop {
                audio.end_composed_desktop();
            }
            if let Some(settings) = self.restore.take() {
                audio.restore_settings_mix_flags(&settings);
            }
            audio.end_session();
        }
    }
}

#[cfg(windows)]
impl Drop for AudioSessionGuard {
    fn drop(&mut self) {
        self.release();
    }
}

#[cfg(windows)]
fn wait_first_frame(
    capture: &sources::capture::ComposedCapture,
    stop: &AtomicBool,
) -> Result<crate::still::StillFrame, String> {
    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline {
        if stop.load(Ordering::SeqCst) {
            return Err("Composed recording was cancelled.".into());
        }
        if let Some(frame) = capture.latest() {
            return Ok(frame);
        }
        std::thread::sleep(Duration::from_millis(16));
    }
    Err("Composed recording did not receive a capture frame. Use Legacy recording or try again.".into())
}

fn load_settings(app: &AppHandle) -> AppResult<AppSettings> {
    let db = app.state::<AppState>();
    let conn = db.db.lock().map_err(|err| AppError::Message(err.to_string()))?;
    settings::load(&conn)
}

fn save_dir(app: &AppHandle, settings: &AppSettings) -> AppResult<std::path::PathBuf> {
    let dir = if settings.save_location.trim().is_empty() {
        let dir = app
            .path()
            .video_dir()
            .or_else(|_| app.path().document_dir())
            .map_err(|err| AppError::Message(err.to_string()))?;
        dir.join("Project Replay")
    } else {
        std::path::PathBuf::from(&settings.save_location)
    };
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn bitrate_of(settings: &AppSettings) -> u32 {
    match settings.bitrate.as_str() {
        "low" => 8_000_000,
        "high" => 25_000_000,
        "custom" => settings.custom_bitrate_kbps.saturating_mul(1000).max(1_000_000),
        _ => 15_000_000,
    }
}

fn output_path(dir: &std::path::Path, slug: &str, ext: &str) -> std::path::PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let slug = slug
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect::<String>();
    dir.join(format!("{slug}-{stamp}.{ext}"))
}
