use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use wasapi::{DeviceCollection, Direction, get_default_device, initialize_mta};

use crate::audio_capture::{
    capture_device_present, default_render_device, open_device_client, run_capture_loop,
    run_peak_only_loop,
};
use crate::audio_resolve::{
    extra_isolated_count, process_loopback_supported, resolve_catalog_pid, resolve_extra_app_pid,
    resolve_game_pids, DETECTED_EXTRAS, DISCORD,
};
use crate::audio_timeline::{MixSink, MixStats, SourceControl};
use crate::games::{DetectedGameSnapshot, GameRecord};
use crate::process::list_processes;
use crate::process_loopback::{
    list_audio_sessions, os_build_number, sessions_as_refs, ProcessLoopbackCapture,
};
use crate::settings::{AppSettings, ExtraAudioApp};

pub use crate::process_loopback::AudioSessionInfo;


#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AudioDeviceInfo {
    pub id: String,
    pub name: String,
    pub direction: AudioDirection,
    pub is_default: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AudioDirection {
    Capture,
    Render,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MicRoute {
    pub enabled: bool,
    pub device_id: String,
    pub gain: f32,
}

impl MicRoute {
    pub fn from_settings(settings: &AppSettings) -> Self {
        Self {
            enabled: settings.mic_enabled,
            device_id: normalize_device_id(&settings.microphone_id),
            gain: settings.mic_gain.clamp(0.0, 2.0),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AudioSourceStatus {
    pub id: String,
    pub display_name: String,
    pub enabled: bool,
    pub running: bool,
    pub capturing: bool,
    pub isolation_failed: bool,
    pub status: String,
    pub peak: f32,
    pub gain: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AudioEngineStatus {
    pub process_loopback_supported: bool,
    pub os_build: u32,
    pub extra_count: usize,
    pub extra_cap: usize,
    pub game: AudioSourceStatus,
    pub desktop: AudioSourceStatus,
    pub discord: AudioSourceStatus,
    pub extras: Vec<AudioSourceStatus>,
    pub detected_extras: Vec<DetectedExtraApp>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DetectedExtraApp {
    pub id: String,
    pub exe: String,
    pub display_name: String,
    pub running: bool,
    pub added: bool,
}

const ISOLATED_RESTART_BACKOFF: Duration = Duration::from_secs(2);

struct IsolatedClient {
    key: String,
    gain: f32,
    capture: ProcessLoopbackCapture,
    started_at: Instant,
}

#[derive(Clone)]
struct IsolatedPlan {
    key: String,
    pid: u32,
    gain: f32,
}

#[derive(Clone)]
pub struct AudioRuntime {
    inner: Arc<AudioRuntimeInner>,
}

struct AudioRuntimeInner {
    mic: Mutex<Option<MicCapture>>,
    mic_control: Arc<SourceControl>,
    desktop_control: Arc<SourceControl>,
    desktop_monitor: Mutex<Option<DesktopPeakMonitor>>,
    desktop_recording: Mutex<Option<LoopbackCapture>>,
    composed_desktop: AtomicBool,
    /// Composed session mix flags are snapshotted at start. `apply()` must not
    /// overwrite them from settings until the session restores.
    composed_routing_hold: AtomicBool,
    /// Every capture thread sums into this one timeline. Sources that are off
    /// keep running for their level meters but do not contribute.
    sink: Arc<MixSink>,
    hold_device: Mutex<Option<String>>,
    isolated: Mutex<Vec<IsolatedClient>>,
    status: Mutex<AudioEngineStatus>,
    app: Mutex<Option<AppHandle>>,
}

impl AudioRuntime {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(AudioRuntimeInner {
                mic: Mutex::new(None),
                mic_control: Arc::new(SourceControl::new(false, 1.0)),
                desktop_control: Arc::new(SourceControl::new(false, 1.0)),
                desktop_monitor: Mutex::new(None),
                desktop_recording: Mutex::new(None),
                composed_desktop: AtomicBool::new(false),
                composed_routing_hold: AtomicBool::new(false),
                sink: Arc::new(MixSink::new()),
                hold_device: Mutex::new(None),
                isolated: Mutex::new(Vec::new()),
                status: Mutex::new(AudioEngineStatus::unsupported()),
                app: Mutex::new(None),
            }),
        }
    }

    pub fn sink(&self) -> Arc<MixSink> {
        Arc::clone(&self.inner.sink)
    }

    pub fn desktop_control(&self) -> Arc<SourceControl> {
        Arc::clone(&self.inner.desktop_control)
    }

    /// Same idea as `ensure_peak_monitor` for the mic: start a WASAPI loopback
    /// that only updates `desktop_control` peak. It does not mix into the session.
    pub fn ensure_desktop_peak_monitor(&self) {
        if self.inner.composed_desktop.load(Ordering::SeqCst) {
            return;
        }
        if self
            .inner
            .desktop_monitor
            .lock()
            .ok()
            .and_then(|slot| slot.as_ref().map(|_| ()))
            .is_some()
        {
            return;
        }
        if let Some(monitor) = DesktopPeakMonitor::start(Arc::clone(&self.inner.desktop_control)) {
            if let Ok(mut slot) = self.inner.desktop_monitor.lock() {
                *slot = Some(monitor);
            }
        } else {
            self.inner.desktop_control.reset_peak();
        }
    }

    pub fn stop_desktop_peak_monitor(&self) {
        self.release_peak_monitor();
        self.inner.desktop_control.reset_peak();
    }

    fn release_peak_monitor(&self) {
        if let Ok(mut slot) = self.inner.desktop_monitor.lock() {
            *slot = None;
        }
    }

    /// Recording owns the WASAPI loopback. Peak-only monitor is suspended.
    /// The recording client also updates `desktop_control` peak for the meter.
    pub fn begin_composed_desktop(&self) -> bool {
        if !self.inner.desktop_control.enabled() {
            return false;
        }
        self.inner.composed_desktop.store(true, Ordering::SeqCst);
        self.release_peak_monitor();
        if self
            .inner
            .desktop_recording
            .lock()
            .ok()
            .and_then(|slot| slot.as_ref().map(|_| ()))
            .is_some()
        {
            return true;
        }
        match LoopbackCapture::start(self.sink(), self.desktop_control()) {
            Some(capture) => {
                if let Ok(mut slot) = self.inner.desktop_recording.lock() {
                    *slot = Some(capture);
                }
                true
            }
            None => {
                self.inner.composed_desktop.store(false, Ordering::SeqCst);
                if self.inner.desktop_control.enabled() {
                    self.ensure_desktop_peak_monitor();
                }
                false
            }
        }
    }

    pub fn end_composed_desktop(&self) {
        if let Ok(mut slot) = self.inner.desktop_recording.lock() {
            *slot = None;
        }
        self.inner.composed_desktop.store(false, Ordering::SeqCst);
        if self.inner.desktop_control.enabled() {
            self.ensure_desktop_peak_monitor();
        }
    }

    pub fn desktop_capture_stats(&self) -> (u64, u64) {
        (
            self.inner.desktop_control.received_frames(),
            self.inner.desktop_control.mixed_frames(),
        )
    }

    pub fn mic_capture_stats(&self) -> (u64, u64) {
        (
            self.inner.mic_control.received_frames(),
            self.inner.mic_control.mixed_frames(),
        )
    }

    pub fn game_capture_stats(&self) -> (u64, u64) {
        let Ok(clients) = self.inner.isolated.lock() else {
            return (0, 0);
        };
        clients
            .iter()
            .filter(|client| client.key.starts_with("game:"))
            .fold((0, 0), |(received, mixed), client| {
                let control = client.capture.control();
                (
                    received.saturating_add(control.received_frames()),
                    mixed.saturating_add(control.mixed_frames()),
                )
            })
    }

    /// Opens the timeline. `origin_hns` must be sampled next to the video
    /// session clock so the two agree on where time zero is.
    pub fn begin_session(&self, origin_hns: i64) {
        self.inner.sink.begin_session(origin_hns);
    }

    pub fn end_session(&self) {
        self.inner.sink.end_session();
    }

    pub fn read_audio(&self, end_frame: i64) -> Vec<u8> {
        self.inner.sink.read_upto(end_frame)
    }

    pub fn mix_stats(&self) -> MixStats {
        self.inner.sink.stats()
    }

    pub fn bind(&self, app: AppHandle) {
        if let Ok(mut slot) = self.inner.app.lock() {
            *slot = Some(app);
        }
    }

    pub fn clear_hold(&self) {
        if let Ok(mut hold) = self.inner.hold_device.lock() {
            *hold = None;
        }
    }

    pub fn peak(&self) -> f32 {
        self.inner.mic_control.peak()
    }

    pub fn set_gain(&self, gain: f32) {
        self.inner.mic_control.set_gain(gain);
    }

    pub fn is_monitoring(&self, device_id: &str) -> bool {
        let requested = normalize_device_id(device_id);
        self.inner
            .mic
            .lock()
            .ok()
            .and_then(|slot| slot.as_ref().map(|mic| mic.requested_id == requested))
            .unwrap_or(false)
    }

    pub fn ensure_peak_monitor(&self, device_id: &str) {
        let requested = normalize_device_id(device_id);
        let running_id = self
            .inner
            .mic
            .lock()
            .ok()
            .and_then(|slot| slot.as_ref().map(|mic| mic.requested_id.clone()));
        if running_id.as_deref() == Some(requested.as_str()) {
            return;
        }
        match MicCapture::start(requested, self.clone()) {
            Some(capture) => self.replace_mic(Some(capture)),
            None => self.inner.mic_control.reset_peak(),
        }
    }

    pub fn stop_if_not_mixing(&self) {
        if self.inner.mic_control.enabled() {
            return;
        }
        self.replace_mic(None);
        self.inner.mic_control.reset_peak();
    }

    /// Freeze MixSink membership from the composed scene snapshot.
    /// Peak monitors stay available so muted mixer rows can still move.
    pub fn apply_composed_mix_routing(&self, mic: bool, game: bool, desktop: bool) {
        self.inner.composed_routing_hold.store(true, Ordering::SeqCst);
        self.inner.mic_control.set_enabled(mic);
        self.inner.desktop_control.set_enabled(desktop);
        if let Ok(clients) = self.inner.isolated.lock() {
            for client in clients.iter() {
                let allow = client.key.starts_with("game:") && game && !desktop;
                client.capture.control().set_enabled(allow);
            }
        }
        if !desktop {
            self.ensure_desktop_peak_monitor();
        }
    }

    pub fn restore_settings_mix_flags(&self, settings: &AppSettings) {
        self.inner.composed_routing_hold.store(false, Ordering::SeqCst);
        self.apply(settings);
    }

    pub fn apply(&self, settings: &AppSettings) {
        if self.inner.composed_routing_hold.load(Ordering::SeqCst) {
            self.apply_meter_prefs(settings);
            return;
        }
        self.apply_mic(settings);
        self.sync_isolated(settings, None, None);
    }

    pub fn apply_with_context(
        &self,
        settings: &AppSettings,
        snapshot: &DetectedGameSnapshot,
        catalog: &[GameRecord],
    ) {
        if self.inner.composed_routing_hold.load(Ordering::SeqCst) {
            self.apply_meter_prefs(settings);
            return;
        }
        self.inner
            .desktop_control
            .set_enabled(settings.system_audio_enabled);
        self.ensure_desktop_peak_monitor();
        self.sync_isolated(settings, Some(snapshot), Some(catalog));
    }

    fn apply_meter_prefs(&self, settings: &AppSettings) {
        let route = MicRoute::from_settings(settings);
        self.inner.mic_control.set_gain(route.gain);
        self.ensure_desktop_peak_monitor();
    }

    fn apply_mic(&self, settings: &AppSettings) {
        let route = MicRoute::from_settings(settings);
        self.inner.mic_control.set_gain(route.gain);
        self.inner.mic_control.set_enabled(route.enabled);
        self.inner
            .desktop_control
            .set_enabled(settings.system_audio_enabled);
        self.ensure_desktop_peak_monitor();

        let held = self
            .inner
            .hold_device
            .lock()
            .ok()
            .and_then(|guard| guard.clone());
        if route.enabled && held.as_ref() == Some(&route.device_id) {
            self.replace_mic(None);
            self.inner.mic_control.reset_peak();
            return;
        }
        if !route.enabled {
            self.clear_hold();
            return;
        }

        let requested = route.device_id.clone();
        let running_id = self
            .inner
            .mic
            .lock()
            .ok()
            .and_then(|slot| slot.as_ref().map(|mic| mic.requested_id.clone()));
        if running_id.as_deref() == Some(requested.as_str()) {
            return;
        }

        self.clear_hold();
        match MicCapture::start(requested.clone(), self.clone()) {
            Some(capture) => self.replace_mic(Some(capture)),
            None => self.notify_disconnect(&requested, "Microphone", false),
        }
    }

    pub fn status(&self) -> AudioEngineStatus {
        let mut status = self
            .inner
            .status
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_else(|_| AudioEngineStatus::unsupported());
        status.desktop.peak = self.inner.desktop_control.peak();
        if let Ok(clients) = self.inner.isolated.lock() {
            status.game.peak = peak_for_prefix(Some(&clients), "game:");
            status.discord.peak = peak_for_prefix(Some(&clients), "discord:");
            for extra in &mut status.extras {
                extra.peak = peak_for_prefix(Some(&clients), &format!("extra:{}:", extra.id));
            }
        }
        status
    }

    fn replace_mic(&self, next: Option<MicCapture>) {
        let previous = self.inner.mic.lock().ok().and_then(|mut slot| slot.take());
        if let Some(mut previous) = previous {
            previous.detach();
        }
        if let Some(capture) = next {
            if let Ok(mut slot) = self.inner.mic.lock() {
                *slot = Some(capture);
            }
        }
    }

    /// Decays the microphone meter when no capture thread is feeding it.
    pub fn idle_tick(&self) {
        let running = self
            .inner
            .mic
            .lock()
            .ok()
            .map(|slot| slot.is_some())
            .unwrap_or(false);
        if !running {
            self.inner.mic_control.decay_peak();
        }
        let desktop_owned = self.inner.composed_desktop.load(Ordering::Relaxed)
            || self
                .inner
                .desktop_recording
                .lock()
                .ok()
                .map(|slot| slot.is_some())
                .unwrap_or(false)
            || self
                .inner
                .desktop_monitor
                .lock()
                .ok()
                .map(|slot| slot.is_some())
                .unwrap_or(false);
        if !desktop_owned {
            self.inner.desktop_control.decay_peak();
        }
    }

    fn sync_isolated(
        &self,
        settings: &AppSettings,
        snapshot: Option<&DetectedGameSnapshot>,
        catalog: Option<&[GameRecord]>,
    ) {
        let os_build = os_build_number();
        let supported = process_loopback_supported(os_build);
        let snapshot = snapshot.cloned().or_else(|| self.current_snapshot()).unwrap_or_else(DetectedGameSnapshot::empty);
        let catalog = catalog
            .map(|items| items.to_vec())
            .or_else(|| self.current_catalog())
            .unwrap_or_default();
        let processes = list_processes();
        let sessions = if supported && settings.wants_isolated_audio() {
            list_audio_sessions().unwrap_or_default()
        } else {
            Vec::new()
        };
        if !supported {
            if let Ok(mut clients) = self.inner.isolated.lock() {
                clients.clear();
            }
        }
        let session_refs = sessions_as_refs(&sessions);
        let self_pid = std::process::id();

        let game_pids = if settings.game_audio_enabled && supported {
            resolve_game_pids(&snapshot, &processes, &session_refs, &catalog, self_pid)
        } else {
            crate::audio_resolve::GamePidSet::empty()
        };
        if settings.game_audio_enabled && supported && !game_pids.is_empty() {
            tracing::debug!(
                "game audio primary={:?} include={:?} sessions={}",
                game_pids.primary,
                game_pids.include_pids,
                sessions
                    .iter()
                    .map(|session| format!("{}:{}", session.pid, session.exe))
                    .collect::<Vec<_>>()
                    .join(",")
            );
        }
        let discord_pid = if settings.discord_audio_enabled && supported {
            resolve_catalog_pid(&DISCORD, &processes, &session_refs, self_pid)
        } else {
            None
        };

        let mut desired = Vec::new();
        if settings.game_audio_enabled && supported {
            for pid in &game_pids.include_pids {
                desired.push(IsolatedPlan {
                    key: format!("game:{pid}"),
                    pid: *pid,
                    gain: settings.game_audio_gain.clamp(0.0, 2.0),
                });
            }
        }
        if let Some(pid) = discord_pid {
            desired.push(IsolatedPlan {
                key: format!("discord:{pid}"),
                pid,
                gain: settings.discord_audio_gain.clamp(0.0, 2.0),
            });
        }
        if supported {
            for app in settings.extra_apps.iter().filter(|app| app.enabled) {
                if let Some(pid) = resolve_extra_app_pid(app, &processes, &session_refs, self_pid) {
                    desired.push(IsolatedPlan {
                        key: format!("extra:{}:{pid}", app.id),
                        pid,
                        gain: app.gain.clamp(0.0, 2.0),
                    });
                }
            }
        }

        // Desktop loopback already carries every app's audio. Running the
        // isolated sources alongside it would sum each one twice.
        let isolated_enabled = !settings.system_audio_enabled;
        if let Ok(mut clients) = self.inner.isolated.lock() {
            clients.retain(|client| {
                let still_wanted = desired.iter().any(|plan| plan.key == client.key);
                if !still_wanted {
                    return false;
                }
                !(client.capture.failed() && client.started_at.elapsed() >= ISOLATED_RESTART_BACKOFF)
            });
            for plan in &desired {
                if let Some(existing) = clients.iter_mut().find(|client| client.key == plan.key) {
                    if !existing.capture.failed() {
                        existing.gain = plan.gain;
                        existing.capture.control().set_gain(plan.gain);
                        existing.capture.control().set_enabled(isolated_enabled);
                    }
                    continue;
                }
                if let Some(capture) = ProcessLoopbackCapture::start(
                    plan.pid,
                    self.sink(),
                    isolated_enabled,
                    plan.gain,
                ) {
                    clients.push(IsolatedClient {
                        key: plan.key.clone(),
                        gain: plan.gain,
                        capture,
                        started_at: Instant::now(),
                    });
                }
            }
        }

        let status = build_status(
            settings,
            supported,
            os_build,
            &snapshot,
            &processes,
            &desired,
            self,
            discord_pid,
        );
        if let Ok(mut slot) = self.inner.status.lock() {
            *slot = status;
        }
    }

    fn current_snapshot(&self) -> Option<DetectedGameSnapshot> {
        let app = self.inner.app.lock().ok().and_then(|slot| slot.clone())?;
        Some(crate::detection::current_snapshot(&app.state::<crate::detection::DetectionState>()))
    }

    fn current_catalog(&self) -> Option<Vec<GameRecord>> {
        let app = self.inner.app.lock().ok().and_then(|slot| slot.clone())?;
        let db = app.state::<crate::database::AppState>();
        let conn = db.db.lock().ok()?;
        crate::games::load_catalog(&conn).ok()
    }

    fn notify_disconnect(&self, device_id: &str, name: &str, from_capture_thread: bool) {
        if let Ok(mut hold) = self.inner.hold_device.lock() {
            *hold = Some(normalize_device_id(device_id));
        }
        if from_capture_thread {
            if let Ok(mut slot) = self.inner.mic.lock() {
                if let Some(mut mic) = slot.take() {
                    mic.detach();
                }
            }
        } else {
            self.replace_mic(None);
        }
        self.inner.mic_control.reset_peak();
        self.emit_disconnect(device_id, name);
    }

    fn emit_disconnect(&self, device_id: &str, name: &str) {
        let app = self.inner.app.lock().ok().and_then(|slot| slot.clone());
        if let Some(app) = app {
            let _ = app.emit(
                "mic-disconnected",
                serde_json::json!({
                    "deviceId": normalize_device_id(device_id),
                    "name": name,
                }),
            );
        }
        tracing::warn!("microphone disconnected ({device_id}); capture stopped, video continues");
    }
}

pub struct LoopbackCapture {
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

impl LoopbackCapture {
    pub fn start(sink: Arc<MixSink>, control: Arc<SourceControl>) -> Option<Self> {
        let stop = Arc::new(AtomicBool::new(false));
        let stop_thread = stop.clone();
        let join = thread::Builder::new()
            .name("wasapi-loopback".into())
            .spawn(move || {
                let _ = initialize_mta().ok();
                if let Err(err) = loopback_loop(&sink, &control, &stop_thread) {
                    if !stop_thread.load(Ordering::Relaxed) {
                        tracing::warn!("WASAPI loopback stopped: {err}");
                    }
                }
            })
            .ok()?;
        Some(Self {
            stop,
            join: Some(join),
        })
    }
}

impl Drop for LoopbackCapture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

struct DesktopPeakMonitor {
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

impl DesktopPeakMonitor {
    fn start(control: Arc<SourceControl>) -> Option<Self> {
        let stop = Arc::new(AtomicBool::new(false));
        let stop_thread = stop.clone();
        let join = thread::Builder::new()
            .name("wasapi-desktop-meter".into())
            .spawn(move || {
                let _ = initialize_mta().ok();
                if let Err(err) = desktop_peak_loop(&control, &stop_thread) {
                    if !stop_thread.load(Ordering::Relaxed) {
                        tracing::warn!("desktop meter loopback stopped: {err}");
                    }
                }
            })
            .ok()?;
        Some(Self {
            stop,
            join: Some(join),
        })
    }
}

impl Drop for DesktopPeakMonitor {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

fn desktop_peak_loop(control: &Arc<SourceControl>, stop: &AtomicBool) -> Result<(), String> {
    let device = default_render_device()?;
    let ready = open_device_client(&device, true)?;
    let result = run_peak_only_loop(&ready, control, stop);
    ready.close();
    result
}

struct MicCapture {
    requested_id: String,
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

impl MicCapture {
    fn start(requested_id: String, runtime: AudioRuntime) -> Option<Self> {
        let stop = Arc::new(AtomicBool::new(false));
        let stop_thread = stop.clone();
        let id_thread = requested_id.clone();
        let sink = runtime.sink();
        let control = Arc::clone(&runtime.inner.mic_control);
        let join = thread::Builder::new()
            .name("wasapi-mic".into())
            .spawn(move || {
                let _ = initialize_mta().ok();
                let friendly = device_name(&id_thread).unwrap_or_else(|| "Microphone".into());
                if let Err(err) = mic_loop(&id_thread, &sink, &control, &stop_thread) {
                    if !stop_thread.load(Ordering::Relaxed) {
                        tracing::warn!("WASAPI microphone stopped: {err}");
                        runtime.notify_disconnect(&id_thread, &friendly, true);
                    }
                }
            })
            .ok()?;
        Some(Self {
            requested_id,
            stop,
            join: Some(join),
        })
    }

    fn detach(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        let _ = self.join.take();
    }
}

impl Drop for MicCapture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

const DEVICE_OP_TIMEOUT: Duration = Duration::from_secs(3);

pub fn list_sessions() -> Result<Vec<AudioSessionInfo>, String> {
    list_audio_sessions()
}

pub fn list_devices() -> Result<Vec<AudioDeviceInfo>, String> {
    run_off_ui("list-audio-devices", DEVICE_OP_TIMEOUT, || {
        let _ = initialize_mta().ok();
        let mut devices = Vec::new();
        devices.extend(list_direction(Direction::Capture, AudioDirection::Capture)?);
        devices.extend(list_direction(Direction::Render, AudioDirection::Render)?);
        Ok::<_, String>(devices)
    })
}

fn run_off_ui<T, E, F>(name: &'static str, timeout: Duration, work: F) -> Result<T, String>
where
    T: Send + 'static,
    E: ToString,
    F: FnOnce() -> Result<T, E> + Send + 'static,
{
    let (tx, rx) = mpsc::channel();
    thread::Builder::new()
        .name(name.into())
        .spawn(move || {
            let _ = tx.send(work().map_err(|err| err.to_string()));
        })
        .map_err(|err| err.to_string())?;
    rx.recv_timeout(timeout)
        .map_err(|_| format!("{name} timed out"))?
}

fn list_direction(
    wasapi_dir: Direction,
    direction: AudioDirection,
) -> Result<Vec<AudioDeviceInfo>, String> {
    let default_id = get_default_device(&wasapi_dir)
        .ok()
        .and_then(|device| device.get_id().ok());
    let collection = DeviceCollection::new(&wasapi_dir).map_err(|err| err.to_string())?;
    let mut devices = Vec::new();
    for device in &collection {
        let device = device.map_err(|err| err.to_string())?;
        let id = device.get_id().map_err(|err| err.to_string())?;
        let name = device
            .get_friendlyname()
            .unwrap_or_else(|_| "Audio device".into());
        let is_default = default_id.as_ref() == Some(&id);
        devices.push(AudioDeviceInfo {
            id,
            name,
            direction,
            is_default,
        });
    }
    Ok(devices)
}

impl AudioEngineStatus {
    fn unsupported() -> Self {
        Self {
            process_loopback_supported: false,
            os_build: 0,
            extra_count: 0,
            extra_cap: crate::settings::MAX_EXTRA_ISOLATED_APPS,
            game: AudioSourceStatus::idle("game", "Game Audio"),
            desktop: AudioSourceStatus::idle("desktop", "Desktop / System"),
            discord: AudioSourceStatus::idle("discord", "Discord"),
            extras: Vec::new(),
            detected_extras: Vec::new(),
        }
    }
}

impl AudioSourceStatus {
    fn idle(id: &str, display_name: &str) -> Self {
        Self {
            id: id.into(),
            display_name: display_name.into(),
            enabled: false,
            running: false,
            capturing: false,
            isolation_failed: false,
            status: String::new(),
            peak: 0.0,
            gain: 1.0,
        }
    }
}

fn build_status(
    settings: &AppSettings,
    supported: bool,
    os_build: u32,
    snapshot: &DetectedGameSnapshot,
    processes: &[crate::games::ProcessRef],
    desired: &[IsolatedPlan],
    runtime: &AudioRuntime,
    discord_pid: Option<u32>,
) -> AudioEngineStatus {
    let clients = runtime.inner.isolated.lock().ok();
    let isolated = clients.as_ref().map(|items| items.as_slice());
    let game_peak = peak_for_prefix(isolated, "game:");
    let discord_peak = peak_for_prefix(isolated, "discord:");
    let game_failed = failed_for_prefix(isolated, "game:");
    let discord_failed = failed_for_prefix(isolated, "discord:");
    let game_running = snapshot.pid.is_some();
    let game_capturing = desired.iter().any(|plan| plan.key.starts_with("game:"));
    let discord_running = discord_pid.is_some()
        || processes
            .iter()
            .any(|process| crate::audio_resolve::catalog_matches(&DISCORD, &process.name));

    let game_status = if !supported {
        "Per-app capture needs Windows 10 version 2004 or later.".into()
    } else if !settings.game_audio_enabled {
        "Off".into()
    } else if !game_running {
        "No game detected".into()
    } else if game_failed {
        "Can't capture this source separately.".into()
    } else if game_capturing {
        "Capturing".into()
    } else {
        "No game detected".into()
    };

    let discord_status = if !supported {
        "Per-app capture needs Windows 10 version 2004 or later.".into()
    } else if !settings.discord_audio_enabled {
        "Off".into()
    } else if !discord_running {
        "Not running".into()
    } else if discord_failed {
        "Can't capture this source separately.".into()
    } else {
        "Capturing".into()
    };

    let extras = settings
        .extra_apps
        .iter()
        .map(|app| extra_status(app, processes, isolated, supported))
        .collect();

    AudioEngineStatus {
        process_loopback_supported: supported,
        os_build,
        extra_count: extra_isolated_count(settings.discord_audio_enabled, &settings.extra_apps),
        extra_cap: crate::settings::MAX_EXTRA_ISOLATED_APPS,
        game: AudioSourceStatus {
            id: "game".into(),
            display_name: snapshot.name.clone().unwrap_or_else(|| "Game Audio".into()),
            enabled: settings.game_audio_enabled,
            running: game_running,
            capturing: game_capturing && !game_failed,
            isolation_failed: game_failed,
            status: game_status,
            peak: game_peak,
            gain: settings.game_audio_gain,
        },
        desktop: AudioSourceStatus {
            id: "desktop".into(),
            display_name: "Desktop / System".into(),
            enabled: settings.system_audio_enabled,
            running: true,
            capturing: settings.system_audio_enabled,
            isolation_failed: false,
            status: if settings.system_audio_enabled {
                "Full speaker mix — Chrome, Discord, and everything else.".into()
            } else {
                "Off. Selected apps only.".into()
            },
            peak: runtime.inner.desktop_control.peak(),
            gain: 1.0,
        },
        discord: AudioSourceStatus {
            id: "discord".into(),
            display_name: "Discord".into(),
            enabled: settings.discord_audio_enabled,
            running: discord_running,
            capturing: discord_pid.is_some() && !discord_failed,
            isolation_failed: discord_failed,
            status: discord_status,
            peak: discord_peak,
            gain: settings.discord_audio_gain,
        },
        extras,
        detected_extras: detected_extra_rows(settings, processes),
    }
}

fn extra_status(
    app: &ExtraAudioApp,
    processes: &[crate::games::ProcessRef],
    clients: Option<&[IsolatedClient]>,
    supported: bool,
) -> AudioSourceStatus {
    let running = processes
        .iter()
        .any(|process| crate::games::process_name_matches(&app.exe, &process.name));
    let prefix = format!("extra:{}:", app.id);
    let peak = peak_for_prefix(clients, &prefix);
    let failed = failed_for_prefix(clients, &prefix);
    let capturing = clients
        .map(|items| items.iter().any(|client| client.key.starts_with(&prefix)))
        .unwrap_or(false);
    let status = if !supported {
        "Per-app capture needs Windows 10 version 2004 or later.".into()
    } else if !app.enabled {
        "Off".into()
    } else if !running {
        "Not running".into()
    } else if failed {
        "Can't capture this source separately.".into()
    } else {
        "Capturing".into()
    };
    AudioSourceStatus {
        id: app.id.clone(),
        display_name: app.display_name.clone(),
        enabled: app.enabled,
        running,
        capturing: capturing && !failed,
        isolation_failed: failed,
        status,
        peak,
        gain: app.gain,
    }
}

fn detected_extra_rows(settings: &AppSettings, processes: &[crate::games::ProcessRef]) -> Vec<DetectedExtraApp> {
    DETECTED_EXTRAS
        .iter()
        .filter_map(|app| {
            let running = processes
                .iter()
                .any(|process| crate::audio_resolve::catalog_matches(app, &process.name));
            let added = settings
                .extra_apps
                .iter()
                .any(|item| crate::games::process_name_matches(&item.exe, app.process_names[0]));
            if !running && !added {
                return None;
            }
            Some(DetectedExtraApp {
                id: app.id.into(),
                exe: app.process_names[0].to_string(),
                display_name: app.display_name.into(),
                running,
                added,
            })
        })
        .collect()
}

fn peak_for_prefix(clients: Option<&[IsolatedClient]>, prefix: &str) -> f32 {
    clients
        .map(|items| {
            items
                .iter()
                .filter(|client| client.key.starts_with(prefix))
                .map(|client| client.capture.peak())
                .fold(0.0f32, f32::max)
        })
        .unwrap_or(0.0)
}

fn failed_for_prefix(clients: Option<&[IsolatedClient]>, prefix: &str) -> bool {
    let Some(items) = clients else {
        return false;
    };
    let matching: Vec<_> = items.iter().filter(|client| client.key.starts_with(prefix)).collect();
    !matching.is_empty() && matching.iter().all(|client| client.capture.failed())
}

fn loopback_loop(
    sink: &Arc<MixSink>,
    control: &Arc<SourceControl>,
    stop: &AtomicBool,
) -> Result<(), String> {
    let device = default_render_device()?;
    let ready = open_device_client(&device, true)?;
    let result = run_capture_loop(&ready, sink, control, stop, || Ok(()));
    ready.close();
    result
}

fn mic_loop(
    requested_id: &str,
    sink: &Arc<MixSink>,
    control: &Arc<SourceControl>,
    stop: &AtomicBool,
) -> Result<(), String> {
    let device = crate::audio_capture::capture_device(&normalize_device_id(requested_id))?;
    let ready = open_device_client(&device, false)?;
    let result = run_capture_loop(&ready, sink, control, stop, || {
        if capture_device_present(&normalize_device_id(requested_id)) {
            Ok(())
        } else {
            Err("microphone device disappeared".into())
        }
    });
    ready.close();
    result
}

fn device_name(id: &str) -> Option<String> {
    let id = normalize_device_id(id);
    if id == "default" {
        return get_default_device(&Direction::Capture)
            .ok()
            .and_then(|device| device.get_friendlyname().ok());
    }
    let collection = DeviceCollection::new(&Direction::Capture).ok()?;
    for device in &collection {
        let device = device.ok()?;
        if device.get_id().ok()? == id {
            return device.get_friendlyname().ok();
        }
    }
    None
}

fn normalize_device_id(id: &str) -> String {
    let trimmed = id.trim();
    if trimmed.is_empty() {
        "default".into()
    } else {
        trimmed.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apply_disabled_mic_returns_without_wasapi() {
        let runtime = AudioRuntime::new();
        let settings = AppSettings::default();
        assert!(!settings.mic_enabled);
        runtime.apply(&settings);
        assert_eq!(runtime.peak(), 0.0);
    }

    #[test]
    fn apply_enabled_mic_does_not_block_on_device_open() {
        let runtime = AudioRuntime::new();
        let mut settings = AppSettings::default();
        settings.mic_enabled = true;
        let started = Instant::now();
        runtime.apply(&settings);
        assert!(
            started.elapsed() < Duration::from_millis(500),
            "apply must not wait for WASAPI device open"
        );
    }

    #[test]
    fn desktop_source_follows_the_system_audio_setting() {
        let runtime = AudioRuntime::new();
        let desktop = runtime.desktop_control();
        let mut settings = AppSettings::default();
        assert!(!settings.system_audio_enabled);
        runtime.apply(&settings);
        assert!(!desktop.enabled());
        settings.system_audio_enabled = true;
        runtime.apply(&settings);
        assert!(desktop.enabled());
    }

    #[test]
    fn a_closed_session_accepts_no_audio() {
        let runtime = AudioRuntime::new();
        // Sources keep running for their meters between recordings; nothing they
        // produce may reach a timeline that is not open.
        runtime.sink().mix(0, &[500i16; 8], 1.0);
        assert!(runtime.read_audio(4).is_empty());
    }

    #[test]
    fn an_open_session_reads_back_exactly_what_video_asks_for() {
        let runtime = AudioRuntime::new();
        runtime.begin_session(0);
        let lead = crate::audio_timeline::frames_from_hns(
            crate::audio_timeline::AUDIO_LEAD_HNS,
        );
        let pcm = runtime.read_audio(480 - lead);
        assert_eq!(pcm.len(), 480 * crate::audio_timeline::FRAME_BYTES);
        runtime.end_session();
    }
}
