use std::collections::VecDeque;
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
use windows::Win32::Foundation::{CloseHandle, E_NOINTERFACE, E_POINTER, HANDLE, WAIT_OBJECT_0};
use windows::Win32::Media::Audio::{
    ActivateAudioInterfaceAsync, eMultimedia, eRender, AUDIOCLIENT_ACTIVATION_PARAMS,
    AUDIOCLIENT_ACTIVATION_PARAMS_0, AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
    AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS, AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED,
    AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
    AUDCLNT_STREAMFLAGS_LOOPBACK, AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
    IActivateAudioInterfaceAsyncOperation,
    IActivateAudioInterfaceCompletionHandler, IActivateAudioInterfaceCompletionHandler_Vtbl,
    IAudioCaptureClient, IAudioClient, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator,
    MMDeviceEnumerator, PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
    VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, WAVEFORMATEX, WAVEFORMATEXTENSIBLE, WAVE_FORMAT_PCM,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, BLOB, CLSCTX_ALL, COINIT_MULTITHREADED,
    IAgileObject,
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

struct ReadyClient {
    client: IAudioClient,
    capture: IAudioCaptureClient,
    event: HANDLE,
}

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

fn pcm16_format() -> WAVEFORMATEX {
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

        let event = CreateEventW(None, false, false, None)
            .map_err(|err| format!("pid={pid} CreateEventW: {err}"))?;
        let pcm = pcm16_format();
        let flags = AUDCLNT_STREAMFLAGS_LOOPBACK
            | AUDCLNT_STREAMFLAGS_EVENTCALLBACK
            | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
            | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
        if let Err(err) = client.Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            flags,
            1_000_000,
            0,
            &pcm,
            None,
        ) {
            tracing::warn!(
                "process loopback pid={pid} Initialize failed hr={}: {err}",
                hresult_hex(&err)
            );
            let _ = CloseHandle(event);
            return Err(format!("pid={pid} Initialize hr={}", hresult_hex(&err)));
        }
        tracing::info!("process loopback pid={pid} initialized 48k s16 stereo on activate callback");

        if let Err(err) = client.SetEventHandle(event) {
            let _ = CloseHandle(event);
            return Err(format!("pid={pid} SetEventHandle: {err}"));
        }
        let capture: IAudioCaptureClient = match client.GetService() {
            Ok(capture) => capture,
            Err(err) => {
                let _ = CloseHandle(event);
                return Err(format!("pid={pid} GetService(IAudioCaptureClient): {err}"));
            }
        };
        if let Err(err) = client.Start() {
            let _ = CloseHandle(event);
            return Err(format!("pid={pid} Start: {err}"));
        }
        Ok(ReadyClient {
            client,
            capture,
            event,
        })
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
    buffer: Arc<Mutex<Vec<u8>>>,
    peak: Arc<std::sync::atomic::AtomicU32>,
    stop: Arc<AtomicBool>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let ready = activate_process_client(pid)?;
    let capture = ready.capture;
    let client = ready.client;
    let event = ready.event;
    unsafe {
        let mut queue = VecDeque::new();
        while !stop.load(Ordering::Relaxed) {
            if WaitForSingleObject(event, 200) != WAIT_OBJECT_0 {
                continue;
            }
            loop {
                if capture.GetNextPacketSize().unwrap_or(0) == 0 {
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
                if frames > 0 {
                    let silent = flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0;
                    let bytes = frames as usize * FRAME_BYTES;
                    if silent || data.is_null() {
                        queue.extend(std::iter::repeat(0u8).take(bytes));
                    } else {
                        queue.extend(std::slice::from_raw_parts(data, bytes).iter().copied());
                    }
                }
                let _ = capture.ReleaseBuffer(frames);
            }
            if !queue.is_empty() {
                update_peak(&peak, &queue);
                append_pcm(&buffer, queue.drain(..));
            }
        }
        let _ = client.Stop();
        let _ = CloseHandle(event);
    }
    Ok(())
}

fn resampled_frame_count(in_frames: usize, sample_rate: u32) -> usize {
    if sample_rate == 0 || in_frames == 0 {
        return 0;
    }
    if sample_rate == MIX_RATE {
        return in_frames;
    }
    ((in_frames as u64 * MIX_RATE as u64) / sample_rate as u64) as usize
}

fn convert_to_mix_pcm(data: &[u8], format: &MixFormat) -> Vec<u8> {
    if format.sample_rate == MIX_RATE
        && format.channels == MIX_CHANNELS
        && format.bits == 16
        && !format.is_float
    {
        return data.to_vec();
    }
    let stereo = decode_to_stereo_f32(data, format);
    let resampled = resample_stereo(&stereo, format.sample_rate);
    let mut out = Vec::with_capacity(resampled.len() * 2);
    for sample in resampled {
        let pcm = (sample.clamp(-1.0, 1.0) * 32767.0) as i16;
        out.extend_from_slice(&pcm.to_le_bytes());
    }
    out
}

fn decode_to_stereo_f32(data: &[u8], format: &MixFormat) -> Vec<f32> {
    let channels = format.channels as usize;
    let frame_bytes = format.block_align as usize;
    if channels == 0 || frame_bytes == 0 {
        return Vec::new();
    }
    let frames = data.len() / frame_bytes;
    let mut samples = Vec::with_capacity(frames.saturating_mul(2));
    for index in 0..frames {
        let frame = &data[index * frame_bytes..];
        let left = sample_at(frame, 0, format);
        let right = if channels == 1 {
            left
        } else {
            sample_at(frame, 1, format)
        };
        samples.push(left);
        samples.push(right);
    }
    samples
}

fn sample_at(frame: &[u8], channel: usize, format: &MixFormat) -> f32 {
    let bytes_per_sample = match format.bits {
        8 => 1,
        16 => 2,
        24 => 3,
        32 => 4,
        64 => 8,
        _ => return 0.0,
    };
    let offset = channel * bytes_per_sample;
    if offset + bytes_per_sample > frame.len() {
        return 0.0;
    }
    let slice = &frame[offset..offset + bytes_per_sample];
    if format.is_float {
        return match format.bits {
            32 => f32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]),
            64 => f64::from_le_bytes([
                slice[0], slice[1], slice[2], slice[3], slice[4], slice[5], slice[6], slice[7],
            ]) as f32,
            _ => 0.0,
        };
    }
    match format.bits {
        8 => (slice[0] as f32 - 128.0) / 128.0,
        16 => i16::from_le_bytes([slice[0], slice[1]]) as f32 / 32768.0,
        24 => {
            let value = i32::from_le_bytes([
                slice[0],
                slice[1],
                slice[2],
                if slice[2] & 0x80 != 0 { 0xFF } else { 0 },
            ]);
            value as f32 / 8_388_608.0
        }
        32 => i32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]) as f32 / 2_147_483_648.0,
        _ => 0.0,
    }
}

fn resample_stereo(samples: &[f32], from_rate: u32) -> Vec<f32> {
    if from_rate == MIX_RATE || from_rate == 0 {
        return samples.to_vec();
    }
    let in_frames = samples.len() / 2;
    if in_frames == 0 {
        return Vec::new();
    }
    let out_frames = resampled_frame_count(in_frames, from_rate);
    if out_frames == 0 {
        return Vec::new();
    }
    let mut out = vec![0.0f32; out_frames * 2];
    for index in 0..out_frames {
        let src = index as f64 * from_rate as f64 / MIX_RATE as f64;
        let first = (src.floor() as usize).min(in_frames - 1);
        let next = (first + 1).min(in_frames - 1);
        let frac = (src - first as f64) as f32;
        for channel in 0..2 {
            let a = samples[first * 2 + channel];
            let b = samples[next * 2 + channel];
            out[index * 2 + channel] = a + (b - a) * frac;
        }
    }
    out
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

#[cfg(test)]
mod tests {
    use super::*;

    fn pcm16_stereo(rate: u32) -> MixFormat {
        MixFormat {
            channels: 2,
            sample_rate: rate,
            bits: 16,
            block_align: 4,
            is_float: false,
        }
    }

    #[test]
    fn passthrough_already_mix_format() {
        let input = [0x00, 0x10, 0x00, 0x20];
        assert_eq!(convert_to_mix_pcm(&input, &pcm16_stereo(MIX_RATE)), input);
    }

    #[test]
    fn float_stereo_converts_to_s16() {
        let format = MixFormat {
            channels: 2,
            sample_rate: MIX_RATE,
            bits: 32,
            block_align: 8,
            is_float: true,
        };
        let mut input = Vec::new();
        input.extend_from_slice(&0.5f32.to_le_bytes());
        input.extend_from_slice(&(-0.5f32).to_le_bytes());
        let out = convert_to_mix_pcm(&input, &format);
        assert_eq!(out.len(), 4);
        let left = i16::from_le_bytes([out[0], out[1]]);
        let right = i16::from_le_bytes([out[2], out[3]]);
        assert!((left - 16383).abs() <= 1);
        assert!((right + 16383).abs() <= 1);
    }

    #[test]
    fn float_packet_reported_as_s16_frames_keeps_duration() {
        let mut input = Vec::new();
        for _ in 0..2 {
            input.extend_from_slice(&0.25f32.to_le_bytes());
            input.extend_from_slice(&(-0.25f32).to_le_bytes());
        }
        let reported_s16_frames = (input.len() / 4) as u32;
        let format = MixFormat {
            channels: 2,
            sample_rate: MIX_RATE,
            bits: 32,
            block_align: 8,
            is_float: true,
        };
        let out = convert_to_mix_pcm(&input, &format);
        assert_eq!(out.len(), (reported_s16_frames as usize / 2) * FRAME_BYTES);
    }

    #[test]
    fn mono_is_duplicated_to_stereo() {
        let format = MixFormat {
            channels: 1,
            sample_rate: MIX_RATE,
            bits: 16,
            block_align: 2,
            is_float: false,
        };
        let input = 12_000i16.to_le_bytes();
        let out = convert_to_mix_pcm(&input, &format);
        assert_eq!(&out[..2], &input);
        assert_eq!(&out[2..], &input);
    }
}
