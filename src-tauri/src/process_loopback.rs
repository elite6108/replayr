use std::collections::VecDeque;
use std::ffi::c_void;
use std::mem::size_of;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use windows::core::{Interface, IUnknown, Result as WinResult, GUID, HRESULT};
use windows::Win32::Foundation::{CloseHandle, E_NOINTERFACE, E_POINTER, HANDLE, WAIT_OBJECT_0};
use windows::Win32::Media::Audio::{
    ActivateAudioInterfaceAsync, eMultimedia, eRender, AUDIOCLIENT_ACTIVATION_PARAMS,
    AUDIOCLIENT_ACTIVATION_PARAMS_0, AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
    AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
    AUDCLNT_STREAMFLAGS_EVENTCALLBACK, AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, IActivateAudioInterfaceAsyncOperation,
    IActivateAudioInterfaceCompletionHandler, IActivateAudioInterfaceCompletionHandler_Vtbl,
    IAudioCaptureClient, IAudioClient, IAudioSessionControl2,
    IAudioSessionManager2, IMMDeviceEnumerator, MMDeviceEnumerator, PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
    VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, WAVEFORMATEX, WAVE_FORMAT_PCM,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, BLOB, CLSCTX_ALL, COINIT_MULTITHREADED,
};
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};
use windows::Win32::System::Variant::VT_BLOB;

use crate::audio_resolve::AudioSessionRef;
use crate::games::normalize_process_name;
use crate::process::list_processes;

const MIX_RATE: u32 = 48_000;
const MIX_CHANNELS: u16 = 2;
const FRAME_BYTES: usize = 4;
const MAX_BUFFER: usize = MIX_RATE as usize * FRAME_BYTES;
const ACTIVATE_TIMEOUT: Duration = Duration::from_secs(3);

pub struct ProcessLoopbackCapture {
    buffer: Arc<Mutex<Vec<u8>>>,
    peak: Arc<std::sync::atomic::AtomicU32>,
    failed: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

impl ProcessLoopbackCapture {
    pub fn start(pid: u32) -> Option<Self> {
        if pid == 0 {
            return None;
        }
        let buffer = Arc::new(Mutex::new(Vec::new()));
        let peak = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let failed = Arc::new(AtomicBool::new(false));
        let stop = Arc::new(AtomicBool::new(false));
        let buffer_thread = buffer.clone();
        let peak_thread = peak.clone();
        let failed_thread = failed.clone();
        let stop_thread = stop.clone();
        let join = thread::Builder::new()
            .name(format!("wasapi-proc-{pid}"))
            .spawn(move || {
                if let Err(err) = process_loopback_loop(pid, buffer_thread, peak_thread, stop_thread.clone()) {
                    if !stop_thread.load(Ordering::Relaxed) {
                        failed_thread.store(true, Ordering::Relaxed);
                        tracing::warn!("process loopback pid={pid} stopped: {err}");
                    }
                }
            })
            .ok()?;
        Some(Self {
            buffer,
            peak,
            failed,
            stop,
            join: Some(join),
        })
    }

    pub fn take(&self) -> Vec<u8> {
        self.buffer
            .lock()
            .map(|mut guard| std::mem::take(&mut *guard))
            .unwrap_or_default()
    }

    pub fn peak(&self) -> f32 {
        self.peak.load(Ordering::Relaxed) as f32 / 10_000.0
    }

    pub fn failed(&self) -> bool {
        self.failed.load(Ordering::Relaxed)
    }
}

impl Drop for ProcessLoopbackCapture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AudioSessionInfo {
    pub pid: u32,
    pub exe: String,
    pub display_name: String,
}

pub fn os_build_number() -> u32 {
    #[repr(C)]
    struct RtlOsVersionInfo {
        dw_os_version_info_size: u32,
        dw_major_version: u32,
        dw_minor_version: u32,
        dw_build_number: u32,
        dw_platform_id: u32,
        sz_csd_version: [u16; 128],
    }

    #[link(name = "ntdll")]
    extern "system" {
        fn RtlGetVersion(info: *mut RtlOsVersionInfo) -> i32;
    }

    let mut info = RtlOsVersionInfo {
        dw_os_version_info_size: size_of::<RtlOsVersionInfo>() as u32,
        dw_major_version: 0,
        dw_minor_version: 0,
        dw_build_number: 0,
        dw_platform_id: 0,
        sz_csd_version: [0; 128],
    };
    unsafe {
        if RtlGetVersion(&mut info) == 0 {
            info.dw_build_number
        } else {
            0
        }
    }
}

pub fn list_audio_sessions() -> Result<Vec<AudioSessionInfo>, String> {
    let (tx, rx) = mpsc::channel();
    thread::Builder::new()
        .name("list-audio-sessions".into())
        .spawn(move || {
            let _ = tx.send(list_audio_sessions_inner());
        })
        .map_err(|err| err.to_string())?;
    rx.recv_timeout(ACTIVATE_TIMEOUT)
        .map_err(|_| "list_audio_sessions timed out".to_string())?
}

fn list_audio_sessions_inner() -> Result<Vec<AudioSessionInfo>, String> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|err| err.to_string())?;
        let device = enumerator
            .GetDefaultAudioEndpoint(eRender, eMultimedia)
            .map_err(|err| err.to_string())?;
        let manager: IAudioSessionManager2 = device
            .Activate(CLSCTX_ALL, None)
            .map_err(|err| err.to_string())?;
        let sessions = manager.GetSessionEnumerator().map_err(|err| err.to_string())?;
        let count = sessions.GetCount().map_err(|err| err.to_string())?;
        let processes = list_processes();
        let mut out = Vec::new();
        for index in 0..count {
            let control = match sessions.GetSession(index) {
                Ok(control) => control,
                Err(_) => continue,
            };
            let control2: IAudioSessionControl2 = match control.cast() {
                Ok(control2) => control2,
                Err(_) => continue,
            };
            let pid = match control2.GetProcessId() {
                Ok(pid) if pid != 0 => pid,
                _ => continue,
            };
            let display = pwstr_to_string(control.GetDisplayName().ok());
            let exe = processes
                .iter()
                .find(|process| process.pid == pid)
                .map(|process| process.name.clone())
                .unwrap_or_default();
            if exe.is_empty() && display.is_empty() {
                continue;
            }
            out.push(AudioSessionInfo {
                pid,
                display_name: if display.is_empty() {
                    exe_display_name(&exe)
                } else {
                    display
                },
                exe,
            });
        }
        Ok(out)
    }
}

pub fn sessions_as_refs(sessions: &[AudioSessionInfo]) -> Vec<AudioSessionRef> {
    sessions
        .iter()
        .map(|session| AudioSessionRef {
            pid: session.pid,
            exe: session.exe.clone(),
            display_name: session.display_name.clone(),
        })
        .collect()
}

fn exe_display_name(exe: &str) -> String {
    let name = normalize_process_name(exe);
    name.trim_end_matches(".exe").to_string()
}

fn pwstr_to_string(value: Option<windows::core::PWSTR>) -> String {
    let Some(ptr) = value else {
        return String::new();
    };
    if ptr.is_null() {
        return String::new();
    }
    let text = unsafe { ptr.to_string() }.unwrap_or_default();
    unsafe {
        CoTaskMemFree(Some(ptr.as_ptr() as *const _));
    }
    text
}

#[repr(C)]
struct ActivationHandler {
    vtbl: *const IActivateAudioInterfaceCompletionHandler_Vtbl,
    refs: AtomicI32,
    tx: Mutex<Option<mpsc::Sender<WinResult<IAudioClient>>>>,
}

static HANDLER_VTBL: IActivateAudioInterfaceCompletionHandler_Vtbl = IActivateAudioInterfaceCompletionHandler_Vtbl {
    base__: windows::core::IUnknown_Vtbl {
        QueryInterface: handler_query_interface,
        AddRef: handler_add_ref,
        Release: handler_release,
    },
    ActivateCompleted: handler_activate_completed,
};

unsafe extern "system" fn handler_query_interface(
    this: *mut c_void,
    iid: *const GUID,
    out: *mut *mut c_void,
) -> HRESULT {
    if iid.is_null() || out.is_null() {
        return E_POINTER;
    }
    let iid = unsafe { *iid };
    if iid == IUnknown::IID || iid == IActivateAudioInterfaceCompletionHandler::IID {
        unsafe {
            *out = this;
        }
        handler_add_ref(this);
        HRESULT(0)
    } else {
        unsafe {
            *out = std::ptr::null_mut();
        }
        E_NOINTERFACE
    }
}

unsafe extern "system" fn handler_add_ref(this: *mut c_void) -> u32 {
    let handler = unsafe { &*this.cast::<ActivationHandler>() };
    handler.refs.fetch_add(1, Ordering::Relaxed) as u32 + 1
}

unsafe extern "system" fn handler_release(this: *mut c_void) -> u32 {
    let handler = unsafe { &*this.cast::<ActivationHandler>() };
    let remaining = handler.refs.fetch_sub(1, Ordering::Release) - 1;
    if remaining == 0 {
        std::sync::atomic::fence(Ordering::Acquire);
        drop(unsafe { Box::from_raw(this.cast::<ActivationHandler>()) });
    }
    remaining as u32
}

unsafe extern "system" fn handler_activate_completed(this: *mut c_void, operation: *mut c_void) -> HRESULT {
    let handler = unsafe { &*this.cast::<ActivationHandler>() };
    let result = if operation.is_null() {
        Err(windows::core::Error::from(E_POINTER))
    } else {
        let Some(op) = (unsafe { IActivateAudioInterfaceAsyncOperation::from_raw_borrowed(&operation) }) else {
            return HRESULT(0);
        };
        let mut hr = HRESULT(0);
        let mut unknown = None;
        let got = unsafe { op.GetActivateResult(&mut hr, &mut unknown) };
        got.and_then(|_| {
            hr.ok()?;
            unknown
                .ok_or_else(|| windows::core::Error::from(E_POINTER))
                .and_then(|unk| unk.cast::<IAudioClient>())
        })
    };
    if let Ok(mut slot) = handler.tx.lock() {
        if let Some(tx) = slot.take() {
            let _ = tx.send(result);
        }
    }
    HRESULT(0)
}

fn activate_process_client(pid: u32) -> Result<IAudioClient, String> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let mut params = Box::new(AUDIOCLIENT_ACTIVATION_PARAMS {
            ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
            Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
                ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                    TargetProcessId: pid,
                    ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
                },
            },
        });
        let mut activate_params = std::mem::ManuallyDrop::new(PROPVARIANT::default());
        {
            let inner = &mut activate_params.Anonymous.Anonymous;
            inner.vt = VT_BLOB;
            inner.Anonymous.blob = BLOB {
                cbSize: size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
                pBlobData: std::ptr::from_mut(&mut *params).cast(),
            };
        }
        let (tx, rx) = mpsc::channel();
        let handler_ptr = Box::into_raw(Box::new(ActivationHandler {
            vtbl: &HANDLER_VTBL,
            refs: AtomicI32::new(1),
            tx: Mutex::new(Some(tx)),
        }));
        let handler = IActivateAudioInterfaceCompletionHandler::from_raw(handler_ptr.cast());
        let op = ActivateAudioInterfaceAsync(
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
            &IAudioClient::IID,
            Some(&*activate_params),
            &handler,
        );
        let result = match op {
            Ok(_keep_alive) => rx
                .recv_timeout(ACTIVATE_TIMEOUT)
                .map_err(|_| "process loopback activate timed out".to_string())
                .and_then(|client| client.map_err(|err| err.to_string())),
            Err(err) => Err(err.to_string()),
        };
        drop(handler);
        result
    }
}

fn mix_format() -> WAVEFORMATEX {
    WAVEFORMATEX {
        wFormatTag: WAVE_FORMAT_PCM as u16,
        nChannels: MIX_CHANNELS,
        nSamplesPerSec: MIX_RATE,
        nAvgBytesPerSec: MIX_RATE * MIX_CHANNELS as u32 * 2,
        nBlockAlign: MIX_CHANNELS * 2,
        wBitsPerSample: 16,
        cbSize: 0,
    }
}

fn process_loopback_loop(
    pid: u32,
    buffer: Arc<Mutex<Vec<u8>>>,
    peak: Arc<std::sync::atomic::AtomicU32>,
    stop: Arc<AtomicBool>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let client = activate_process_client(pid)?;
    let format = mix_format();
    let flags = AUDCLNT_STREAMFLAGS_EVENTCALLBACK
        | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
        | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
    unsafe {
        client.Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            flags,
            10_000_000,
            0,
            &format,
            None,
        )?;
        let event = CreateEventW(None, false, false, None)?;
        client.SetEventHandle(event)?;
        let capture: IAudioCaptureClient = client.GetService()?;
        client.Start()?;
        let mut queue = VecDeque::new();
        while !stop.load(Ordering::Relaxed) {
            if WaitForSingleObject(event, 200) != WAIT_OBJECT_0 {
                continue;
            }
            loop {
                let mut packet_frames = 0u32;
                if capture.GetNextPacketSize().map(|size| {
                    packet_frames = size;
                    size
                }).unwrap_or(0) == 0 {
                    break;
                }
                let mut data = std::ptr::null_mut();
                let mut frames = 0u32;
                let mut flags = 0u32;
                if capture
                    .GetBuffer(&mut data, &mut frames, &mut flags, None, None)
                    .is_err()
                {
                    break;
                }
                if !data.is_null() && frames > 0 {
                    let bytes = frames as usize * FRAME_BYTES;
                    queue.extend(std::slice::from_raw_parts(data, bytes).iter().copied());
                }
                let _ = capture.ReleaseBuffer(frames);
            }
            if !queue.is_empty() {
                update_peak(&peak, &queue);
                append_pcm(&buffer, queue.drain(..));
            }
        }
        let _ = client.Stop();
        let _ = CloseHandle(HANDLE(event.0));
    }
    Ok(())
}

fn append_pcm(buffer: &Mutex<Vec<u8>>, bytes: impl IntoIterator<Item = u8>) {
    if let Ok(mut guard) = buffer.lock() {
        guard.extend(bytes);
        if guard.len() > MAX_BUFFER {
            let overflow = guard.len() - MAX_BUFFER;
            guard.drain(..overflow);
        }
    }
}

fn update_peak(peak: &std::sync::atomic::AtomicU32, pcm: &VecDeque<u8>) {
    let mut max_abs = 0.0f32;
    let mut bytes = pcm.iter().copied();
    while let (Some(low), Some(high)) = (bytes.next(), bytes.next()) {
        let sample = i16::from_le_bytes([low, high]);
        max_abs = max_abs.max(sample.unsigned_abs() as f32 / 32768.0);
    }
    let new = (max_abs.clamp(0.0, 1.0) * 10_000.0) as u32;
    let decayed = peak.load(Ordering::Relaxed).saturating_mul(85) / 100;
    peak.store(decayed.max(new), Ordering::Relaxed);
}
