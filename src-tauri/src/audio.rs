use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use wasapi::{
    DeviceCollection, Direction, SampleType, StreamMode, WaveFormat, get_default_device,
    initialize_mta,
};

use crate::audio_resolve::{
    extra_isolated_count, process_loopback_supported, resolve_catalog_pid, resolve_extra_app_pid,
    resolve_game_pids, DETECTED_EXTRAS, DISCORD,
};
use crate::games::{DetectedGameSnapshot, GameRecord};
use crate::process::list_processes;
use crate::process_loopback::{
    list_audio_sessions, os_build_number, sessions_as_refs, ProcessLoopbackCapture,
};
use crate::settings::{AppSettings, ExtraAudioApp};

pub use crate::process_loopback::AudioSessionInfo;

const MIX_RATE: u32 = 48_000;
const MIX_CHANNELS: u32 = 2;
const BYTES_PER_SAMPLE: usize = 2;
const FRAME_BYTES: usize = MIX_CHANNELS as usize * BYTES_PER_SAMPLE;
const MAX_BUFFER: usize = MIX_RATE as usize * FRAME_BYTES;
const PEAK_SCALE: f32 = 10_000.0;

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
    gain_bits: AtomicU32,
    peak: AtomicU32,
    mix_enabled: AtomicBool,
    desktop_enabled: AtomicBool,
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
                gain_bits: AtomicU32::new(1.0f32.to_bits()),
                peak: AtomicU32::new(0),
                mix_enabled: AtomicBool::new(false),
                desktop_enabled: AtomicBool::new(false),
                hold_device: Mutex::new(None),
                isolated: Mutex::new(Vec::new()),
                status: Mutex::new(AudioEngineStatus::unsupported()),
                app: Mutex::new(None),
            }),
        }
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
        self.inner.peak.load(Ordering::Relaxed) as f32 / PEAK_SCALE
    }

    pub fn set_gain(&self, gain: f32) {
        self.inner
            .gain_bits
            .store(gain.clamp(0.0, 2.0).to_bits(), Ordering::Relaxed);
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
            None => {
                self.inner.peak.store(0, Ordering::Relaxed);
            }
        }
    }

    pub fn stop_if_not_mixing(&self) {
        if self.inner.mix_enabled.load(Ordering::Relaxed) {
            return;
        }
        self.replace_mic(None);
        self.inner.peak.store(0, Ordering::Relaxed);
    }

    pub fn apply(&self, settings: &AppSettings) {
        self.apply_mic(settings);
        self.sync_isolated(settings, None, None);
    }

    pub fn apply_with_context(
        &self,
        settings: &AppSettings,
        snapshot: &DetectedGameSnapshot,
        catalog: &[GameRecord],
    ) {
        self.inner
            .desktop_enabled
            .store(settings.system_audio_enabled, Ordering::Relaxed);
        self.sync_isolated(settings, Some(snapshot), Some(catalog));
    }

    fn apply_mic(&self, settings: &AppSettings) {
        let route = MicRoute::from_settings(settings);
        self.inner
            .gain_bits
            .store(route.gain.to_bits(), Ordering::Relaxed);
        self.inner
            .mix_enabled
            .store(route.enabled, Ordering::Relaxed);
        self.inner
            .desktop_enabled
            .store(settings.system_audio_enabled, Ordering::Relaxed);

        let held = self
            .inner
            .hold_device
            .lock()
            .ok()
            .and_then(|guard| guard.clone());
        if route.enabled && held.as_ref() == Some(&route.device_id) {
            self.replace_mic(None);
            self.inner.peak.store(0, Ordering::Relaxed);
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

    pub fn mix_into(&self, loopback: Vec<u8>) -> Vec<u8> {
        let isolated = self.take_isolated();
        let mic = if self.inner.mix_enabled.load(Ordering::Relaxed) {
            self.inner
                .mic
                .lock()
                .ok()
                .and_then(|slot| slot.as_ref().map(MicCapture::take))
                .unwrap_or_default()
        } else {
            if self.inner.mic.lock().ok().and_then(|slot| slot.as_ref().map(|_| ())).is_none() {
                decay_peak(&self.inner.peak);
            }
            Vec::new()
        };
        let mic_gain = f32::from_bits(self.inner.gain_bits.load(Ordering::Relaxed)).clamp(0.0, 2.0);
        let desktop_on = self.inner.desktop_enabled.load(Ordering::Relaxed);
        let system = if desktop_on { loopback } else { isolated };
        if mic.is_empty() {
            return system;
        }
        mix_pcm(&system, &mic, mic_gain)
    }

    fn take_isolated(&self) -> Vec<u8> {
        let Ok(clients) = self.inner.isolated.lock() else {
            return Vec::new();
        };
        let mut mixed = Vec::new();
        for client in clients.iter() {
            let pcm = client.capture.take();
            mixed = mix_pcm(&mixed, &pcm, client.gain);
        }
        mixed
    }

    pub fn discard_pending(&self) {
        let _ = self.take_isolated();
        if let Ok(slot) = self.inner.mic.lock() {
            if let Some(mic) = slot.as_ref() {
                let _ = MicCapture::take(mic);
            }
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
                    }
                    continue;
                }
                if let Some(capture) = ProcessLoopbackCapture::start(plan.pid) {
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
        self.inner.peak.store(0, Ordering::Relaxed);
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
    buffer: Arc<Mutex<Vec<u8>>>,
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

impl LoopbackCapture {
    pub fn start() -> Option<Self> {
        let buffer = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let buffer_thread = buffer.clone();
        let stop_thread = stop.clone();
        let join = thread::Builder::new()
            .name("wasapi-loopback".into())
            .spawn(move || {
                if let Err(err) = loopback_loop(buffer_thread, stop_thread) {
                    tracing::warn!("WASAPI loopback stopped: {err}");
                }
            })
            .ok()?;
        Some(Self {
            buffer,
            stop,
            join: Some(join),
        })
    }

    pub fn take(&self) -> Vec<u8> {
        take_pcm(&self.buffer)
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

struct MicCapture {
    requested_id: String,
    buffer: Arc<Mutex<Vec<u8>>>,
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

impl MicCapture {
    fn start(requested_id: String, runtime: AudioRuntime) -> Option<Self> {
        let buffer = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let buffer_thread = buffer.clone();
        let stop_thread = stop.clone();
        let id_thread = requested_id.clone();
        let join = thread::Builder::new()
            .name("wasapi-mic".into())
            .spawn(move || {
                let _ = initialize_mta().ok();
                let friendly = device_name(&id_thread).unwrap_or_else(|| "Microphone".into());
                if let Err(err) = mic_loop(&id_thread, buffer_thread, stop_thread.clone(), runtime.clone()) {
                    if !stop_thread.load(Ordering::Relaxed) {
                        tracing::warn!("WASAPI microphone stopped: {err}");
                        runtime.notify_disconnect(&id_thread, &friendly, true);
                    }
                }
            })
            .ok()?;
        Some(Self {
            requested_id,
            buffer,
            stop,
            join: Some(join),
        })
    }

    fn take(&self) -> Vec<u8> {
        take_pcm(&self.buffer)
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
            peak: 0.0,
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

pub fn mix_pcm(loopback: &[u8], mic: &[u8], gain: f32) -> Vec<u8> {
    let loopback = align_frames(loopback);
    let mic = align_frames(mic);
    if mic.is_empty() {
        return loopback.to_vec();
    }
    let gain = gain.clamp(0.0, 2.0);
    if loopback.is_empty() {
        return scale_pcm(mic, gain);
    }
    let loop_samples = pcm_i16(loopback);
    let mic_samples = pcm_i16(mic);
    let len = loop_samples.len().max(mic_samples.len());
    let mut mixed = vec![0i16; len];
    mixed[..loop_samples.len()].copy_from_slice(&loop_samples);
    for (index, sample) in mic_samples.iter().enumerate() {
        let scaled = *sample as f32 * gain;
        mixed[index] = soft_clip_i16(mixed[index] as f32 + scaled);
    }
    i16_to_bytes(&mixed)
}

fn scale_pcm(pcm: &[u8], gain: f32) -> Vec<u8> {
    if (gain - 1.0).abs() < f32::EPSILON {
        return pcm.to_vec();
    }
    let scaled: Vec<i16> = pcm_i16(pcm)
        .into_iter()
        .map(|sample| {
            soft_clip_i16(sample as f32 * gain)
        })
        .collect();
    i16_to_bytes(&scaled)
}

fn loopback_loop(
    buffer: Arc<Mutex<Vec<u8>>>,
    stop: Arc<AtomicBool>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let _ = initialize_mta().ok();
    let device = get_default_device(&Direction::Render)?;
    let mut audio_client = device.get_iaudioclient()?;
    let desired_format = WaveFormat::new(16, 16, &SampleType::Int, MIX_RATE as usize, MIX_CHANNELS as usize, None);
    let (_default_period, min_period) = audio_client.get_device_period()?;
    let mode = StreamMode::EventsShared {
        autoconvert: true,
        buffer_duration_hns: min_period,
    };
    audio_client.initialize_client(&desired_format, &Direction::Capture, &mode)?;
    let event = audio_client.set_get_eventhandle()?;
    let capture_client = audio_client.get_audiocaptureclient()?;
    audio_client.start_stream()?;
    let mut queue = VecDeque::new();
    while !stop.load(Ordering::Relaxed) {
        if event.wait_for_event(200).is_err() {
            continue;
        }
        capture_client.read_from_device_to_deque(&mut queue)?;
        if queue.is_empty() {
            continue;
        }
        append_pcm(&buffer, queue.drain(..));
    }
    let _ = audio_client.stop_stream();
    Ok(())
}

fn mic_loop(
    requested_id: &str,
    buffer: Arc<Mutex<Vec<u8>>>,
    stop: Arc<AtomicBool>,
    runtime: AudioRuntime,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let _ = initialize_mta().ok();
    let device = capture_device(requested_id)?;
    let mut audio_client = device.get_iaudioclient()?;
    let desired_format = WaveFormat::new(16, 16, &SampleType::Int, MIX_RATE as usize, MIX_CHANNELS as usize, None);
    let (_default_period, min_period) = audio_client.get_device_period()?;
    let mode = StreamMode::EventsShared {
        autoconvert: true,
        buffer_duration_hns: min_period,
    };
    audio_client.initialize_client(&desired_format, &Direction::Capture, &mode)?;
    let event = audio_client.set_get_eventhandle()?;
    let capture_client = audio_client.get_audiocaptureclient()?;
    audio_client.start_stream()?;
    let mut queue = VecDeque::new();
    let mut last_presence = Instant::now();
    while !stop.load(Ordering::Relaxed) {
        if event.wait_for_event(200).is_err() {
            if last_presence.elapsed() >= Duration::from_secs(2) {
                if !capture_device_present(requested_id) {
                    return Err("microphone device disappeared".into());
                }
                last_presence = Instant::now();
            }
            continue;
        }
        capture_client.read_from_device_to_deque(&mut queue)?;
        if queue.is_empty() {
            continue;
        }
        let chunk: Vec<u8> = queue.drain(..).collect();
        let gain = f32::from_bits(runtime.inner.gain_bits.load(Ordering::Relaxed)).clamp(0.0, 2.0);
        update_peak(&runtime.inner.peak, &chunk, gain);
        append_pcm(&buffer, chunk.into_iter());
        if last_presence.elapsed() >= Duration::from_secs(2) {
            if !capture_device_present(requested_id) {
                return Err("microphone device disappeared".into());
            }
            last_presence = Instant::now();
        }
    }
    let _ = audio_client.stop_stream();
    Ok(())
}

fn capture_device(id: &str) -> Result<wasapi::Device, Box<dyn std::error::Error + Send + Sync>> {
    let id = normalize_device_id(id);
    if id == "default" {
        return Ok(get_default_device(&Direction::Capture)?);
    }
    let collection = DeviceCollection::new(&Direction::Capture)?;
    for device in &collection {
        let device = device?;
        if device.get_id()? == id {
            return Ok(device);
        }
    }
    Err("microphone device not found".into())
}

fn capture_device_present(id: &str) -> bool {
    capture_device(id).is_ok()
}

fn device_name(id: &str) -> Option<String> {
    capture_device(id)
        .ok()
        .and_then(|device| device.get_friendlyname().ok())
}

fn normalize_device_id(id: &str) -> String {
    let trimmed = id.trim();
    if trimmed.is_empty() {
        "default".into()
    } else {
        trimmed.to_string()
    }
}

fn take_pcm(buffer: &Mutex<Vec<u8>>) -> Vec<u8> {
    buffer
        .lock()
        .map(|mut guard| std::mem::take(&mut *guard))
        .unwrap_or_default()
}

fn append_pcm(buffer: &Mutex<Vec<u8>>, bytes: impl IntoIterator<Item = u8>) {
    if let Ok(mut guard) = buffer.lock() {
        guard.extend(bytes);
        if guard.len() > MAX_BUFFER {
            let overflow = guard.len() - MAX_BUFFER;
            let overflow = overflow - (overflow % FRAME_BYTES);
            if overflow > 0 {
                guard.drain(..overflow);
            }
        }
    }
}

fn align_frames(pcm: &[u8]) -> &[u8] {
    let end = pcm.len() - (pcm.len() % FRAME_BYTES);
    &pcm[..end]
}

fn pcm_i16(pcm: &[u8]) -> Vec<i16> {
    align_frames(pcm)
        .chunks_exact(2)
        .map(|chunk| i16::from_le_bytes([chunk[0], chunk[1]]))
        .collect()
}

fn soft_clip_i16(sample: f32) -> i16 {
    let x = sample / 32768.0;
    let y = x / (1.0 + x.abs() * 0.35);
    (y * 32767.0)
        .round()
        .clamp(i16::MIN as f32, i16::MAX as f32) as i16
}

fn i16_to_bytes(samples: &[i16]) -> Vec<u8> {
    let mut out = Vec::with_capacity(samples.len() * 2);
    for sample in samples {
        out.extend_from_slice(&sample.to_le_bytes());
    }
    out
}

fn update_peak(peak: &AtomicU32, pcm: &[u8], gain: f32) {
    let mut max_abs = 0.0f32;
    for sample in pcm_i16(pcm) {
        max_abs = max_abs.max((sample.abs() as f32 / 32768.0) * gain);
    }
    let new = (max_abs.clamp(0.0, 1.0) * PEAK_SCALE) as u32;
    let decayed = peak.load(Ordering::Relaxed).saturating_mul(85) / 100;
    peak.store(decayed.max(new), Ordering::Relaxed);
}

fn decay_peak(peak: &AtomicU32) {
    let decayed = peak.load(Ordering::Relaxed).saturating_mul(85) / 100;
    peak.store(decayed, Ordering::Relaxed);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_bytes(values: &[i16]) -> Vec<u8> {
        i16_to_bytes(values)
    }

    #[test]
    fn mix_pcm_keeps_loopback_when_mic_silent() {
        let loopback = sample_bytes(&[1000, -1000, 2000, -2000]);
        assert_eq!(mix_pcm(&loopback, &[], 1.0), loopback);
    }

    #[test]
    fn mix_pcm_applies_mic_gain() {
        let loopback = sample_bytes(&[0, 0]);
        let mic = sample_bytes(&[1000, 1000]);
        let mixed = mix_pcm(&loopback, &mic, 2.0);
        assert_eq!(pcm_i16(&mixed), vec![2000, 2000]);
    }

    #[test]
    fn mix_pcm_does_not_wrap_on_clip() {
        let loopback = sample_bytes(&[20_000, 20_000]);
        let mic = sample_bytes(&[20_000, 20_000]);
        let mixed = mix_pcm(&loopback, &mic, 1.0);
        assert_eq!(pcm_i16(&mixed), vec![i16::MAX, i16::MAX]);
    }

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
    fn mix_into_uses_loopback_when_desktop_is_on() {
        let runtime = AudioRuntime::new();
        let mut settings = AppSettings::default();
        settings.system_audio_enabled = true;
        settings.game_audio_enabled = false;
        runtime.apply(&settings);
        let loopback = sample_bytes(&[111, -111, 222, -222]);
        assert_eq!(runtime.mix_into(loopback.clone()), loopback);
    }

    #[test]
    fn mix_into_ignores_loopback_when_desktop_is_off() {
        let runtime = AudioRuntime::new();
        let mut settings = AppSettings::default();
        settings.game_audio_enabled = false;
        assert!(!settings.system_audio_enabled);
        runtime.apply(&settings);
        let loopback = sample_bytes(&[111, -111, 222, -222]);
        assert!(runtime.mix_into(loopback).is_empty());
    }
}
