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
    #[serde(default)]
    pub composed: bool,
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
            composed: false,
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
    /// Settings were saved but have not been applied to the running stream.
    /// Never present pending settings as active.
    pub settings_pending: bool,
    pub bitrate_restart_pending: bool,
    pub restarting: bool,
    pub encoder: Option<crate::ir_runtime::IrEncoderStatus>,
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
            settings_pending: false,
            bitrate_restart_pending: false,
            restarting: false,
            encoder: None,
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
    pub preview: crate::preview::PreviewHub,
    pub ir_encoder: Mutex<Option<crate::ir_runtime::IrEncoderStatus>>,
    pub restarting: AtomicBool,
    /// Last time a WGC frame was accepted into the encode path (IR diagnostics).
    pub last_frame_at: Mutex<Option<Instant>>,
    /// Whether we've already logged a source_no_frames stall for the current gap.
    pub source_stall_logged: AtomicBool,
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
            preview: crate::preview::PreviewHub::new(),
            ir_encoder: Mutex::new(None),
            restarting: AtomicBool::new(false),
            last_frame_at: Mutex::new(None),
            source_stall_logged: AtomicBool::new(false),
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
    /// Serializes capture lifecycle and exports. A quality restart must never
    /// delete paths being read by a save, or race a manual start/stop.
    lifecycle: Mutex<()>,
    inner: Mutex<Option<ActiveRecording>>,
    pub status: Mutex<RecordingStatus>,
    pub replay: Mutex<ReplayStatus>,
    pub shared: Arc<CaptureShared>,
    session_webcam_layout: Mutex<Option<crate::overlay::OverlayLayout>>,
}

impl RecordingState {
    pub fn wgc_session_active(&self) -> bool {
        self.inner.lock().map(|inner| inner.is_some()).unwrap_or(true)
    }

    /// Instant Replay (rolling) session lock — process capture ownership.
    pub fn ir_lock(&self) -> Option<(Option<u32>, Option<String>, String)> {
        self.inner.lock().ok().and_then(|inner| {
            inner.as_ref().and_then(|active| {
                if active.segmented && !active.session {
                    Some((active.pid, active.game_id.clone(), active.title.clone()))
                } else {
                    None
                }
            })
        })
    }

    pub fn set_session_webcam_layout(&self, layout: Option<crate::overlay::OverlayLayout>) {
        if let Ok(mut slot) = self.session_webcam_layout.lock() {
            *slot = layout;
        }
    }
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
    webcam_layout: Option<crate::overlay::OverlayLayout>,
    capture_settings: CaptureSettings,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CaptureSettings {
    resolution: String,
    fps: u32,
    bitrate: crate::recording_bitrate::QualityPreset,
    custom_kbps: u32,
}

impl CaptureSettings {
    fn bitrate_differs(&self, settings: &AppSettings) -> bool {
        let requested = Self::from_settings(settings);
        self.bitrate != requested.bitrate || self.custom_kbps != requested.custom_kbps
    }

    fn from_settings(settings: &AppSettings) -> Self {
        let bitrate = crate::recording_bitrate::QualityPreset::parse(&settings.bitrate);
        Self {
            resolution: settings.resolution.clone(),
            fps: settings.fps.clamp(24, 60),
            bitrate,
            custom_kbps: if bitrate == crate::recording_bitrate::QualityPreset::Custom {
                settings.custom_bitrate_kbps
            } else { 0 },
        }
    }
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
            lifecycle: Mutex::new(()),
            inner: Mutex::new(None),
            status: Mutex::new(RecordingStatus::default()),
            replay: Mutex::new(ReplayStatus::default()),
            shared: Arc::new(CaptureShared::default()),
            session_webcam_layout: Mutex::new(None),
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
        cadence: crate::capture_timing::FrameCadence,
    }

    #[derive(Clone)]
    pub struct SessionFlags {
        pub path: PathBuf,
        pub dir: PathBuf,
        pub width: u32,
        pub height: u32,
        pub bitrate: u32,
        pub fps: u32,
        pub quality_preset: crate::recording_bitrate::QualityPreset,
        pub custom_kbps: u32,
        pub include_audio: bool,
        pub segmented: bool,
        pub min_free_disk_bytes: u64,
        pub shared: Arc<CaptureShared>,
        pub audio_runtime: crate::audio::AudioRuntime,
        pub camera: crate::camera::CameraEngine,
        pub resolution: String,
        pub replay_keep_ms: u64,
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
            if flags.segmented {
                flags.camera.start_rolling(flags.dir.clone(), flags.replay_keep_ms);
            }
            Ok(Self {
                cadence: crate::capture_timing::FrameCadence::new(flags.fps),
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
            // Timestamp before readback, resize, and preview work. Keep the
            // existing SessionClock shared with audio; never rebase on a stall.
            let capture_hns = self.clock.capture_hns();
            if self.flags.segmented && !self.cadence.accept(capture_hns) {
                return Ok(());
            }
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
            if self.flags.shared.preview.should_accept() {
                self.flags.shared.preview.offer(frame.clone());
            }
            self.pump.push(crate::encode_pump::QueuedFrame {
                bgra: frame.bgra,
                pitch: frame.pitch,
                width: frame.width,
                height: frame.height,
                capture_hns,
            });
            if let Ok(mut last) = self.flags.shared.last_frame_at.lock() {
                let was_stalled = self
                    .flags
                    .shared
                    .source_stall_logged
                    .swap(false, Ordering::SeqCst);
                if was_stalled {
                    if let Some(previous) = *last {
                        tracing::info!(
                            duration_ms = previous.elapsed().as_millis() as u64,
                            "source_frames_resumed"
                        );
                    }
                }
                *last = Some(Instant::now());
            }
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

    /// Fixed ladder for legacy (non-segmented) session capture only.
    /// Instant Replay uses `resolve_clip_bitrate` instead.
    fn legacy_session_bitrate(
        preset: crate::recording_bitrate::QualityPreset,
        custom_kbps: u32,
    ) -> u32 {
        match preset {
            crate::recording_bitrate::QualityPreset::Low => 8_000_000,
            crate::recording_bitrate::QualityPreset::High => 25_000_000,
            crate::recording_bitrate::QualityPreset::Custom => {
                custom_kbps.saturating_mul(1000).max(1_000_000)
            }
            crate::recording_bitrate::QualityPreset::Medium => 15_000_000,
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
        webcam_layout: Option<crate::overlay::OverlayLayout>,
    ) -> AppResult<String> {
        let preview = state.shared.last_still.lock().ok().and_then(|slot| slot.clone());
        crate::library::insert(
            app,
            path,
            duration_ms,
            width,
            height,
            fps,
            game_id,
            title,
            preview.as_ref(),
            webcam_layout,
        )
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
        let mut status = replay_status(state, settings);
        status.error = error;
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
        webcam_layout: Option<crate::overlay::OverlayLayout>,
    ) -> AppResult<RecordingStatus> {
        let settings = load_settings(app)?;
        let save = save_dir(app, &settings)?;
        crate::disk::ensure_free_space(&save, settings.min_free_disk_bytes)?;

        let inner = state.inner.lock().map_err(|err| AppError::Message(err.to_string()))?;
        if inner.is_some() {
            return Err(AppError::Message("Capture is already running.".into()));
        }
        drop(inner);
        state.shared.preview.suspend_standalone();
        let mut inner = state.inner.lock().map_err(|err| AppError::Message(err.to_string()))?;
        if inner.is_some() {
            state.shared.preview.resume_if_wanted();
            return Err(AppError::Message("Capture is already running.".into()));
        }
        if let Ok(mut last) = state.shared.last_frame_at.lock() {
            *last = None;
        }
        state.shared.source_stall_logged.store(false, Ordering::SeqCst);

        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let slug = game_id.as_deref().unwrap_or(if session { "recording" } else { "replay" });
        let output = output_path(&save, slug, "mp4");
        let buffer_dir = if segmented {
            match prepare_scratch(app, &save) {
                Ok(dir) => dir,
                Err(err) => {
                    state.shared.preview.resume_if_wanted();
                    return Err(err);
                }
            }
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

        let fps = if segmented {
            settings.fps.clamp(24, 60)
        } else {
            settings.fps.max(15).min(120)
        };
        // Encode pump clamps to 24–60; resolve clip bitrate against that encode FPS.
        let encode_fps = fps.min(60).max(24);
        let quality_preset = crate::recording_bitrate::QualityPreset::parse(&settings.bitrate);
        let custom_kbps = settings.custom_bitrate_kbps;
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
        let make_flags = |width: u32, height: u32| {
            // Instant Replay (segmented) uses the resolution-aware clip ladder.
            // Legacy non-segmented session capture keeps the old fixed presets.
            let bitrate = if segmented {
                crate::recording_bitrate::resolve_clip_bitrate(
                    width,
                    height,
                    encode_fps,
                    quality_preset,
                    custom_kbps,
                )
            } else {
                legacy_session_bitrate(quality_preset, custom_kbps)
            };
            if segmented {
                tracing::info!(
                    width,
                    height,
                    encode_fps,
                    quality_preset = quality_preset.as_str(),
                    resolved_bitrate_bps = bitrate,
                    resolved_bitrate_mbps = format!(
                        "{:.1}",
                        crate::recording_bitrate::bitrate_mbps(bitrate)
                    ),
                    segmented,
                    session,
                    "IR encode bitrate resolved from actual output size"
                );
            }
            SessionFlags {
                path: first_path.clone(),
                dir: buffer_dir.clone(),
                width,
                height,
                bitrate,
                fps,
                quality_preset,
                custom_kbps,
                include_audio,
                segmented,
                min_free_disk_bytes: settings.min_free_disk_bytes,
                shared: state.shared.clone(),
                audio_runtime: audio_runtime.clone(),
                camera: camera.clone(),
                resolution: resolution.clone(),
                replay_keep_ms: u64::from(settings.replay_duration_seconds) * 1000,
            }
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
                    state.shared.preview.resume_if_wanted();
                    return Err(AppError::Message(detail));
                }
            }
        };
        tracing::info!("capture encode size {width}x{height}");
        state.shared.preview.mark_capture_live(true);

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
            composed: false,
        };
        *state.status.lock().map_err(|err| AppError::Message(err.to_string()))? = status.clone();
        *inner = Some(ActiveRecording {
            capture_settings: CaptureSettings::from_settings(&settings),
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
            webcam_layout: if session { webcam_layout } else { None },
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
        let encode_fps = flags.fps.min(60).max(24);
        if flags.segmented {
            flags.bitrate = crate::recording_bitrate::resolve_clip_bitrate(
                width,
                height,
                encode_fps,
                flags.quality_preset,
                flags.custom_kbps,
            );
            tracing::info!(
                width,
                height,
                encode_fps,
                quality_preset = flags.quality_preset.as_str(),
                resolved_bitrate_bps = flags.bitrate,
                resolved_bitrate_mbps = format!(
                    "{:.1}",
                    crate::recording_bitrate::bitrate_mbps(flags.bitrate)
                ),
                "IR monitor encode bitrate resolved from actual output size"
            );
        }
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
        state.shared.preview.mark_capture_live(false);
        if let Ok(mut last) = state.shared.last_frame_at.lock() {
            *last = None;
        }
        state.shared.source_stall_logged.store(false, Ordering::SeqCst);
        Ok(session)
    }

    pub fn start_recording(
        app: &AppHandle,
        state: &RecordingState,
        pid: Option<u32>,
        game_name: Option<String>,
        game_id: Option<String>,
        webcam_layout: Option<crate::overlay::OverlayLayout>,
    ) -> AppResult<RecordingStatus> {
        {
            let mut inner = state.inner.lock().map_err(|err| AppError::Message(err.to_string()))?;
            if let Some(active) = inner.as_mut() {
                if active.session {
                    return Err(AppError::Message("Already recording.".into()));
                }
                if active.segmented {
                    let camera = app.state::<crate::camera::CameraEngine>();
                    let webcam_gen = camera.request_rotate();
                    wait_for_rotate(&state.shared, Duration::from_secs(3));
                    if !camera.wait_for_rotate(webcam_gen, crate::camera::WEBCAM_ROTATE_TIMEOUT) {
                        tracing::warn!("webcam rotate timed out; starting the recording without waiting on the camera");
                    }
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
                    active.webcam_layout = webcam_layout;
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
                        composed: false,
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
        start(
            app,
            state,
            pid,
            game_name,
            game_id,
            settings.instant_replay_enabled,
            true,
            webcam_layout,
        )
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
            let camera = app.state::<crate::camera::CameraEngine>();
            let webcam_gen = camera.request_rotate();
            wait_for_rotate(&state.shared, Duration::from_secs(3));
            if !camera.wait_for_rotate(webcam_gen, crate::camera::WEBCAM_ROTATE_TIMEOUT) {
                tracing::warn!("webcam rotate timed out; saving the recording without the latest webcam segment");
            }
            let (window, concat) = {
                let buffer = state
                    .shared
                    .buffer
                    .lock()
                    .map_err(|err| AppError::Message(err.to_string()))?;
                let mut window = buffer.session_window();
                window.paths.retain(|path| {
                    std::fs::metadata(path).map(|meta| meta.len() > 0).unwrap_or(false)
                });
                buffer.align_window_to_paths(&mut window);
                let concat = buffer.concat_segments(&window);
                (window, concat)
            };
            let paths = window.paths.clone();
            let (output, elapsed, width, height, fps, game_id, title, webcam_layout) = {
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
                    active.webcam_layout.clone(),
                )
            };
            if paths.is_empty() {
                return Err(AppError::Message("Recording did not capture any video yet.".into()));
            }
            let segments: Vec<crate::export::ConcatSegment> = concat
                .into_iter()
                .map(|(path, start_hns, end_hns)| crate::export::ConcatSegment {
                    path,
                    start_hns,
                    end_hns,
                })
                .collect();
            crate::export::concat_mp4s(&segments, &output, window.start_hns).map_err(AppError::Message)?;
            camera.save_overlap_sidecar(&output, window.start_hns, window.end_hns);
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
                webcam_layout,
            )?;
            emit_saved(app, &output, "recording", local_id);
            let status = RecordingStatus {
                active: false,
                path: Some(output.display().to_string()),
                target: Some(title),
                started_at: None,
                duration_ms: elapsed.as_millis() as u64,
                error: None,
                composed: false,
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
            session.webcam_layout,
        )?;
        emit_saved(app, &session.path, "recording", local_id);
        let status = RecordingStatus {
            active: false,
            path: Some(session.path.display().to_string()),
            target: Some(session.title),
            started_at: None,
            duration_ms: elapsed.as_millis() as u64,
            error: None,
            composed: false,
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
        let (running, session, segmented) = {
            let inner = state.inner.lock().map_err(|err| AppError::Message(err.to_string()))?;
            match inner.as_ref() {
                Some(active) => (true, active.session, active.segmented),
                None => (false, false, false),
            }
        };

        if settings.instant_replay_enabled {
            let detected_pid = pid.filter(|id| *id != 0);
            let (running_ir, locked_pid) = {
                let inner = state.inner.lock().map_err(|err| AppError::Message(err.to_string()))?;
                match inner.as_ref() {
                    Some(active) if active.segmented && !active.session => (true, active.pid),
                    _ => (false, None),
                }
            };
            let action = crate::ir_target::resolve_ir_sync(
                running_ir,
                locked_pid,
                detected_pid,
                crate::process::pid_alive,
            );
            match action {
                crate::ir_target::IrSyncAction::KeepLocked { pid: locked } => {
                    if detected_pid.is_some() && detected_pid != locked_pid && locked != 0 {
                        tracing::info!(
                            capture_pid = locked,
                            detected_pid = detected_pid.unwrap_or(0),
                            capture_target_unchanged = true,
                            "IR target locked; ignoring detection retarget"
                        );
                    }
                    note_ir_frame_health(state);
                }
                crate::ir_target::IrSyncAction::StopExited { pid: exited } => {
                    tracing::info!(pid = exited, "IR capture target process exited; stopping buffer");
                    let _ = halt_capture(state);
                    if let Ok(dir) = replay_scratch_dir(app) {
                        discard_scratch(state, &dir);
                    }
                }
                crate::ir_target::IrSyncAction::StartDetected { pid: start_pid } => {
                    tracing::info!(
                        process = %game_name.as_deref().unwrap_or("game"),
                        hwnd_pid = start_pid,
                        "IR target locked"
                    );
                    match start(app, state, Some(start_pid), game_name, game_id, true, false, None) {
                        Ok(_) => {}
                        Err(err) => {
                            publish_replay(app, state, &settings, Some(err.to_string()));
                            return Ok(replay_status(state, &settings));
                        }
                    }
                }
                crate::ir_target::IrSyncAction::Idle => {
                    if let Ok(dir) = replay_scratch_dir(app) {
                        discard_scratch(state, &dir);
                    }
                }
            }
        } else if running && segmented && !session {
            let _ = halt_capture(state);
            if let Ok(dir) = replay_scratch_dir(app) {
                discard_scratch(state, &dir);
            }
        }

        apply_pending_bitrate(app, state)?;
        publish_replay(app, state, &settings, None);
        Ok(replay_status(state, &settings))
    }

    fn note_ir_frame_health(state: &RecordingState) {
        let Ok(last) = state.shared.last_frame_at.lock() else {
            return;
        };
        let Some(at) = *last else {
            return;
        };
        let gap = at.elapsed();
        if gap < Duration::from_secs(2) {
            return;
        }
        if state
            .shared
            .source_stall_logged
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            tracing::info!(
                duration_ms = gap.as_millis() as u64,
                "source_no_frames"
            );
        }
    }

    /// Called only while the outer lifecycle lock is held. A fresh writer and
    /// empty buffer avoid mixing old settings / codec configuration into clips.
    pub fn apply_pending_bitrate(app: &AppHandle, state: &RecordingState) -> AppResult<()> {
        let settings = load_settings(app)?;
        let target = state.inner.lock().ok().and_then(|inner| {
            inner.as_ref().filter(|active|
                crate::ir_runtime::should_restart_for_bitrate(
                    settings.instant_replay_enabled, active.segmented, active.session,
                    active.capture_settings.bitrate_differs(&settings),
                )
            ).map(|active| (active.pid, active.title.clone(), active.game_id.clone()))
        });
        let Some((pid, name, game_id)) = target else { return Ok(()); };
        if state.shared.buffer.lock().map(|buffer| buffer.has_retained_frames()).unwrap_or(true) {
            let error = AppError::Message("Bitrate restart is pending: recording footage is still retained by an unfinished save. Resolve the save before restarting Instant Replay.".into());
            publish_replay(app, state, &settings, Some(error.to_string()));
            return Err(error);
        }
        // Keep the current buffer intact if preflight already proves restart
        // cannot succeed. Only rolling scratch is cleared by start(), never
        // saved clips or the user's library.
        let save = save_dir(app, &settings)?;
        if let Err(error) = crate::disk::ensure_free_space(&save, settings.min_free_disk_bytes) {
            publish_replay(app, state, &settings, Some(error.to_string()));
            return Err(error);
        }
        state.shared.restarting.store(true, Ordering::SeqCst);
        publish_replay(app, state, &settings, None);
        let result = halt_capture(state).and_then(|_| {
            start(app, state, pid, Some(name), game_id, true, false, None).map(|_| ())
        });
        state.shared.restarting.store(false, Ordering::SeqCst);
        match &result {
            Ok(()) => {
                tracing::info!("IR bitrate change applied by restarting the rolling buffer");
                let _ = app.emit("replay-bitrate-applied", ());
                publish_replay(app, state, &settings, None);
            }
            Err(error) => {
                tracing::error!(%error, "IR bitrate restart failed");
                publish_replay(app, state, &settings, Some(format!("Instant Replay could not restart with the new bitrate: {error}")));
            }
        }
        result
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
        let camera = app.state::<crate::camera::CameraEngine>();
        let webcam_gen = camera.request_rotate();
        wait_for_rotate(&state.shared, Duration::from_millis(400));
        if !camera.wait_for_rotate(webcam_gen, crate::camera::WEBCAM_ROTATE_TIMEOUT) {
            tracing::warn!("webcam rotate timed out; saving the gameplay clip without the latest webcam segment");
        }
        let duration_ms = u64::from(settings.replay_duration_seconds) * 1000;
        let (window, concat) = {
            let mut buffer = state.shared.buffer.lock().map_err(|err| AppError::Message(err.to_string()))?;
            if buffer.total_ms() < 400 {
                buffer.unlock_all();
                return Err(AppError::Message("Replay buffer is still filling.".into()));
            }
            let mut window = buffer.clip_window(duration_ms);
            window.paths.retain(|path| std::fs::metadata(path).map(|meta| meta.len() > 0).unwrap_or(false));
            buffer.align_window_to_paths(&mut window);
            let concat = buffer.concat_segments(&window);
            (window, concat)
        };
        if window.paths.is_empty() {
            return Err(AppError::Message("Replay buffer is still filling.".into()));
        }
        let output = output_path(&save, "clip", "mp4");
        let segments: Vec<crate::export::ConcatSegment> = concat
            .into_iter()
            .map(|(path, start_hns, end_hns)| crate::export::ConcatSegment {
                path,
                start_hns,
                end_hns,
            })
            .collect();
        let result = crate::export::concat_mp4s(&segments, &output, window.start_hns);
        if let Ok(mut buffer) = state.shared.buffer.lock() {
            buffer.unlock_all();
        }
        if let Err(err) = result {
            let _ = std::fs::remove_file(&output);
            return Err(AppError::Message(err));
        }
        camera.save_overlap_sidecar(&output, window.start_hns, window.end_hns);
        let clip_ms = window.duration_ms();
        tracing::info!(
            session_window_duration_hns = window.duration_hns(),
            saved_duration_ms = clip_ms,
            segments = window.paths.len(),
            "instant replay clip duration from session window"
        );
        let local_id = insert_local_clip(
            app,
            state,
            &output,
            clip_ms,
            width,
            height,
            fps,
            game_id,
            format!("{title} clip"),
            None,
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
            None,
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
        _webcam_layout: Option<crate::overlay::OverlayLayout>,
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
    webcam_layout: Option<crate::overlay::OverlayLayout>,
) -> AppResult<RecordingStatus> {
    let _lifecycle = state.lifecycle.lock().map_err(|e| AppError::Message(e.to_string()))?;
    let webcam_layout = match webcam_layout {
        Some(layout) => {
            state.set_session_webcam_layout(Some(layout.clone()));
            Some(layout)
        }
        None => state
            .session_webcam_layout
            .lock()
            .ok()
            .and_then(|slot| slot.clone()),
    };
    windows_impl::start_recording(app, state, pid, game_name, game_id, webcam_layout)
}

pub fn stop(app: &AppHandle, state: &RecordingState) -> AppResult<RecordingStatus> {
    let _lifecycle = state.lifecycle.lock().map_err(|e| AppError::Message(e.to_string()))?;
    let result = windows_impl::stop_recording(app, state);
    #[cfg(windows)]
    if result.is_ok() {
        // A preset changed during a manual session is applied only after the
        // session has been finalized and saved successfully.
        if let Err(error) = windows_impl::apply_pending_bitrate(app, state) {
            tracing::warn!(%error, "IR bitrate restart after saved recording failed");
        }
    }
    result
}

pub fn save_clip(app: &AppHandle, state: &RecordingState) -> AppResult<String> {
    // Preserve duplicate-save rejection rather than queueing multiple hotkeys.
    let _lifecycle = state.lifecycle.try_lock()
        .map_err(|_| AppError::Message("Capture is busy saving or restarting. Try saving the clip again shortly.".into()))?;
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
    let _lifecycle = state.lifecycle.lock().map_err(|e| AppError::Message(e.to_string()))?;
    windows_impl::sync_replay(app, state, pid, game_name, game_id)
}

/// Settings work can wait behind an export. Resolve the game after that wait
/// instead of restarting capture against an old detection snapshot.
pub fn sync_replay_after_settings(app: &AppHandle, state: &RecordingState) -> AppResult<ReplayStatus> {
    let _lifecycle = state.lifecycle.lock().map_err(|e| AppError::Message(e.to_string()))?;
    let detection = app.state::<crate::detection::DetectionState>();
    let snapshot = crate::detection::current_snapshot(&detection);
    windows_impl::sync_replay(app, state, snapshot.pid, snapshot.name, snapshot.slug)
}

pub fn retain_preview(state: &RecordingState, mode: &str, pid: Option<u32>, monitor_id: Option<String>) {
    state.shared.preview.retain(
        crate::preview::PreviewMode::parse(mode),
        pid.filter(|value| *value != 0),
        monitor_id,
    );
}

pub fn release_preview(state: &RecordingState) {
    state.shared.preview.release();
}

pub fn preview_frame(state: &RecordingState) -> crate::preview::CapturePreviewFrame {
    state.shared.preview.snapshot()
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
    let mut encoder = state.shared.ir_encoder.lock().ok().and_then(|status| status.clone());
    if let Some(encoder) = encoder.as_mut() {
        encoder.request(crate::recording_bitrate::resolve_clip_bitrate(
            encoder.width, encoder.height, encoder.fps,
            crate::recording_bitrate::QualityPreset::parse(&settings.bitrate), settings.custom_bitrate_kbps,
        ));
    }
    let buffered_ms = state
        .shared
        .buffer
        .lock()
        .map(|buffer| buffer.total_ms())
        .unwrap_or(0);
    let (active, target, settings_pending, bitrate_restart_pending) = state
        .inner
        .lock()
        .ok()
        .and_then(|inner| {
            inner.as_ref().map(|session| {
                (
                    session.segmented && settings.instant_replay_enabled,
                    Some(session.title.clone()),
                    session.capture_settings != CaptureSettings::from_settings(settings),
                    session.capture_settings.bitrate_differs(settings),
                )
            })
        })
        .unwrap_or((false, None, false, false));
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
        settings_pending: active && settings_pending,
        bitrate_restart_pending: active && bitrate_restart_pending,
        restarting: state.shared.restarting.load(Ordering::SeqCst),
        encoder: if active { encoder } else { None },
    }
}

fn chrono_like(unix_secs: u64) -> String {
    unix_secs.to_string()
}

#[cfg(test)]
mod capture_settings_tests {
    use super::*;

    #[test]
    fn running_snapshot_detects_quality_changes_and_reverting_clears_pending() {
        let mut settings = AppSettings::default();
        settings.bitrate = "medium".into();
        let running = CaptureSettings::from_settings(&settings);
        settings.bitrate = "high".into();
        assert_ne!(running, CaptureSettings::from_settings(&settings));
        settings.bitrate = "medium".into();
        assert_eq!(running, CaptureSettings::from_settings(&settings));
        settings.custom_bitrate_kbps += 1_000;
        assert_eq!(running, CaptureSettings::from_settings(&settings));
        settings.resolution = "720p".into();
        assert_ne!(running, CaptureSettings::from_settings(&settings));
        assert!(!running.bitrate_differs(&settings), "format changes alone do not clear the buffer");
        settings.bitrate = "custom".into();
        settings.custom_bitrate_kbps = 50_000;
        assert!(running.bitrate_differs(&settings));
        let custom = CaptureSettings::from_settings(&settings);
        settings.custom_bitrate_kbps = 42_000;
        assert!(custom.bitrate_differs(&settings));
    }
}
