//! One WASAPI capture loop for every source kind.
//!
//! Microphone, desktop loopback, and per-process loopback all run through the
//! same raw `IAudioCaptureClient` path so they share the parts that matter for
//! quality: a device buffer large enough to survive a scheduling hiccup, the
//! QPC position on every packet, and the discontinuity flag that says a gap is
//! real rather than jitter.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
use windows::Win32::Media::Audio::{
    eCapture, eConsole, eMultimedia, eRender, AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY,
    AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
    AUDCLNT_STREAMFLAGS_EVENTCALLBACK, AUDCLNT_STREAMFLAGS_LOOPBACK,
    AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, IAudioCaptureClient, IAudioClient, IMMDevice,
    IMMDeviceEnumerator, MMDeviceEnumerator, WAVEFORMATEX, WAVE_FORMAT_PCM,
};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};
use windows::Win32::System::Threading::WaitForSingleObject;

use crate::audio_timeline::{
    qpc_hns, MixSink, SourceControl, SourceCursor, MIX_CHANNELS, MIX_RATE,
};

const FRAME_BYTES: usize = MIX_CHANNELS * 2;

/// 100 ms. The old mic and desktop paths asked for the minimum device period
/// (about 3 ms) while being drained from a 16 ms video callback, which loses
/// packets on any hiccup. Process loopback already used this value.
const BUFFER_HNS: i64 = 1_000_000;

const PRESENCE_INTERVAL: Duration = Duration::from_secs(2);

pub struct ReadyClient {
    pub client: IAudioClient,
    pub capture: IAudioCaptureClient,
    pub event: HANDLE,
}

impl ReadyClient {
    pub fn close(self) {
        unsafe {
            let _ = self.client.Stop();
            let _ = CloseHandle(self.event);
        }
    }
}

/// 48 kHz stereo s16. Combined with `AUTOCONVERTPCM` this makes every source
/// arrive in one format, so the mixer never has to resample.
pub fn mix_format() -> WAVEFORMATEX {
    WAVEFORMATEX {
        wFormatTag: WAVE_FORMAT_PCM as u16,
        nChannels: MIX_CHANNELS as u16,
        nSamplesPerSec: MIX_RATE,
        nAvgBytesPerSec: MIX_RATE * FRAME_BYTES as u32,
        nBlockAlign: FRAME_BYTES as u16,
        wBitsPerSample: 16,
        cbSize: 0,
    }
}

pub fn stream_flags(loopback: bool) -> u32 {
    let mut flags = AUDCLNT_STREAMFLAGS_EVENTCALLBACK
        | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
        | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
    if loopback {
        flags |= AUDCLNT_STREAMFLAGS_LOOPBACK;
    }
    flags
}

fn enumerator() -> Result<IMMDeviceEnumerator, String> {
    unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|err| err.to_string()) }
}

pub fn default_render_device() -> Result<IMMDevice, String> {
    unsafe {
        enumerator()?
            .GetDefaultAudioEndpoint(eRender, eMultimedia)
            .map_err(|err| err.to_string())
    }
}

/// `id` is a device id, or "default"/empty for the default capture endpoint.
pub fn capture_device(id: &str) -> Result<IMMDevice, String> {
    let id = id.trim();
    unsafe {
        let enumerator = enumerator()?;
        if id.is_empty() || id == "default" {
            return enumerator
                .GetDefaultAudioEndpoint(eCapture, eConsole)
                .map_err(|err| err.to_string());
        }
        let wide: Vec<u16> = id.encode_utf16().chain(std::iter::once(0)).collect();
        enumerator
            .GetDevice(windows::core::PCWSTR(wide.as_ptr()))
            .map_err(|_| "microphone device not found".to_string())
    }
}

pub fn capture_device_present(id: &str) -> bool {
    capture_device(id).is_ok()
}

pub fn open_device_client(device: &IMMDevice, loopback: bool) -> Result<ReadyClient, String> {
    unsafe {
        let client: IAudioClient = device
            .Activate(CLSCTX_ALL, None)
            .map_err(|err| format!("Activate(IAudioClient): {err}"))?;
        let format = mix_format();
        client
            .Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                stream_flags(loopback),
                BUFFER_HNS,
                0,
                &format,
                None,
            )
            .map_err(|err| format!("Initialize: {err}"))?;
        finish_client(client)
    }
}

/// Wires up the event handle and capture service on an already-initialized
/// client, then starts it.
pub fn finish_client(client: IAudioClient) -> Result<ReadyClient, String> {
    use windows::Win32::System::Threading::CreateEventW;
    unsafe {
        let event = CreateEventW(None, false, false, None)
            .map_err(|err| format!("CreateEventW: {err}"))?;
        if let Err(err) = client.SetEventHandle(event) {
            let _ = CloseHandle(event);
            return Err(format!("SetEventHandle: {err}"));
        }
        let capture: IAudioCaptureClient = match client.GetService() {
            Ok(capture) => capture,
            Err(err) => {
                let _ = CloseHandle(event);
                return Err(format!("GetService(IAudioCaptureClient): {err}"));
            }
        };
        if let Err(err) = client.Start() {
            let _ = CloseHandle(event);
            return Err(format!("Start: {err}"));
        }
        Ok(ReadyClient {
            client,
            capture,
            event,
        })
    }
}

/// Drains packets until `stop`, stamping each with its timeline position and
/// summing it into `sink`.
///
/// `on_idle` runs about every two seconds and can end the loop, which is how
/// the microphone path notices its device has been unplugged.
pub fn run_capture_loop(
    ready: &ReadyClient,
    sink: &Arc<MixSink>,
    control: &Arc<SourceControl>,
    stop: &AtomicBool,
    mut on_idle: impl FnMut() -> Result<(), String>,
) -> Result<(), String> {
    let mut cursor = SourceCursor::new();
    let mut samples: Vec<i16> = Vec::new();
    let mut last_idle = Instant::now();
    unsafe {
        while !stop.load(Ordering::Relaxed) {
            let signalled = WaitForSingleObject(ready.event, 200) == WAIT_OBJECT_0;
            if last_idle.elapsed() >= PRESENCE_INTERVAL {
                on_idle()?;
                last_idle = Instant::now();
            }
            if !signalled {
                continue;
            }
            loop {
                if ready.capture.GetNextPacketSize().unwrap_or(0) == 0 {
                    break;
                }
                let mut data = std::ptr::null_mut();
                let mut frames = 0u32;
                let mut flags = 0u32;
                let mut qpc = 0u64;
                if ready
                    .capture
                    .GetBuffer(&mut data, &mut frames, &mut flags, None, Some(&mut qpc))
                    .is_err()
                {
                    break;
                }
                if frames > 0 {
                    let silent = flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0;
                    let discontinuity =
                        flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY.0 as u32 != 0;
                    samples.clear();
                    samples.resize(frames as usize * MIX_CHANNELS, 0);
                    if !silent && !data.is_null() {
                        let bytes =
                            std::slice::from_raw_parts(data, frames as usize * FRAME_BYTES);
                        for (index, chunk) in bytes.chunks_exact(2).enumerate() {
                            samples[index] = i16::from_le_bytes([chunk[0], chunk[1]]);
                        }
                    }
                    // A QPC of zero means the driver did not report a position;
                    // fall back to now so the cursor still has something sane.
                    let stamp = if qpc == 0 { qpc_hns() } else { qpc as i64 };
                    let (at, gap) = cursor.resolve(
                        sink.epoch(),
                        sink.frame_at(stamp),
                        i64::from(frames),
                        discontinuity,
                    );
                    let gain = control.gain();
                    if control.enabled() {
                        sink.note_gap(gap);
                        sink.mix(at, &samples, gain);
                        control.note_mixed(u64::from(frames));
                    }
                    control.observe_peak(&samples, gain);
                }
                let _ = ready.capture.ReleaseBuffer(frames);
            }
        }
    }
    Ok(())
}

/// Desktop meter tap. Reads the same WASAPI loopback as recording but never
/// mixes into `MixSink`, so Legacy/composed capture is not doubled.
pub fn run_peak_only_loop(
    ready: &ReadyClient,
    control: &Arc<SourceControl>,
    stop: &AtomicBool,
) -> Result<(), String> {
    let mut samples: Vec<i16> = Vec::new();
    unsafe {
        while !stop.load(Ordering::Relaxed) {
            let signalled = WaitForSingleObject(ready.event, 200) == WAIT_OBJECT_0;
            if !signalled {
                control.decay_peak();
                continue;
            }
            loop {
                if ready.capture.GetNextPacketSize().unwrap_or(0) == 0 {
                    break;
                }
                let mut data = std::ptr::null_mut();
                let mut frames = 0u32;
                let mut flags = 0u32;
                if ready
                    .capture
                    .GetBuffer(&mut data, &mut frames, &mut flags, None, None)
                    .is_err()
                {
                    break;
                }
                if frames > 0 {
                    let silent = flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0;
                    samples.clear();
                    samples.resize(frames as usize * MIX_CHANNELS, 0);
                    if !silent && !data.is_null() {
                        let bytes =
                            std::slice::from_raw_parts(data, frames as usize * FRAME_BYTES);
                        for (index, chunk) in bytes.chunks_exact(2).enumerate() {
                            samples[index] = i16::from_le_bytes([chunk[0], chunk[1]]);
                        }
                    }
                    control.observe_peak(&samples, control.gain());
                }
                let _ = ready.capture.ReleaseBuffer(frames);
            }
        }
    }
    Ok(())
}
