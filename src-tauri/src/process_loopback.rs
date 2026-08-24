use std::ffi::c_void;
use std::mem::size_of;
use std::ptr;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use windows::core::{Interface, IUnknown, GUID, HRESULT};
use windows::Win32::Foundation::{E_NOINTERFACE, E_POINTER};
use windows::Win32::Media::Audio::{
    ActivateAudioInterfaceAsync, eMultimedia, eRender, AUDIOCLIENT_ACTIVATION_PARAMS,
    AUDIOCLIENT_ACTIVATION_PARAMS_0, AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
    AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS, AUDCLNT_SHAREMODE_SHARED,
    IActivateAudioInterfaceAsyncOperation,
    IActivateAudioInterfaceCompletionHandler, IActivateAudioInterfaceCompletionHandler_Vtbl,
    IAudioClient, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator,
    MMDeviceEnumerator, PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
    VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, WAVEFORMATEX, WAVEFORMATEXTENSIBLE, WAVE_FORMAT_PCM,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, BLOB, CLSCTX_ALL, COINIT_MULTITHREADED,
    IAgileObject,
};
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
use windows::Win32::System::Variant::VT_BLOB;

use crate::audio_capture::{finish_client, mix_format, run_capture_loop, stream_flags, ReadyClient};
use crate::audio_resolve::AudioSessionRef;
use crate::audio_timeline::{MixSink, SourceControl};
use crate::games::normalize_process_name;
use crate::process::list_processes;

const ACTIVATE_TIMEOUT: Duration = Duration::from_secs(3);
const WAVE_FORMAT_IEEE_FLOAT: u16 = 3;
const WAVE_FORMAT_EXTENSIBLE: u16 = 0xFFFE;
const KSDATAFORMAT_SUBTYPE_PCM: GUID = GUID::from_u128(0x0000_0001_0000_0010_8000_00aa_0038_9b71);
const KSDATAFORMAT_SUBTYPE_IEEE_FLOAT: GUID = GUID::from_u128(0x0000_0003_0000_0010_8000_00aa_0038_9b71);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct MixFormat {
    channels: u16,
    sample_rate: u32,
    bits: u16,
    block_align: u16,
    is_float: bool,
}

pub struct ProcessLoopbackCapture {
    control: Arc<SourceControl>,
    failed: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

impl ProcessLoopbackCapture {
    pub fn start(pid: u32, sink: Arc<MixSink>, enabled: bool, gain: f32) -> Option<Self> {
        if pid == 0 {
            return None;
        }
        let control = Arc::new(SourceControl::new(enabled, gain));
        let failed = Arc::new(AtomicBool::new(false));
        let stop = Arc::new(AtomicBool::new(false));
        let control_thread = control.clone();
        let failed_thread = failed.clone();
        let stop_thread = stop.clone();
        let join = thread::Builder::new()
            .name(format!("wasapi-proc-{pid}"))
            .spawn(move || {
                if let Err(err) =
                    process_loopback_loop(pid, &sink, &control_thread, &stop_thread)
                {
                    if !stop_thread.load(Ordering::Relaxed) {
                        failed_thread.store(true, Ordering::Relaxed);
                        tracing::warn!("process loopback pid={pid} stopped: {err}");
                    }
                }
            })
            .ok()?;
        Some(Self {
            control,
            failed,
            stop,
            join: Some(join),
        })
    }

    pub fn control(&self) -> &Arc<SourceControl> {
        &self.control
    }

    pub fn peak(&self) -> f32 {
        self.control.peak()
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
    pid: u32,
    tx: Mutex<Option<mpsc::Sender<Result<ReadyClient, String>>>>,
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
    if iid == IUnknown::IID
        || iid == IActivateAudioInterfaceCompletionHandler::IID
        || iid == IAgileObject::IID
    {
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
        Err(format!(
            "pid={} activate completed with a null operation",
            handler.pid
        ))
    } else {
        let Some(op) = (unsafe { IActivateAudioInterfaceAsyncOperation::from_raw_borrowed(&operation) }) else {
            return HRESULT(0);
        };
        let mut hr = HRESULT(0);
        let mut unknown = None;
        let got = unsafe { op.GetActivateResult(&mut hr, &mut unknown) };
        match got.and_then(|_| {
            hr.ok()?;
            unknown
                .ok_or_else(|| windows::core::Error::from(E_POINTER))
                .and_then(|unk| unk.cast::<IAudioClient>())
        }) {
            Ok(client) => initialize_ready_client(client, handler.pid),
            Err(err) => {
                tracing::warn!(
                    "process loopback pid={} GetActivateResult failed hr={}: {err}",
                    handler.pid,
                    hresult_hex(&err)
                );
                Err(format!("pid={} activate: {err}", handler.pid))
            }
        }
    };
    if let Ok(mut slot) = handler.tx.lock() {
        if let Some(tx) = slot.take() {
            let _ = tx.send(result);
        }
    }
    HRESULT(0)
}

fn activate_process_client(pid: u32) -> Result<ReadyClient, String> {
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
            pid,
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
                .map_err(|_| format!("pid={pid} process loopback activate timed out"))
                .and_then(|ready| ready),
            Err(err) => {
                tracing::warn!(
                    "process loopback pid={pid} ActivateAudioInterfaceAsync failed hr={}: {err}",
                    hresult_hex(&err)
                );
                Err(format!("pid={pid} activate: {err}"))
            }
        };
        drop(handler);
        result
    }
}

fn hresult_hex(err: &windows::core::Error) -> String {
    format!("{:#010x}", err.code().0 as u32)
}

fn initialize_ready_client(client: IAudioClient, pid: u32) -> Result<ReadyClient, String> {
    unsafe {
        if let Ok(mix_ptr) = client.GetMixFormat() {
            if !mix_ptr.is_null() {
                match parse_mix_format(mix_ptr) {
                    Ok(parsed) => tracing::info!(
                        "process loopback pid={pid} mix format {}ch {}Hz {}bit {}",
                        parsed.channels,
                        parsed.sample_rate,
                        parsed.bits,
                        if parsed.is_float { "float" } else { "pcm" }
                    ),
                    Err(err) => tracing::warn!("process loopback pid={pid} mix format unreadable: {err}"),
                }
                CoTaskMemFree(Some(mix_ptr.cast()));
            }
        } else {
            tracing::info!(
                "process loopback pid={pid} GetMixFormat unavailable; initializing 48k s16 stereo"
            );
        }

        let pcm = mix_format();
        if let Err(err) = client.Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            stream_flags(true),
            1_000_000,
            0,
            &pcm,
            None,
        ) {
            tracing::warn!(
                "process loopback pid={pid} Initialize failed hr={}: {err}",
                hresult_hex(&err)
            );
            return Err(format!("pid={pid} Initialize hr={}", hresult_hex(&err)));
        }
        tracing::info!("process loopback pid={pid} initialized 48k s16 stereo on activate callback");
        finish_client(client).map_err(|err| format!("pid={pid} {err}"))
    }
}

fn parse_mix_format(fmt: *const WAVEFORMATEX) -> Result<MixFormat, String> {
    if fmt.is_null() {
        return Err("null mix format".into());
    }
    let tag = unsafe { ptr::read_unaligned(ptr::addr_of!((*fmt).wFormatTag)) };
    let channels = unsafe { ptr::read_unaligned(ptr::addr_of!((*fmt).nChannels)) };
    let sample_rate = unsafe { ptr::read_unaligned(ptr::addr_of!((*fmt).nSamplesPerSec)) };
    let bits = unsafe { ptr::read_unaligned(ptr::addr_of!((*fmt).wBitsPerSample)) };
    let block_align = unsafe { ptr::read_unaligned(ptr::addr_of!((*fmt).nBlockAlign)) };
    let cb_size = unsafe { ptr::read_unaligned(ptr::addr_of!((*fmt).cbSize)) };
    let mut is_float = tag == WAVE_FORMAT_IEEE_FLOAT;
    if tag == WAVE_FORMAT_EXTENSIBLE && cb_size >= 22 {
        let ext = fmt.cast::<WAVEFORMATEXTENSIBLE>();
        let sub = unsafe { ptr::read_unaligned(ptr::addr_of!((*ext).SubFormat)) };
        if sub == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT {
            is_float = true;
        } else if sub == KSDATAFORMAT_SUBTYPE_PCM {
            is_float = false;
        } else {
            return Err(format!("unsupported mix SubFormat {sub:?}"));
        }
    } else if tag != WAVE_FORMAT_PCM as u16 && tag != WAVE_FORMAT_IEEE_FLOAT {
        return Err(format!("unsupported mix format tag {tag}"));
    }
    if channels == 0 || sample_rate == 0 || block_align == 0 {
        return Err("invalid mix format".into());
    }
    Ok(MixFormat {
        channels,
        sample_rate,
        bits,
        block_align,
        is_float,
    })
}

fn process_loopback_loop(
    pid: u32,
    sink: &Arc<MixSink>,
    control: &Arc<SourceControl>,
    stop: &AtomicBool,
) -> Result<(), String> {
    let ready = activate_process_client(pid)?;
    let result = run_capture_loop(&ready, sink, control, stop, || Ok(()));
    ready.close();
    result
}

