use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::settings::WebcamSettings;

use super::clock::{webcam_sidecar_path, SegmentHealth, SessionClock};
use super::format::{estimated_mb_per_minute, pick_camera_mode, webcam_bitrate_bps, RequestedMode};
use super::ring::{RotateAck, WebcamBuffer};
use super::types::{
    CameraAvailability, CameraDeviceInfo, CameraStatus, PreviewFrame, PreviewRequest,
};

const WATCH_INTERVAL: Duration = Duration::from_secs(2);
#[cfg(windows)]
const LIST_TIMEOUT: Duration = Duration::from_secs(4);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraStatusEvent {
    pub status: CameraStatus,
}

#[derive(Clone)]
pub struct CameraEngine {
    inner: Arc<Inner>,
}

struct Inner {
    app: Mutex<Option<AppHandle>>,
    status: Mutex<CameraStatus>,
    selected_id: Mutex<String>,
    selected_name: Mutex<String>,
    enabled: AtomicBool,
    watch: AtomicBool,
    #[cfg(windows)]
    preview: Mutex<Option<super::preview::PreviewSession>>,
    #[cfg(windows)]
    record: Mutex<Option<super::record::RecordSession>>,
    #[cfg(windows)]
    rolling: Mutex<Option<super::roll::RollingSession>>,
    session_lock: Mutex<()>,
    cached_modes: Mutex<Option<(String, Vec<super::format::CameraMode>)>>,
    stop_watch: AtomicBool,
    watch_thread: Mutex<Option<JoinHandle<()>>>,
    wake: Condvar,
    wake_lock: Mutex<()>,
    session_clock: Mutex<Option<SessionClock>>,
    rotate: Arc<RotateAck>,
    webcam_buffer: Arc<Mutex<WebcamBuffer>>,
    scratch_dir: Mutex<Option<PathBuf>>,
    #[cfg_attr(not(windows), allow(dead_code))]
    replay_keep_ms: AtomicU64,
    mirror_recording: AtomicBool,
}

impl Default for CameraEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl CameraEngine {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Inner {
                app: Mutex::new(None),
                status: Mutex::new(CameraStatus::idle()),
                selected_id: Mutex::new(String::new()),
                selected_name: Mutex::new(String::new()),
                enabled: AtomicBool::new(false),
                watch: AtomicBool::new(false),
                #[cfg(windows)]
                preview: Mutex::new(None),
                #[cfg(windows)]
                record: Mutex::new(None),
                #[cfg(windows)]
                rolling: Mutex::new(None),
                session_lock: Mutex::new(()),
                cached_modes: Mutex::new(None),
                stop_watch: AtomicBool::new(false),
                watch_thread: Mutex::new(None),
                wake: Condvar::new(),
                wake_lock: Mutex::new(()),
                session_clock: Mutex::new(None),
                rotate: Arc::new(RotateAck::default()),
                webcam_buffer: Arc::new(Mutex::new(WebcamBuffer::new(60_000))),
                scratch_dir: Mutex::new(None),
                replay_keep_ms: AtomicU64::new(60_000),
                mirror_recording: AtomicBool::new(false),
            }),
        }
    }

    pub fn bind(&self, app: AppHandle) {
        if let Ok(mut slot) = self.inner.app.lock() {
            *slot = Some(app);
        }
        self.ensure_watch_thread();
    }

    pub fn list_devices(&self) -> Result<Vec<CameraDeviceInfo>, String> {
        list_devices_off_ui()
    }

    pub fn list_modes(&self, device_id: &str) -> Result<Vec<super::format::CameraMode>, String> {
        let id = super::types::sanitize_device_id(device_id)?;
        if id.is_empty() {
            return Ok(Vec::new());
        }
        let _session = self.inner.session_lock.lock().map_err(|err| err.to_string())?;
        if let Ok(cache) = self.inner.cached_modes.lock() {
            if let Some((cached_id, modes)) = cache.as_ref() {
                if cached_id == &id {
                    return Ok(modes.clone());
                }
            }
        }
        let modes = list_modes_off_ui(&id)?;
        if let Ok(mut cache) = self.inner.cached_modes.lock() {
            *cache = Some((id, modes.clone()));
        }
        Ok(modes)
    }

    pub fn status(&self) -> CameraStatus {
        #[cfg(not(windows))]
        {
            let mut status = CameraStatus::unsupported();
            status.enabled = self.inner.enabled.load(Ordering::SeqCst);
            status.device_id = self.inner.selected_id.lock().map(|id| id.clone()).unwrap_or_default();
            status.device_name = self.inner.selected_name.lock().map(|name| name.clone()).unwrap_or_default();
            apply_session_clock(&self.inner, &mut status);
            status
        }
        #[cfg(windows)]
        {
            let mut status = self.inner.status.lock().map(|guard| guard.clone()).unwrap_or_else(|_| CameraStatus::idle());
            if let Ok(preview) = self.inner.preview.lock() {
                if let Some(session) = preview.as_ref() {
                    if let Some(negotiated) = session.negotiated() {
                        super::types::apply_negotiated(&mut status, &negotiated);
                        status.estimated_mb_per_minute = estimated_mb_per_minute(webcam_bitrate_bps(
                            negotiated.mode.width,
                            negotiated.mode.height,
                            negotiated.mode.fps,
                        ));
                    }
                    status.timestamp_fallback = session.timestamp_fallback();
                    if let Some(err) = session.error() {
                        status.availability = CameraAvailability::Failed;
                        status.message = err;
                    } else if status.availability != CameraAvailability::Disconnected
                        && status.availability != CameraAvailability::PermissionDenied
                        && status.availability != CameraAvailability::Recording
                    {
                        status.availability = CameraAvailability::Previewing;
                    }
                }
            }
            if let Ok(record) = self.inner.record.lock() {
                if let Some(session) = record.as_ref() {
                    apply_record_snapshot(&mut status, &session.snapshot());
                }
            }
            status.rolling = false;
            if let Ok(rolling) = self.inner.rolling.lock() {
                if let Some(session) = rolling.as_ref() {
                    let snap = session.snapshot();
                    status.rolling = !session.finished();
                    // Instant Replay rolling must not look like a settings "test record".
                    // That made the UI show "Stop test recording" and refuse preview.
                    if status.rolling {
                        status.encoder_name = snap.encoder_name;
                        status.encoder_hardware = snap.encoder_hardware;
                        status.software_fallback = snap.software_fallback;
                        status.dropped_frames = snap.dropped_frames;
                        status.written_frames = snap.written_frames;
                        status.timestamp_fallback = snap.timestamp_fallback;
                        status.session_skew_ms = snap.session_skew_hns / 10_000;
                        if recording(&self.inner) {
                            // Rare: test record and IR should not overlap, but keep test state.
                        } else {
                            status.recording = false;
                            if status.availability == CameraAvailability::Recording {
                                status.availability = if status.enabled {
                                    CameraAvailability::Ready
                                } else {
                                    CameraAvailability::Idle
                                };
                            }
                            if status.message.is_empty() {
                                status.message = "Recording with Instant Replay".into();
                            }
                        }
                    }
                }
            }
            status.enabled = self.inner.enabled.load(Ordering::SeqCst);
            apply_session_clock(&self.inner, &mut status);
            status
        }
    }

    pub fn begin_session(&self, clock: SessionClock) {
        tracing::info!(
            qpc_origin_hns = clock.qpc_origin_hns(),
            "camera bound to capture SessionClock"
        );
        if let Ok(mut slot) = self.inner.session_clock.lock() {
            *slot = Some(clock);
        }
    }

    pub fn end_session(&self) {
        stop_rolling_session(&self.inner);
        if let Ok(mut slot) = self.inner.session_clock.lock() {
            if slot.take().is_some() {
                tracing::info!("camera unbound from capture SessionClock");
            }
        }
        if let Ok(mut scratch) = self.inner.scratch_dir.lock() {
            *scratch = None;
        }
        if let Ok(mut buffer) = self.inner.webcam_buffer.lock() {
            buffer.clear(false);
        }
        self.inner.rotate.ack();
    }

    pub fn session_clock(&self) -> Option<SessionClock> {
        self.inner.session_clock.lock().ok().and_then(|guard| *guard)
    }

    #[cfg_attr(not(windows), allow(dead_code))]
    pub fn start_rolling(&self, scratch: PathBuf, keep_ms: u64) {
        self.inner.replay_keep_ms.store(keep_ms.max(1_000), Ordering::SeqCst);
        if let Ok(mut slot) = self.inner.scratch_dir.lock() {
            *slot = Some(scratch.clone());
        }
        if let Ok(mut buffer) = self.inner.webcam_buffer.lock() {
            buffer.set_max_keep_ms(keep_ms);
        }
        start_rolling_inner(&self.inner, scratch);
    }

    pub fn request_rotate(&self) -> u64 {
        let generation = self.inner.rotate.generation();
        if rolling(&self.inner) {
            self.inner.rotate.request();
        }
        generation
    }

    pub fn wait_for_rotate(&self, start_gen: u64, timeout: Duration) -> bool {
        if !rolling(&self.inner) {
            return true;
        }
        self.inner.rotate.wait_since(start_gen, timeout)
    }

    /// Best-effort sidecar remux. Never returns an error to gameplay save.
    pub fn save_overlap_sidecar(&self, clip: &Path, start_hns: i64, end_hns: i64) {
        let output = webcam_sidecar_path(clip);
        match remux_overlap_inner(&self.inner, start_hns, end_hns, &output) {
            Ok(Some(path)) => {
                tracing::info!(path = %path.display(), "saved overlapping webcam sidecar");
            }
            Ok(None) => {
                tracing::info!(
                    start_hns,
                    end_hns,
                    "no overlapping webcam for this clip"
                );
            }
            Err(err) => {
                tracing::warn!(%err, "webcam sidecar skipped; gameplay clip is intact");
                let _ = std::fs::remove_file(&output);
            }
        }
    }

    pub fn configure(&self, webcam: &WebcamSettings) {
        self.inner.enabled.store(webcam.enabled, Ordering::SeqCst);
        if let Ok(mut id) = self.inner.selected_id.lock() {
            *id = webcam.device_id.clone();
        }
        if let Ok(mut name) = self.inner.selected_name.lock() {
            *name = webcam.display_name();
        }
        if let Ok(mut status) = self.inner.status.lock() {
            status.enabled = webcam.enabled;
            status.device_id = webcam.device_id.clone();
            status.device_name = webcam.display_name();
            status.width = webcam.width;
            status.height = webcam.height;
            status.fps = webcam.fps;
            status.estimated_mb_per_minute =
                estimated_mb_per_minute(webcam_bitrate_bps(webcam.width, webcam.height, webcam.fps));
        }
        self.inner.mirror_recording.store(webcam.mirror_recording, Ordering::SeqCst);
        if let Ok(mut cache) = self.inner.cached_modes.lock() {
            if cache.as_ref().is_some_and(|(id, _)| id != &webcam.device_id) {
                *cache = None;
            }
        }
        // Preview is owned by the settings card. Do not tear it down when the
        // recording toggle is off — that would close the camera mid-configure.
        let watching = webcam.enabled || previewing(&self.inner) || recording(&self.inner) || rolling(&self.inner);
        self.inner.watch.store(watching, Ordering::SeqCst);
        if watching {
            self.ensure_watch_thread();
            self.wake_watch();
        } else {
            self.publish_idle_if_disabled();
        }
        if self.session_clock().is_some() {
            if webcam.enabled {
                if let Ok(scratch) = self.inner.scratch_dir.lock() {
                    if let Some(dir) = scratch.clone() {
                        drop(scratch);
                        start_rolling_inner(&self.inner, dir);
                    }
                }
            } else {
                stop_rolling_session(&self.inner);
            }
        }
    }

    pub fn start_preview(&self, request: PreviewRequest) -> Result<CameraStatus, String> {
        let request = request.sanitize()?;
        #[cfg(not(windows))]
        {
            let _ = request;
            return Err("Camera capture is available on Windows.".into());
        }
        #[cfg(windows)]
        {
            let _session = self.inner.session_lock.lock().map_err(|err| err.to_string())?;
            if recording(&self.inner) {
                return Err("Stop the webcam test recording first.".into());
            }
            if rolling(&self.inner) {
                return Err("Webcam is recording with Instant Replay.".into());
            }
            let request = request;
            let devices = list_devices_off_ui()?;
            let Some(device) = devices.iter().find(|item| item.id == request.device_id) else {
                self.mark_disconnected("Camera disconnected");
                return Err("Camera disconnected".into());
            };
            if let Ok(mut name) = self.inner.selected_name.lock() {
                *name = device.name.clone();
            }
            if let Ok(mut id) = self.inner.selected_id.lock() {
                *id = request.device_id.clone();
            }
            stop_preview_session(&self.inner);
            let origin = self.session_clock().map(|clock| clock.qpc_origin_hns());
            let session = super::preview::PreviewSession::start(request, origin).map_err(|err| {
                let message = crate::camera::device::permission_message(&err);
                self.mark_failed(&message);
                message
            })?;
            if let Ok(mut slot) = self.inner.preview.lock() {
                *slot = Some(session);
            }
            self.inner.watch.store(true, Ordering::SeqCst);
            self.ensure_watch_thread();
            self.wake_watch();
            Ok(self.status())
        }
    }

    pub fn stop_preview(&self) {
        let Ok(_session) = self.inner.session_lock.lock() else {
            return;
        };
        stop_preview_session(&self.inner);
        if !self.inner.enabled.load(Ordering::SeqCst) {
            self.inner.watch.store(false, Ordering::SeqCst);
            self.publish_idle_if_disabled();
        }
    }

    pub fn latest_preview(&self) -> Option<PreviewFrame> {
        #[cfg(windows)]
        {
            self.inner
                .preview
                .lock()
                .ok()
                .and_then(|guard| guard.as_ref().and_then(super::preview::PreviewSession::latest))
        }
        #[cfg(not(windows))]
        {
            None
        }
    }

    pub fn start_test_record(
        &self,
        device_id: String,
        width: u32,
        height: u32,
        fps: u32,
        mirror: bool,
        path: std::path::PathBuf,
    ) -> Result<CameraStatus, String> {
        #[cfg(not(windows))]
        {
            let _ = (device_id, width, height, fps, mirror, path);
            return Err("Camera capture is available on Windows.".into());
        }
        #[cfg(windows)]
        {
            let _session = self.inner.session_lock.lock().map_err(|err| err.to_string())?;
            if recording(&self.inner) {
                return Err("A webcam test recording is already running.".into());
            }
            if rolling(&self.inner) {
                return Err("Webcam is recording with Instant Replay.".into());
            }
            let devices = list_devices_off_ui()?;
            let Some(device) = devices.iter().find(|item| item.id == device_id) else {
                self.mark_disconnected("Camera disconnected");
                return Err("Camera disconnected".into());
            };
            if let Ok(mut name) = self.inner.selected_name.lock() {
                *name = device.name.clone();
            }
            if let Ok(mut id) = self.inner.selected_id.lock() {
                *id = device_id.clone();
            }
            stop_preview_session(&self.inner);
            let bitrate = webcam_bitrate_bps(width, height, fps);
            let session = super::record::RecordSession::start(super::record::RecordRequest {
                device_id,
                width,
                height,
                fps,
                mirror,
                bitrate,
                path,
                max_duration: std::time::Duration::from_secs(u64::from(super::safety::TEST_RECORD_SECONDS)),
                session_origin_hns: self.session_clock().map(|clock| clock.qpc_origin_hns()),
            })
            .map_err(|err| {
                let message = crate::camera::device::permission_message(&err);
                self.mark_failed(&message);
                message
            })?;
            if let Ok(mut slot) = self.inner.record.lock() {
                *slot = Some(session);
            }
            self.inner.watch.store(true, Ordering::SeqCst);
            self.ensure_watch_thread();
            self.wake_watch();
            Ok(self.status())
        }
    }

    pub fn stop_test_record(&self) -> CameraStatus {
        let Ok(_session) = self.inner.session_lock.lock() else {
            return self.status();
        };
        stop_record_session(&self.inner);
        if !self.inner.enabled.load(Ordering::SeqCst) {
            self.inner.watch.store(previewing(&self.inner), Ordering::SeqCst);
        }
        self.status()
    }

    #[cfg(windows)]
    fn mark_disconnected(&self, message: &str) {
        let mut status = self.status_snapshot();
        status.availability = CameraAvailability::Disconnected;
        status.message = message.into();
        self.publish(status);
    }

    #[cfg(windows)]
    fn mark_failed(&self, message: &str) {
        let mut status = self.status_snapshot();
        let permission = message.to_ascii_lowercase().contains("privacy")
            || message.to_ascii_lowercase().contains("blocked");
        status.availability = if permission {
            CameraAvailability::PermissionDenied
        } else {
            CameraAvailability::Failed
        };
        status.message = message.into();
        self.publish(status);
    }

    fn publish_idle_if_disabled(&self) {
        if self.inner.enabled.load(Ordering::SeqCst) {
            return;
        }
        let mut status = CameraStatus::idle();
        status.device_id = self.inner.selected_id.lock().map(|id| id.clone()).unwrap_or_default();
        status.device_name = self.inner.selected_name.lock().map(|name| name.clone()).unwrap_or_default();
        self.publish(status);
    }

    #[cfg(windows)]
    fn status_snapshot(&self) -> CameraStatus {
        self.inner
            .status
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_else(|_| CameraStatus::idle())
    }

    fn publish(&self, status: CameraStatus) {
        if let Ok(mut slot) = self.inner.status.lock() {
            *slot = status.clone();
        }
        if let Ok(app) = self.inner.app.lock() {
            if let Some(app) = app.as_ref() {
                let _ = app.emit("camera-status", CameraStatusEvent { status });
            }
        }
    }

    fn ensure_watch_thread(&self) {
        if self.inner.stop_watch.load(Ordering::SeqCst) {
            return;
        }
        let mut thread = match self.inner.watch_thread.lock() {
            Ok(guard) => guard,
            Err(_) => return,
        };
        if thread.as_ref().is_some_and(|handle| !handle.is_finished()) {
            return;
        }
        let inner = Arc::clone(&self.inner);
        let handle = std::thread::Builder::new()
            .name("camera-watch".into())
            .spawn(move || watch_loop(inner))
            .ok();
        *thread = handle;
    }

    fn wake_watch(&self) {
        self.inner.wake.notify_all();
    }
}

fn watch_loop(inner: Arc<Inner>) {
    while !inner.stop_watch.load(Ordering::SeqCst) {
        if inner.watch.load(Ordering::SeqCst) {
            harvest_finished_record(inner.as_ref());
            harvest_finished_rolling(inner.as_ref());
            refresh_device_presence(&inner);
        }
        let Ok(lock) = inner.wake_lock.lock() else {
            break;
        };
        let _ = inner.wake.wait_timeout(lock, WATCH_INTERVAL);
    }
}

fn refresh_device_presence(inner: &Inner) {
    let _ = publish_preview_error(inner);
    let selected = inner.selected_id.lock().map(|id| id.clone()).unwrap_or_default();
    if selected.is_empty() {
        return;
    }
    let devices = match list_devices_off_ui() {
        Ok(devices) => devices,
        Err(err) => {
            tracing::debug!("camera watch list failed: {err}");
            return;
        }
    };
    let connected = devices.iter().find(|device| device.id == selected);
    let mut status = inner
        .status
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or_else(|_| CameraStatus::idle());
    status.enabled = inner.enabled.load(Ordering::SeqCst);
    match connected {
        Some(device) => {
            status.device_name = device.name.clone();
            if status.availability == CameraAvailability::Disconnected {
                status.availability = if previewing(inner) {
                    CameraAvailability::Previewing
                } else {
                    CameraAvailability::Ready
                };
                status.message = String::new();
                publish_inner(inner, status);
            } else if status.availability == CameraAvailability::Idle && status.enabled {
                status.availability = CameraAvailability::Ready;
                publish_inner(inner, status);
            }
        }
        None => {
            if status.availability != CameraAvailability::Disconnected {
                tracing::warn!(device_id = %selected, "selected camera disconnected");
                status.availability = CameraAvailability::Disconnected;
                status.message = "Camera disconnected".into();
                publish_inner(inner, status);
                if let Ok(_session) = inner.session_lock.lock() {
                    stop_preview_session(inner);
                    stop_record_session(inner);
                    stop_rolling_session(inner);
                }
                if let Ok(mut cache) = inner.cached_modes.lock() {
                    *cache = None;
                }
            }
        }
    }
}

fn publish_preview_error(inner: &Inner) -> bool {
    #[cfg(windows)]
    {
        let err = inner
            .preview
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().and_then(super::preview::PreviewSession::error));
        let Some(err) = err else {
            return false;
        };
        let mut status = inner
            .status
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_else(|_| CameraStatus::idle());
        if status.availability == CameraAvailability::Failed
            || status.availability == CameraAvailability::PermissionDenied
        {
            return false;
        }
        let permission = err.to_ascii_lowercase().contains("privacy")
            || err.to_ascii_lowercase().contains("blocked");
        status.availability = if permission {
            CameraAvailability::PermissionDenied
        } else {
            CameraAvailability::Failed
        };
        status.message = err;
        publish_inner(inner, status);
        true
    }
    #[cfg(not(windows))]
    {
        let _ = inner;
        false
    }
}

fn harvest_finished_record(inner: &Inner) {
    #[cfg(windows)]
    {
        let finished = inner
            .record
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().map(super::record::RecordSession::finished))
            .unwrap_or(false);
        if !finished {
            return;
        }
        let Ok(_session) = inner.session_lock.lock() else {
            return;
        };
        stop_record_session(inner);
    }
    #[cfg(not(windows))]
    {
        let _ = inner;
    }
}

#[cfg(windows)]
fn apply_record_snapshot(status: &mut CameraStatus, snapshot: &super::record::RecordSnapshot) {
    status.recording = snapshot.recording;
    status.encoder_name = snapshot.encoder_name.clone();
    status.encoder_hardware = snapshot.encoder_hardware;
    status.software_fallback = snapshot.software_fallback;
    status.dropped_frames = snapshot.dropped_frames;
    status.written_frames = snapshot.written_frames;
    status.test_path = snapshot.path.clone();
    if !snapshot.message.is_empty() {
        status.message = snapshot.message.clone();
    }
    if snapshot.recording {
        status.availability = CameraAvailability::Recording;
    }
    status.timestamp_fallback = snapshot.timestamp_fallback;
    status.session_skew_ms = snapshot.session_skew_hns / 10_000;
    if snapshot.native_subtype.is_some() {
        status.native_subtype = snapshot.native_subtype;
        status.reader_subtype = snapshot.reader_subtype;
        status.conversion_path = snapshot.conversion_path;
        if snapshot.width > 0 {
            status.width = snapshot.width;
            status.height = snapshot.height;
            status.fps = snapshot.fps;
        }
    }
}

fn rolling(inner: &Inner) -> bool {
    #[cfg(windows)]
    {
        inner
            .rolling
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().map(|session| !session.finished()))
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        let _ = inner;
        false
    }
}

fn start_rolling_inner(inner: &Inner, scratch: PathBuf) {
    #[cfg(windows)]
    {
        if !inner.enabled.load(Ordering::SeqCst) {
            return;
        }
        if recording(inner) || rolling(inner) {
            return;
        }
        let Some(clock) = inner.session_clock.lock().ok().and_then(|guard| *guard) else {
            return;
        };
        let device_id = inner.selected_id.lock().map(|id| id.clone()).unwrap_or_default();
        if device_id.is_empty() {
            tracing::info!("webcam enabled but no device selected; Instant Replay continues without it");
            return;
        }
        let Ok(_session) = inner.session_lock.lock() else {
            return;
        };
        if recording(inner) || rolling(inner) {
            return;
        }
        stop_preview_session(inner);
        let status = inner
            .status
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_else(|_| CameraStatus::idle());
        let dir = super::roll::prepare_webcam_dir(&scratch);
        let keep_ms = inner.replay_keep_ms.load(Ordering::SeqCst);
        if let Ok(mut buffer) = inner.webcam_buffer.lock() {
            buffer.set_max_keep_ms(keep_ms);
        }
        match super::roll::RollingSession::start(super::roll::RollingRequest {
            device_id,
            width: status.width.max(320),
            height: status.height.max(240),
            fps: status.fps.max(24),
            mirror: inner.mirror_recording.load(Ordering::SeqCst),
            bitrate: webcam_bitrate_bps(status.width.max(320), status.height.max(240), status.fps.max(24)),
            dir,
            session_origin_hns: clock.qpc_origin_hns(),
            rotate: Arc::clone(&inner.rotate),
            buffer: Arc::clone(&inner.webcam_buffer),
        }) {
            Ok(session) => {
                if let Ok(mut slot) = inner.rolling.lock() {
                    *slot = Some(session);
                }
                inner.watch.store(true, Ordering::SeqCst);
                tracing::info!("webcam rolling segments started");
            }
            Err(err) => {
                tracing::warn!(%err, "webcam rolling did not start; gameplay capture continues");
                let mut failed = status;
                failed.availability = CameraAvailability::Failed;
                failed.message = crate::camera::device::permission_message(&err);
                publish_inner(inner, failed);
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (inner, scratch);
    }
}

fn stop_rolling_session(inner: &Inner) {
    #[cfg(windows)]
    {
        if let Ok(mut slot) = inner.rolling.lock() {
            if let Some(session) = slot.take() {
                let _ = session.stop();
            }
        }
        inner.rotate.ack();
    }
    #[cfg(not(windows))]
    {
        let _ = inner;
    }
}

fn harvest_finished_rolling(inner: &Inner) {
    #[cfg(windows)]
    {
        let finished = inner
            .rolling
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().map(super::roll::RollingSession::finished))
            .unwrap_or(false);
        if !finished {
            return;
        }
        let Ok(_session) = inner.session_lock.lock() else {
            return;
        };
        if let Ok(mut slot) = inner.rolling.lock() {
            if let Some(session) = slot.take() {
                let snapshot = session.stop();
                if !snapshot.message.is_empty() {
                    let mut status = inner
                        .status
                        .lock()
                        .map(|guard| guard.clone())
                        .unwrap_or_else(|_| CameraStatus::idle());
                    apply_record_snapshot(&mut status, &snapshot);
                    status.recording = false;
                    status.availability = CameraAvailability::Failed;
                    publish_inner(inner, status);
                }
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = inner;
    }
}

fn remux_overlap_inner(
    inner: &Inner,
    start_hns: i64,
    end_hns: i64,
    output: &Path,
) -> Result<Option<PathBuf>, String> {
    let segments = {
        let Ok(mut buffer) = inner.webcam_buffer.lock() else {
            return Ok(None);
        };
        buffer.lock_range(start_hns, end_hns);
        buffer
            .snapshot()
            .into_iter()
            .filter(|segment| {
                segment.health == SegmentHealth::Valid
                    && !segment.path.is_empty()
                    && segment.start_hns < end_hns
                    && segment.end_hns > start_hns
            })
            .collect::<Vec<_>>()
    };
    let existing: Vec<_> = segments
        .iter()
        .filter(|segment| {
            std::fs::metadata(&segment.path)
                .map(|meta| meta.len() > 0)
                .unwrap_or(false)
        })
        .cloned()
        .collect();
    if existing.is_empty() {
        if let Ok(mut buffer) = inner.webcam_buffer.lock() {
            buffer.unlock_all();
        }
        return Ok(None);
    }
    tracing::info!(
        segments = existing.len(),
        start_hns,
        end_hns,
        output = %output.display(),
        "remuxing overlapping webcam sidecar"
    );
    #[cfg(windows)]
    {
        let mut existing = existing;
        existing.sort_by_key(|segment| segment.start_hns);
        let concat: Vec<crate::export::ConcatSegment> = existing
            .iter()
            .map(|segment| crate::export::ConcatSegment {
                path: PathBuf::from(&segment.path),
                start_hns: segment.start_hns,
                end_hns: segment.end_hns,
            })
            .collect();
        let window_duration_hns = (end_hns - start_hns).max(0);
        let first_webcam_segment_start_hns = existing[0].start_hns;
        tracing::info!(
            window_start_hns = start_hns,
            window_end_hns = end_hns,
            window_duration_hns,
            first_webcam_segment_start_hns,
            origin_delta_hns = first_webcam_segment_start_hns - start_hns,
            "webcam sidecar clip origin"
        );
        let result = crate::export::concat_mp4s_preserve_timeline(
            &concat,
            output,
            start_hns,
            end_hns,
        );
        if let Ok(mut buffer) = inner.webcam_buffer.lock() {
            buffer.unlock_all();
        }
        if let Err(err) = result {
            let _ = std::fs::remove_file(output);
            return Err(err);
        }
        Ok(Some(output.to_path_buf()))
    }
    #[cfg(not(windows))]
    {
        let _ = output;
        if let Ok(mut buffer) = inner.webcam_buffer.lock() {
            buffer.unlock_all();
        }
        Ok(None)
    }
}

fn recording(inner: &Inner) -> bool {
    #[cfg(windows)]
    {
        inner
            .record
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().map(|session| !session.finished()))
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        let _ = inner;
        false
    }
}

fn stop_record_session(inner: &Inner) {
    #[cfg(windows)]
    {
        if let Ok(mut slot) = inner.record.lock() {
            if let Some(session) = slot.take() {
                let snapshot = session.stop();
                let mut status = inner
                    .status
                    .lock()
                    .map(|guard| guard.clone())
                    .unwrap_or_else(|_| CameraStatus::idle());
                apply_record_snapshot(&mut status, &snapshot);
                status.recording = false;
                if snapshot.message.is_empty() {
                    status.availability = if inner.enabled.load(Ordering::SeqCst) {
                        CameraAvailability::Ready
                    } else {
                        CameraAvailability::Idle
                    };
                    if !snapshot.path.is_empty() && snapshot.written_frames > 0 {
                        status.message = format!("Saved {}", snapshot.path);
                    }
                } else {
                    status.availability = CameraAvailability::Failed;
                }
                publish_inner(inner, status);
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = inner;
    }
}

fn stop_preview_session(inner: &Inner) {
    #[cfg(windows)]
    {
        if let Ok(mut slot) = inner.preview.lock() {
            if let Some(session) = slot.take() {
                session.stop();
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = inner;
    }
}

fn previewing(inner: &Inner) -> bool {
    #[cfg(windows)]
    {
        inner.preview.lock().ok().and_then(|guard| guard.as_ref().map(|_| true)).unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        let _ = inner;
        false
    }
}

fn publish_inner(inner: &Inner, status: CameraStatus) {
    if let Ok(mut slot) = inner.status.lock() {
        *slot = status.clone();
    }
    if let Ok(app) = inner.app.lock() {
        if let Some(app) = app.as_ref() {
            let _ = app.emit("camera-status", CameraStatusEvent { status });
        }
    }
}

fn list_devices_off_ui() -> Result<Vec<CameraDeviceInfo>, String> {
    #[cfg(windows)]
    {
        super::device::run_off_ui("list-cameras", LIST_TIMEOUT, super::device::list_devices)
    }
    #[cfg(not(windows))]
    {
        Ok(Vec::new())
    }
}

fn list_modes_off_ui(device_id: &str) -> Result<Vec<super::format::CameraMode>, String> {
    #[cfg(windows)]
    {
        let device_id = device_id.to_string();
        super::device::run_off_ui("list-camera-modes", LIST_TIMEOUT, move || super::device::list_modes(&device_id))
    }
    #[cfg(not(windows))]
    {
        let _ = device_id;
        Ok(Vec::new())
    }
}

#[allow(dead_code)]
pub fn estimate_storage_mb_per_minute(width: u32, height: u32, fps: u32) -> u32 {
    estimated_mb_per_minute(webcam_bitrate_bps(width, height, fps))
}

#[allow(dead_code)]
pub fn pick_requested_mode(
    available: &[super::format::CameraMode],
    width: u32,
    height: u32,
    fps: u32,
) -> Option<super::format::CameraMode> {
    pick_camera_mode(available, RequestedMode { width, height, fps })
}

fn apply_session_clock(inner: &Inner, status: &mut CameraStatus) {
    status.session_clock = inner
        .session_clock
        .lock()
        .ok()
        .and_then(|guard| *guard)
        .is_some();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn begin_and_end_session_share_clock() {
        let engine = CameraEngine::new();
        assert!(engine.session_clock().is_none());
        assert!(!engine.status().session_clock);
        let clock = SessionClock::start();
        engine.begin_session(clock);
        let bound = engine.session_clock().expect("camera should be bound to the session");
        assert_eq!(bound.qpc_origin_hns(), clock.qpc_origin_hns());
        assert!(engine.status().session_clock);
        engine.end_session();
        assert!(engine.session_clock().is_none());
        assert!(!engine.status().session_clock);
    }

    #[test]
    fn rotate_without_rolling_is_immediate() {
        let engine = CameraEngine::new();
        let gen = engine.request_rotate();
        assert!(engine.wait_for_rotate(gen, Duration::from_millis(20)));
    }

    #[test]
    fn sidecar_without_webcam_does_not_fail() {
        let engine = CameraEngine::new();
        let dir = tempfile::tempdir().unwrap();
        let clip = dir.path().join("clip-1.mp4");
        std::fs::write(&clip, b"clip").unwrap();
        engine.save_overlap_sidecar(&clip, 0, 40_000_000);
        assert!(!webcam_sidecar_path(&clip).exists());
        assert!(clip.exists());
    }
}
