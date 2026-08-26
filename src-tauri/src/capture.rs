use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::buffer::ReplayBuffer;
use crate::database::AppState;
use crate::error::{AppError, AppResult};
use crate::settings::{self, AppSettings};
use crate::still::StillFrame;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStatus {
    pub active: bool,
    pub path: Option<String>,
    pub target: Option<String>,
    pub started_at: Option<String>,
    pub duration_ms: u64,
    pub error: Option<String>,
}

impl Default for RecordingStatus {
    fn default() -> Self {
        Self {
            active: false,
            path: None,
            target: None,
            started_at: None,
            duration_ms: 0,
            error: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReplayStatus {
    pub enabled: bool,
    pub active: bool,
    pub buffered_ms: u64,
    pub duration_ms: u64,
    pub target: Option<String>,
    pub error: Option<String>,
    pub disk_free_bytes: Option<u64>,
    pub disk_blocked: bool,
    pub saving: bool,
}

impl Default for ReplayStatus {
    fn default() -> Self {
        Self {
            enabled: false,
            active: false,
            buffered_ms: 0,
            duration_ms: 60_000,
            target: None,
            error: None,
            disk_free_bytes: None,
            disk_blocked: false,
            saving: false,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedClipEvent {
    pub path: String,
    pub kind: String,
    pub local_id: String,
}

pub struct CaptureShared {
    pub buffer: Mutex<ReplayBuffer>,
    pub rotate: AtomicBool,
    pub generation: AtomicU64,
    pub tick: Mutex<u64>,
    pub cv: Condvar,
    pub last_still: Mutex<Option<StillFrame>>,
    pub exporting: AtomicBool,
}

impl Default for CaptureShared {
    fn default() -> Self {
        Self {
            buffer: Mutex::new(ReplayBuffer::new(60_000)),
            rotate: AtomicBool::new(false),
            generation: AtomicU64::new(0),
            tick: Mutex::new(0),
            cv: Condvar::new(),
            last_still: Mutex::new(None),
            exporting: AtomicBool::new(false),
        }
    }
}

impl CaptureShared {
    pub fn notify_rotate(&self) {
        let next = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        if let Ok(mut tick) = self.tick.lock() {
            *tick = next;
        }
        self.cv.notify_all();
    }
}

pub struct RecordingState {
    inner: Mutex<Option<ActiveRecording>>,
    pub status: Mutex<RecordingStatus>,
    pub replay: Mutex<ReplayStatus>,
    pub shared: Arc<CaptureShared>,
}

struct ActiveRecording {
    control: Option<CaptureHandle>,
    path: PathBuf,
    started: Instant,
    width: u32,
    height: u32,
    fps: u32,
    game_id: Option<String>,
    title: String,
    pid: Option<u32>,
    placement: crate::overlay_notification::PlacementHint,
    segmented: bool,
    session: bool,
}

enum CaptureHandle {
    #[cfg(windows)]
    Session(windows_capture::capture::CaptureControl<windows_impl::WindowsSession, String>),
    #[cfg(not(windows))]
    Unsupported,
}

impl Default for RecordingState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(None),
            status: Mutex::new(RecordingStatus::default()),
            replay: Mutex::new(ReplayStatus::default()),
            shared: Arc::new(CaptureShared::default()),
        }
    }
}

#[cfg(windows)]
mod windows_impl {
    use super::*;
    use std::convert::TryInto;
    use windows_capture::capture::{Context, GraphicsCaptureApiHandler};
    use windows_capture::frame::Frame;
    use windows_capture::graphics_capture_api::InternalCaptureControl;
    use windows_capture::monitor::Monitor;
    use windows_capture::settings::{
        ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
        MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
    };
    use windows_capture::window::Window;

    use crate::camera::SessionClock;

    pub struct WindowsSession {
        pump: crate::encode_pump::EncodePump,
        audio: Option<crate::audio::LoopbackCapture>,
        flags: SessionFlags,
        clock: SessionClock,
        last_still_at: Instant,
    }

    #[derive(Clone)]
    pub struct SessionFlags {
        pub path: PathBuf,
        pub dir: PathBuf,
        pub width: u32,
        pub height: u32,
        pub bitrate: u32,
        pub fps: u32,
        pub include_audio: bool,
        pub segmented: bool,
        pub min_free_disk_bytes: u64,
        pub shared: Arc<CaptureShared>,
        pub audio_runtime: crate::audio::AudioRuntime,
        pub camera: crate::camera::CameraEngine,
        pub resolution: String,
    }

    impl GraphicsCaptureApiHandler for WindowsSession {
        type Flags = SessionFlags;
        type Error = String;

        fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
            let flags = ctx.flags;
            // Gameplay Instant-elapsed, audio QPC origin, and webcam mapping
            // share this T0. Instant is sampled first, then QPC.
            let clock = SessionClock::start();
            flags.audio_runtime.begin_session(clock.qpc_origin_hns());
            flags.camera.begin_session(clock);
            let mut audio = if flags.include_audio {
                crate::audio::LoopbackCapture::start(
                    flags.audio_runtime.sink(),
                    flags.audio_runtime.desktop_control(),
                )
            } else {
                None
            };
            let pump = match crate::encode_pump::EncodePump::start(crate::encode_pump::EncodeSession {
                path: flags.path.clone(),
                dir: flags.dir.clone(),
                width: flags.width,
                height: flags.height,
                bitrate: flags.bitrate,
                fps: flags.fps,
                include_audio: flags.include_audio,
                segmented: flags.segmented,
                min_free_disk_bytes: flags.min_free_disk_bytes,
                shared: Arc::clone(&flags.shared),
                audio: flags.audio_runtime.clone(),
            }) {
                Ok(pump) => pump,
                Err(err) => {
                    flags.camera.end_session();
                    flags.audio_runtime.end_session();
                    return Err(err);
                }
            };
            if !pump.include_audio {
                audio = None;
                flags.audio_runtime.end_session();
            }
            Ok(Self {
                pump,
                audio,
                flags,
                clock,
                last_still_at: Instant::now()
                    .checked_sub(Duration::from_millis(500))
                    .unwrap_or_else(Instant::now),
            })
        }

        fn on_frame_arrived(
            &mut self,
            frame: &mut Frame,
            _capture_control: InternalCaptureControl,
        ) -> Result<(), Self::Error> {
            let mut pixels = frame.buffer().map_err(|err| err.to_string())?;
            let width = pixels.width();
            let height = pixels.height();
            let mut packed = Vec::new();
            let (bytes, pitch) = if pixels.has_padding() {
                let _ = pixels.as_nopadding_buffer(&mut packed);
                (packed, width * 4)
            } else {
                (pixels.as_raw_buffer().to_vec(), pixels.row_pitch())
            };
            drop(pixels);
            let mut frame = StillFrame {
                bgra: bytes,
                width,
                height,
                pitch,
            };
            // Fit into the encoder canvas with letterbox/pillarbox so 4:3 and
            // 16:10 (and mismatched DPI sizes) keep their shape.
            if frame.width != self.flags.width || frame.height != self.flags.height {
                frame = crate::still::fit_bgra_contain(frame, self.flags.width, self.flags.height);
            }
            if self.last_still_at.elapsed() >= Duration::from_millis(500) {
                self.last_still_at = Instant::now();
                if let Ok(mut still) = self.flags.shared.last_still.lock() {
                    *still = Some(frame.clone());
                }
            }
            let capture_hns = self.clock.capture_hns();
            self.pump.push(crate::encode_pump::QueuedFrame {
                bgra: frame.bgra,
                pitch: frame.pitch,
                width: frame.width,
                height: frame.height,
                capture_hns,
            });
            Ok(())
        }

        fn on_closed(&mut self) -> Result<(), Self::Error> {
            self.finish_encoder(true)
        }
    }

    impl WindowsSession {
        fn finish_encoder(&mut self, drop_audio: bool) -> Result<(), String> {
            if drop_audio {
                drop(self.audio.take());
            }
            self.pump.shutdown();
            self.flags.camera.end_session();
            self.flags.audio_runtime.end_session();
            Ok(())
        }
    }

    impl Drop for WindowsSession {
        fn drop(&mut self) {
            self.flags.camera.end_session();
        }
    }

    fn wait_for_rotate(shared: &CaptureShared, timeout: Duration) {
        let start_gen = shared.generation.load(Ordering::SeqCst);
        shared.rotate.store(true, Ordering::SeqCst);
        let Ok(tick) = shared.tick.lock() else {
            return;
        };
        if *tick > start_gen {
            return;
        }
        let _ = shared.cv.wait_timeout(tick, timeout);
    }

    fn align_even(value: u32, fallback: u32) -> u32 {
        let value = if value < 2 { fallback } else { value };
        (value.max(2) / 2) * 2
    }

    fn resolution_box(resolution: &str) -> Option<(u32, u32)> {
        match resolution {
            "720p" => Some((1280, 720)),
            "1080p" => Some((1920, 1080)),
            _ => None,
        }
    }

    /// Output size that keeps the source aspect (4:3 / 16:9 / 16:10) instead of
    /// forcing a 16:9 box. Dimensions are even for H.264.
    fn encode_size(src_w: u32, src_h: u32, resolution: &str) -> (u32, u32) {
        let src_w = src_w.max(2);
        let src_h = src_h.max(2);
        let (target_w, target_h) = if let Some((max_w, max_h)) = resolution_box(resolution) {
            if src_w <= max_w && src_h <= max_h {
                (src_w, src_h)
            } else {
                let scale = (max_w as f64 / src_w as f64).min(max_h as f64 / src_h as f64);
                (
                    ((src_w as f64) * scale).round().max(2.0) as u32,
                    ((src_h as f64) * scale).round().max(2.0) as u32,
                )
            }
        } else {
            (src_w, src_h)
        };
        (align_even(target_w, 1920), align_even(target_h, 1080))
    }

    fn capture_settings<T>(item: T, flags: SessionFlags) -> Settings<SessionFlags, T>
    where
        T: TryInto<windows_capture::settings::GraphicsCaptureItemType>,
    {
        Settings::new(
            item,
            CursorCaptureSettings::Default,
            DrawBorderSettings::WithoutBorder,
            SecondaryWindowSettings::Default,
            MinimumUpdateIntervalSettings::Default,
            DirtyRegionSettings::Default,
            ColorFormat::Bgra8,
            flags,
        )
    }

    fn begin<T>(
        item: T,
        flags: SessionFlags,
    ) -> Result<windows_capture::capture::CaptureControl<WindowsSession, String>, String>
    where
        T: TryInto<windows_capture::settings::GraphicsCaptureItemType> + Clone + Send + 'static,
    {
        match WindowsSession::start_free_threaded(capture_settings(item.clone(), flags.clone())) {
            Ok(control) => Ok(control),
            Err(err) => {
                tracing::warn!("borderless capture unavailable ({err}); retrying with default border");
                let fallback = Settings::new(
                    item,
                    CursorCaptureSettings::Default,
                    DrawBorderSettings::Default,
                    SecondaryWindowSettings::Default,
                    MinimumUpdateIntervalSettings::Default,
                    DirtyRegionSettings::Default,
                    ColorFormat::Bgra8,
                    flags,
                );
                WindowsSession::start_free_threaded(fallback).map_err(|err| err.to_string())
            }
        }
    }

    fn window_for_pid(pid: u32) -> Option<Window> {
        let windows = Window::enumerate().ok()?;
        let mut matches: Vec<Window> = windows
            .into_iter()
            .filter(|window| window.is_valid() && window.process_id().ok() == Some(pid))
            .collect();
        matches.sort_by_key(|window| {
            let area = window.width().unwrap_or(0).saturating_mul(window.height().unwrap_or(0));
            std::cmp::Reverse(area)
        });
        matches.into_iter().next()
    }

    fn load_settings(app: &AppHandle) -> AppResult<AppSettings> {
        let db = app.state::<AppState>();
        let conn = db.db.lock().map_err(|err| AppError::Message(err.to_string()))?;
        settings::load(&conn)
    }

    fn save_dir(app: &AppHandle, settings: &AppSettings) -> AppResult<PathBuf> {
        let dir = if settings.save_location.trim().is_empty() {
            let dir = app
                .path()
                .video_dir()
                .or_else(|_| app.path().document_dir())
                .map_err(|err| AppError::Message(err.to_string()))?;
            dir.join("Project Replay")
        } else {
            PathBuf::from(&settings.save_location)
        };
        std::fs::create_dir_all(&dir)?;
        Ok(dir)
    }

    fn replay_scratch_dir(app: &AppHandle) -> AppResult<PathBuf> {
        let dir = app
            .path()
            .app_cache_dir()
            .or_else(|_| app.path().app_data_dir())
            .map_err(|err| AppError::Message(err.to_string()))?
            .join("replay-buffer");
        Ok(dir)
    }

    fn hide_scratch_dir(path: &Path) {
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            use windows::core::PCWSTR;
            use windows::Win32::Storage::FileSystem::{
                FILE_ATTRIBUTE_HIDDEN, FILE_ATTRIBUTE_NOT_CONTENT_INDEXED, SetFileAttributesW,
            };
            let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
            let attrs = FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_NOT_CONTENT_INDEXED;
            let _ = unsafe { SetFileAttributesW(PCWSTR(wide.as_ptr()), attrs) };
        }
        #[cfg(not(windows))]
        {
            let _ = path;
        }
    }

    fn purge_legacy_scratch(save: &Path) {
        let _ = std::fs::remove_dir_all(save.join(".replay-buffer"));
    }

    fn discard_scratch(state: &RecordingState, dir: &Path) {
        if let Ok(mut buffer) = state.shared.buffer.lock() {
            buffer.clear(true);
        }
        crate::buffer::sweep_dir(dir, &[]);
        let _ = std::fs::remove_dir_all(dir);
    }

    fn prepare_scratch(app: &AppHandle, save: &Path) -> AppResult<PathBuf> {
        purge_legacy_scratch(save);
        let dir = replay_scratch_dir(app)?;
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir)?;
        hide_scratch_dir(&dir);
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

    fn output_path(dir: &Path, slug: &str, ext: &str) -> PathBuf {
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

    fn insert_local_clip(
        app: &AppHandle,
        state: &RecordingState,
        path: &Path,
        duration_ms: u64,
        width: u32,
        height: u32,
        fps: u32,
        game_id: Option<String>,
        title: String,
    ) -> AppResult<String> {
        let preview = state.shared.last_still.lock().ok().and_then(|slot| slot.clone());
        crate::library::insert(app, path, duration_ms, width, height, fps, game_id, title, preview.as_ref())
    }

    fn emit_saved(app: &AppHandle, path: &Path, kind: &str, local_id: String) {
        let _ = app.emit(
            "local-clip-saved",
            SavedClipEvent {
                path: path.display().to_string(),
                kind: kind.into(),
                local_id,
            },
        );
    }

    fn publish_replay(app: &AppHandle, state: &RecordingState, settings: &AppSettings, error: Option<String>) {
        let buffered_ms = state
            .shared
            .buffer
            .lock()
            .map(|buffer| buffer.total_ms())
            .unwrap_or(0);
        let active = state.inner.lock().map(|inner| inner.is_some()).unwrap_or(false);
        let target = state
            .inner
            .lock()
            .ok()
            .and_then(|inner| inner.as_ref().map(|session| session.title.clone()));
        let save = PathBuf::from(&settings.save_location);
        let disk_free_bytes = crate::disk::free_bytes(&save).ok();
        let disk_blocked = disk_free_bytes
            .map(|free| free < settings.min_free_disk_bytes)
            .unwrap_or(false);
        let status = ReplayStatus {
            enabled: settings.instant_replay_enabled,
            active: active && settings.instant_replay_enabled,
            buffered_ms,
            duration_ms: u64::from(settings.replay_duration_seconds) * 1000,
            target,
            error,
            disk_free_bytes,
            disk_blocked,
            saving: state.shared.exporting.load(Ordering::SeqCst),
        };
        if let Ok(mut slot) = state.replay.lock() {
            *slot = status.clone();
        }
        let _ = app.emit("replay-status", &status);
    }

    pub fn start(
        app: &AppHandle,
        state: &RecordingState,
        pid: Option<u32>,
        game_name: Option<String>,
        game_id: Option<String>,
        segmented: bool,
        session: bool,
    ) -> AppResult<RecordingStatus> {
        let settings = load_settings(app)?;
        let save = save_dir(app, &settings)?;
        crate::disk::ensure_free_space(&save, settings.min_free_disk_bytes)?;

        let mut inner = state.inner.lock().map_err(|err| AppError::Message(err.to_string()))?;
        if inner.is_some() {
            return Err(AppError::Message("Capture is already running.".into()));
        }

        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let slug = game_id.as_deref().unwrap_or(if session { "recording" } else { "replay" });
        let output = output_path(&save, slug, "mp4");
        let buffer_dir = if segmented {
            prepare_scratch(app, &save)?
        } else {
            purge_legacy_scratch(&save);
            save.clone()
        };
        if segmented {
            if let Ok(mut buffer) = state.shared.buffer.lock() {
                buffer.clear(false);
                buffer.set_max_duration_ms(u64::from(settings.replay_duration_seconds) * 1000);
            }
        }

        let fps = settings.fps.max(15).min(120);
        let bitrate = bitrate_of(&settings);
        let include_audio = settings.wants_audio_track();
        let audio_runtime = {
            let runtime = app.state::<crate::audio::AudioRuntime>();
            (*runtime).clone()
        };
        let camera = {
            let engine = app.state::<crate::camera::CameraEngine>();
            (*engine).clone()
        };
        let first_path = if segmented {
            buffer_dir.join("seg-000000.mp4")
        } else {
            output.clone()
        };
        tracing::info!(
            "starting capture pid={pid:?} segmented={segmented} session={session} fps={fps} resolution={} path={}",
            settings.resolution,
            first_path.display()
        );

        let resolution = settings.resolution.clone();
        let make_flags = |width: u32, height: u32| SessionFlags {
            path: first_path.clone(),
            dir: buffer_dir.clone(),
            width,
            height,
            bitrate,
            fps,
            include_audio,
            segmented,
            min_free_disk_bytes: settings.min_free_disk_bytes,
            shared: state.shared.clone(),
            audio_runtime: audio_runtime.clone(),
            camera: camera.clone(),
            resolution: resolution.clone(),
        };

        let mut last_error = None;
        let mut started = None;

        if let Some(pid) = pid.filter(|id| *id != 0) {
            if let Some(window) = window_for_pid(pid) {
                let (width, height) = encode_size(
                    window.width().unwrap_or(1920).max(0) as u32,
                    window.height().unwrap_or(1080).max(0) as u32,
                    &resolution,
                );
                let monitor = window.monitor();
                match begin(window, make_flags(width, height)) {
                    Ok(control) => {
                        started = Some((
                            game_name.clone().unwrap_or_else(|| "Window".into()),
                            control,
                            width,
                            height,
                        ));
                    }
                    Err(err) => {
                        tracing::warn!("window capture failed: {err}");
                        last_error = Some(err);
                        if let Some(monitor) = monitor {
                            let (width, height) = encode_size(
                                monitor.width().unwrap_or(1920),
                                monitor.height().unwrap_or(1080),
                                &resolution,
                            );
                            match begin(monitor, make_flags(width, height)) {
                                Ok(control) => {
                                    started = Some(("Display".into(), control, width, height));
                                }
                                Err(err) => {
                                    tracing::warn!("game-display capture failed: {err}");
                                    last_error = Some(err);
                                }
                            }
                        }
                    }
                }
            }
        }

        let (target_label, control, width, height) = if let Some(session) = started {
            session
        } else {
            match start_monitor(make_flags(1920, 1080)) {
                Ok(session) => session,
                Err(err) => {
                    let detail = last_error
                        .map(|previous| format!("{previous}; {err}"))
                        .unwrap_or_else(|| err.to_string());
                    tracing::error!("could not start capture: {detail}");
                    return Err(AppError::Message(detail));
                }
            }
        };
        tracing::info!("capture encode size {width}x{height}");

        if segmented && session {
            if let Ok(mut buffer) = state.shared.buffer.lock() {
                buffer.begin_session();
            }
        }

        let started_at = Instant::now();
        let status = RecordingStatus {
            active: session,
            path: session.then(|| output.display().to_string()),
            target: Some(target_label.clone()),
            started_at: session.then(|| chrono_like(stamp)),
            duration_ms: 0,
            error: None,
        };
        *state.status.lock().map_err(|err| AppError::Message(err.to_string()))? = status.clone();
        *inner = Some(ActiveRecording {
            control: Some(CaptureHandle::Session(control)),
            path: output,
            started: started_at,
            width,
            height,
            fps,
            game_id,
            title: target_label,
            pid,
            placement: crate::overlay_notification::hint_from_pid(pid),
            segmented,
            session,
        });
        drop(inner);
        if session {
            let _ = app.emit("recording-status", &status);
        }
        publish_replay(app, state, &settings, None);
        Ok(status)
    }

    fn start_monitor(
        flags: SessionFlags,
    ) -> AppResult<(String, windows_capture::capture::CaptureControl<WindowsSession, String>, u32, u32)> {
        let monitor = Monitor::primary().map_err(|err| AppError::Message(err.to_string()))?;
        let (width, height) = encode_size(
            monitor.width().unwrap_or(1920),
            monitor.height().unwrap_or(1080),
            &flags.resolution,
        );
        let mut flags = flags;
        flags.width = width;
        flags.height = height;
        let control = begin(monitor, flags).map_err(AppError::Message)?;
        Ok(("Display".into(), control, width, height))
    }

    fn halt_capture(state: &RecordingState) -> AppResult<ActiveRecording> {
        let mut inner = state.inner.lock().map_err(|err| AppError::Message(err.to_string()))?;
        let mut session = inner.take().ok_or_else(|| AppError::Message("Capture is not running.".into()))?;
        drop(inner);
        match session.control.take() {
            Some(CaptureHandle::Session(control)) => {
                let callback = control.callback();
                control.stop().map_err(|err| AppError::Message(err.to_string()))?;
                callback.lock().finish_encoder(true).map_err(AppError::Message)?;
            }
            _ => {}
        }
        Ok(session)
    }

    pub fn start_recording(
        app: &AppHandle,
        state: &RecordingState,
        pid: Option<u32>,
        game_name: Option<String>,
        game_id: Option<String>,
    ) -> AppResult<RecordingStatus> {
        {
            let mut inner = state.inner.lock().map_err(|err| AppError::Message(err.to_string()))?;
            if let Some(active) = inner.as_mut() {
                if active.session {
                    return Err(AppError::Message("Already recording.".into()));
                }
                if active.segmented {
                    wait_for_rotate(&state.shared, Duration::from_secs(3));
                    if let Ok(mut buffer) = state.shared.buffer.lock() {
                        buffer.begin_session();
                    }
                    let settings = load_settings(app)?;
                    let save = save_dir(app, &settings)?;
                    let slug = game_id.as_deref().unwrap_or("recording");
                    active.path = output_path(&save, slug, "mp4");
                    active.started = Instant::now();
                    active.game_id = game_id;
                    if let Some(name) = game_name {
                        active.title = name;
                    }
                    active.session = true;
                    let stamp = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .map(|d| d.as_secs())
                        .unwrap_or(0);
                    let status = RecordingStatus {
                        active: true,
                        path: Some(active.path.display().to_string()),
                        target: Some(active.title.clone()),
                        started_at: Some(chrono_like(stamp)),
                        duration_ms: 0,
                        error: None,
                    };
                    *state.status.lock().map_err(|err| AppError::Message(err.to_string()))? = status.clone();
                    drop(inner);
                    let _ = app.emit("recording-status", &status);
                    publish_replay(app, state, &settings, None);
                    return Ok(status);
                }
                return Err(AppError::Message("Already recording.".into()));
            }
        }
        let settings = load_settings(app)?;
        start(app, state, pid, game_name, game_id, settings.instant_replay_enabled, true)
    }

    pub fn stop_recording(app: &AppHandle, state: &RecordingState) -> AppResult<RecordingStatus> {
        let settings = load_settings(app)?;
        let segmented_session = {
            let inner = state.inner.lock().map_err(|err| AppError::Message(err.to_string()))?;
            inner
                .as_ref()
                .map(|active| active.session && active.segmented)
                .unwrap_or(false)
        };
        if segmented_session {
            wait_for_rotate(&state.shared, Duration::from_secs(3));
            let paths = state
                .shared
                .buffer
                .lock()
                .map_err(|err| AppError::Message(err.to_string()))?
                .session_paths();
            let (output, elapsed, width, height, fps, game_id, title) = {
                let mut inner = state.inner.lock().map_err(|err| AppError::Message(err.to_string()))?;
                let active = inner.as_mut().ok_or_else(|| AppError::Message("Not recording.".into()))?;
                active.session = false;
                (
                    active.path.clone(),
                    active.started.elapsed(),
                    active.width,
                    active.height,
                    active.fps,
                    active.game_id.clone(),
                    active.title.clone(),
                )
            };
            if paths.is_empty() {
                return Err(AppError::Message("Recording did not capture any video yet.".into()));
            }
            crate::export::concat_mp4s(&paths, &output).map_err(AppError::Message)?;
            if let Ok(mut buffer) = state.shared.buffer.lock() {
                buffer.unlock_all();
                buffer.end_session();
            }
            let local_id = insert_local_clip(
                app,
                state,
                &output,
                elapsed.as_millis() as u64,
                width,
                height,
                fps,
                game_id,
                title.clone(),
            )?;
            emit_saved(app, &output, "recording", local_id);
            let status = RecordingStatus {
                active: false,
                path: Some(output.display().to_string()),
                target: Some(title),
                started_at: None,
                duration_ms: elapsed.as_millis() as u64,
                error: None,
            };
            *state.status.lock().map_err(|err| AppError::Message(err.to_string()))? = status.clone();
            let _ = app.emit("recording-status", &status);
            if !settings.instant_replay_enabled {
                let _ = halt_capture(state);
                if let Ok(dir) = replay_scratch_dir(app) {
                    discard_scratch(state, &dir);
                }
            }
            publish_replay(app, state, &settings, None);
            return Ok(status);
        }

        let session = halt_capture(state)?;
        if !session.session {
            publish_replay(app, state, &settings, None);
            return Err(AppError::Message("Not recording.".into()));
        }
        let elapsed = session.started.elapsed();
        let local_id = insert_local_clip(
            app,
            state,
            &session.path,
            elapsed.as_millis() as u64,
            session.width,
            session.height,
            session.fps,
            session.game_id,
            session.title.clone(),
        )?;
        emit_saved(app, &session.path, "recording", local_id);
        let status = RecordingStatus {
            active: false,
            path: Some(session.path.display().to_string()),
            target: Some(session.title),
            started_at: None,
            duration_ms: elapsed.as_millis() as u64,
            error: None,
        };
        *state.status.lock().map_err(|err| AppError::Message(err.to_string()))? = status.clone();
        let _ = app.emit("recording-status", &status);
        publish_replay(app, state, &settings, None);
        Ok(status)
    }

    pub fn sync_replay(
        app: &AppHandle,
        state: &RecordingState,
        pid: Option<u32>,
        game_name: Option<String>,
        game_id: Option<String>,
    ) -> AppResult<ReplayStatus> {
        let settings = load_settings(app)?;
        purge_legacy_scratch(&save_dir(app, &settings)?);
        if let Ok(mut buffer) = state.shared.buffer.lock() {
            buffer.set_max_duration_ms(u64::from(settings.replay_duration_seconds) * 1000);
            buffer.prune(true);
        }
        let (running, session, current_pid, segmented) = {
            let inner = state.inner.lock().map_err(|err| AppError::Message(err.to_string()))?;
            match inner.as_ref() {
                Some(active) => (true, active.session, active.pid, active.segmented),
                None => (false, false, None, false),
            }
        };

        if settings.instant_replay_enabled {
            let game_pid = pid.filter(|id| *id != 0);
            if running && segmented && !session {
                if game_pid.is_none() {
                    let _ = halt_capture(state);
                    if let Ok(dir) = replay_scratch_dir(app) {
                        discard_scratch(state, &dir);
                    }
                } else if current_pid != game_pid {
                    let _ = halt_capture(state);
                    match start(app, state, game_pid, game_name, game_id, true, false) {
                        Ok(_) => {}
                        Err(err) => {
                            if let Ok(dir) = replay_scratch_dir(app) {
                                discard_scratch(state, &dir);
                            }
                            publish_replay(app, state, &settings, Some(err.to_string()));
                            return Ok(replay_status(state, &settings));
                        }
                    }
                }
            } else if !running {
                if game_pid.is_some() {
                    match start(app, state, game_pid, game_name, game_id, true, false) {
                        Ok(_) => {}
                        Err(err) => {
                            publish_replay(app, state, &settings, Some(err.to_string()));
                            return Ok(replay_status(state, &settings));
                        }
                    }
                } else if let Ok(dir) = replay_scratch_dir(app) {
                    discard_scratch(state, &dir);
                }
            }
        } else if running && segmented && !session {
            let _ = halt_capture(state);
            if let Ok(dir) = replay_scratch_dir(app) {
                discard_scratch(state, &dir);
            }
        }

        publish_replay(app, state, &settings, None);
        Ok(replay_status(state, &settings))
    }

    pub fn save_clip(app: &AppHandle, state: &RecordingState) -> AppResult<String> {
        if state.shared.exporting.swap(true, Ordering::SeqCst) {
            return Err(AppError::Message("Already saving a clip.".into()));
        }
        struct ExportGuard {
            app: AppHandle,
        }
        impl Drop for ExportGuard {
            fn drop(&mut self) {
                let rec = self.app.state::<RecordingState>();
                rec.shared.exporting.store(false, Ordering::SeqCst);
                if let Ok(settings) = load_settings(&self.app) {
                    publish_replay(&self.app, &rec, &settings, None);
                }
            }
        }
        if let Ok(settings) = load_settings(app) {
            publish_replay(app, state, &settings, None);
        }
        let _ = app.emit("clip-save", serde_json::json!({ "phase": "saving" }));
        let _guard = ExportGuard { app: app.clone() };
        match save_clip_inner(app, state) {
            Ok(path) => {
                let _ = app.emit("clip-save", serde_json::json!({ "phase": "ready", "path": &path }));
                Ok(path)
            }
            Err(err) => {
                let _ = app.emit(
                    "clip-save",
                    serde_json::json!({ "phase": "failed", "message": err.to_string() }),
                );
                Err(err)
            }
        }
    }

    fn save_clip_inner(app: &AppHandle, state: &RecordingState) -> AppResult<String> {
        let settings = load_settings(app)?;
        let save = save_dir(app, &settings)?;
        crate::disk::ensure_free_space(&save, settings.min_free_disk_bytes)?;
        let (width, height, fps, game_id, title, placement) = {
            let inner = state.inner.lock().map_err(|err| AppError::Message(err.to_string()))?;
            let active = inner.as_ref().ok_or_else(|| AppError::Message("Instant Replay is not running.".into()))?;
            if !active.segmented {
                return Err(AppError::Message("Turn on Instant Replay to save a clip.".into()));
            }
            (
                active.width,
                active.height,
                active.fps,
                active.game_id.clone(),
                active.title.clone(),
                active.placement,
            )
        };
        wait_for_rotate(&state.shared, Duration::from_millis(400));
        let duration_ms = u64::from(settings.replay_duration_seconds) * 1000;
        let paths: Vec<_> = {
            let mut buffer = state.shared.buffer.lock().map_err(|err| AppError::Message(err.to_string()))?;
            if buffer.total_ms() < 400 {
                buffer.unlock_all();
                return Err(AppError::Message("Replay buffer is still filling.".into()));
            }
            buffer
                .clip_paths(duration_ms)
                .into_iter()
                .filter(|path| std::fs::metadata(path).map(|meta| meta.len() > 0).unwrap_or(false))
                .collect()
        };
        if paths.is_empty() {
            return Err(AppError::Message("Replay buffer is still filling.".into()));
        }
        let output = output_path(&save, "clip", "mp4");
        let result = crate::export::concat_mp4s(&paths, &output);
        if let Ok(mut buffer) = state.shared.buffer.lock() {
            buffer.unlock_all();
        }
        if let Err(err) = result {
            let _ = std::fs::remove_file(&output);
            return Err(AppError::Message(err));
        }
        let clip_ms = paths.len() as u64 * 2_000;
        let local_id = insert_local_clip(
            app,
            state,
            &output,
            clip_ms.min(duration_ms),
            width,
            height,
            fps,
            game_id,
            format!("{title} clip"),
        )?;
        emit_saved(app, &output, "clip", local_id);
        crate::overlay_notification::notify_clip_saved(
            app,
            placement,
            Some(settings.replay_duration_seconds),
        );
        Ok(output.display().to_string())
    }

    pub fn screenshot(app: &AppHandle, state: &RecordingState) -> AppResult<String> {
        let settings = load_settings(app)?;
        let save = save_dir(app, &settings)?;
        crate::disk::ensure_free_space(&save, settings.min_free_disk_bytes)?;
        let frame = state
            .shared
            .last_still
            .lock()
            .map_err(|err| AppError::Message(err.to_string()))?
            .clone()
            .ok_or_else(|| AppError::Message("No frame captured yet. Start Instant Replay or a recording first.".into()))?;
        let (game_id, title) = {
            let inner = state.inner.lock().map_err(|err| AppError::Message(err.to_string()))?;
            inner
                .as_ref()
                .map(|active| (active.game_id.clone(), active.title.clone()))
                .unwrap_or((None, "Screenshot".into()))
        };
        let output = output_path(&save, "screenshot", "bmp");
        crate::still::write_bgra_bmp(&output, &frame).map_err(AppError::Message)?;
        let local_id = insert_local_clip(
            app,
            state,
            &output,
            0,
            frame.width,
            frame.height,
            0,
            game_id,
            format!("{title} screenshot"),
        )?;
        emit_saved(app, &output, "screenshot", local_id);
        Ok(output.display().to_string())
    }
}

#[cfg(not(windows))]
mod windows_impl {
    use super::*;

    pub fn start_recording(
        _app: &AppHandle,
        _state: &RecordingState,
        _pid: Option<u32>,
        _game_name: Option<String>,
        _game_id: Option<String>,
    ) -> AppResult<RecordingStatus> {
        Err(AppError::Message("Recording is only available on Windows.".into()))
    }

    pub fn stop_recording(_app: &AppHandle, _state: &RecordingState) -> AppResult<RecordingStatus> {
        Err(AppError::Message("Recording is only available on Windows.".into()))
    }

    pub fn sync_replay(
        _app: &AppHandle,
        _state: &RecordingState,
        _pid: Option<u32>,
        _game_name: Option<String>,
        _game_id: Option<String>,
    ) -> AppResult<ReplayStatus> {
        Err(AppError::Message("Instant Replay is only available on Windows.".into()))
    }

    pub fn save_clip(_app: &AppHandle, _state: &RecordingState) -> AppResult<String> {
        Err(AppError::Message("Instant Replay is only available on Windows.".into()))
    }

    pub fn screenshot(_app: &AppHandle, _state: &RecordingState) -> AppResult<String> {
        Err(AppError::Message("Screenshots are only available on Windows.".into()))
    }
}

pub fn start(
    app: &AppHandle,
    state: &RecordingState,
    pid: Option<u32>,
    game_name: Option<String>,
    game_id: Option<String>,
) -> AppResult<RecordingStatus> {
    windows_impl::start_recording(app, state, pid, game_name, game_id)
}

pub fn stop(app: &AppHandle, state: &RecordingState) -> AppResult<RecordingStatus> {
    windows_impl::stop_recording(app, state)
}

pub fn save_clip(app: &AppHandle, state: &RecordingState) -> AppResult<String> {
    windows_impl::save_clip(app, state)
}

pub fn screenshot(app: &AppHandle, state: &RecordingState) -> AppResult<String> {
    windows_impl::screenshot(app, state)
}

pub fn sync_replay(
    app: &AppHandle,
    state: &RecordingState,
    pid: Option<u32>,
    game_name: Option<String>,
    game_id: Option<String>,
) -> AppResult<ReplayStatus> {
    windows_impl::sync_replay(app, state, pid, game_name, game_id)
}

pub fn status(state: &RecordingState) -> RecordingStatus {
    state
        .status
        .lock()
        .map(|guard| {
            let mut current = guard.clone();
            if current.active {
                if let Ok(inner) = state.inner.lock() {
                    if let Some(session) = inner.as_ref() {
                        if session.session {
                            current.duration_ms = session.started.elapsed().as_millis() as u64;
                        }
                    }
                }
            }
            current
        })
        .unwrap_or_default()
}

pub fn replay_status(state: &RecordingState, settings: &AppSettings) -> ReplayStatus {
    let buffered_ms = state
        .shared
        .buffer
        .lock()
        .map(|buffer| buffer.total_ms())
        .unwrap_or(0);
    let (active, target) = state
        .inner
        .lock()
        .ok()
        .and_then(|inner| {
            inner.as_ref().map(|session| {
                (
                    session.segmented && settings.instant_replay_enabled,
                    Some(session.title.clone()),
                )
            })
        })
        .unwrap_or((false, None));
    let save = PathBuf::from(&settings.save_location);
    let disk_free_bytes = crate::disk::free_bytes(&save).ok();
    let disk_blocked = disk_free_bytes
        .map(|free| free < settings.min_free_disk_bytes)
        .unwrap_or(false);
    ReplayStatus {
        enabled: settings.instant_replay_enabled,
        active,
        buffered_ms,
        duration_ms: u64::from(settings.replay_duration_seconds) * 1000,
        target,
        error: state.replay.lock().ok().and_then(|status| status.error.clone()),
        disk_free_bytes,
        disk_blocked,
        saving: state.shared.exporting.load(std::sync::atomic::Ordering::SeqCst),
    }
}

fn chrono_like(unix_secs: u64) -> String {
    unix_secs.to_string()
}
