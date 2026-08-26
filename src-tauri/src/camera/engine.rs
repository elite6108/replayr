use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::settings::WebcamSettings;

use super::format::{estimated_mb_per_minute, pick_camera_mode, webcam_bitrate_bps, RequestedMode};
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
    session_lock: Mutex<()>,
    cached_modes: Mutex<Option<(String, Vec<super::format::CameraMode>)>>,
    stop_watch: AtomicBool,
    watch_thread: Mutex<Option<JoinHandle<()>>>,
    wake: Condvar,
    wake_lock: Mutex<()>,
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
                session_lock: Mutex::new(()),
                cached_modes: Mutex::new(None),
                stop_watch: AtomicBool::new(false),
                watch_thread: Mutex::new(None),
                wake: Condvar::new(),
                wake_lock: Mutex::new(()),
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
            status.enabled = self.inner.enabled.load(Ordering::SeqCst);
            status
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
        if let Ok(mut cache) = self.inner.cached_modes.lock() {
            if cache.as_ref().is_some_and(|(id, _)| id != &webcam.device_id) {
                *cache = None;
            }
        }
        // Preview is owned by the settings card. Do not tear it down when the
        // recording toggle is off — that would close the camera mid-configure.
        let watching = webcam.enabled || previewing(&self.inner) || recording(&self.inner);
        self.inner.watch.store(watching, Ordering::SeqCst);
        if watching {
            self.ensure_watch_thread();
            self.wake_watch();
        } else {
            self.publish_idle_if_disabled();
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
            let session = super::preview::PreviewSession::start(request).map_err(|err| {
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
