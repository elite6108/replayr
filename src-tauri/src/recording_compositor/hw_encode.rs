//! Session-only H.264 ingest for composed recording.
//! A D3D11-aware hardware encoder receives a DXGI NV12 surface. When none configures,
//! the Windows software H.264 MFT receives a system-memory copy of that frame.
//! Instant Replay and clips never call this.

#![cfg(windows)]

use std::collections::VecDeque;
use std::mem::ManuallyDrop;
use std::path::Path;
use std::time::{Duration, Instant};

use windows::core::Interface;
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Device, ID3D11DeviceContext, ID3D11Resource, ID3D11Texture2D, D3D11_MAPPED_SUBRESOURCE,
    D3D11_MAP_READ, D3D11_TEXTURE2D_DESC,
};
use windows::Win32::Media::MediaFoundation::{
    IMFActivate, IMFDXGIDeviceManager, IMFMediaEventGenerator, IMFMediaType, IMFSample,
    IMFTransform, MEError, METransformDrainComplete, METransformHaveOutput, METransformNeedInput,
    MFCreateDXGISurfaceBuffer, MFCreateMediaType, MFCreateMemoryBuffer, MFCreateSample,
    MFCreateVideoSampleFromSurface, MFMediaType_Video, MFSampleExtension_CleanPoint, MFTEnumEx,
    MFT_CATEGORY_VIDEO_ENCODER, MFT_ENUM_FLAG_ALL, MFT_FRIENDLY_NAME_Attribute,
    MFT_MESSAGE_COMMAND_DRAIN, MFT_MESSAGE_NOTIFY_BEGIN_STREAMING,
    MFT_MESSAGE_NOTIFY_END_OF_STREAM, MFT_MESSAGE_NOTIFY_END_STREAMING,
    MFT_MESSAGE_NOTIFY_START_OF_STREAM, MFT_MESSAGE_SET_D3D_MANAGER, MFT_OUTPUT_DATA_BUFFER,
    MFT_OUTPUT_STREAM_PROVIDES_SAMPLES, MFT_REGISTER_TYPE_INFO, MFT_TRANSFORM_CLSID_Attribute,
    MFVideoFormat_H264, MFVideoFormat_NV12, MFVideoInterlace_Progressive, MF_EVENT_FLAG_NO_WAIT,
    MF_MT_AVG_BITRATE, MF_MT_DEFAULT_STRIDE, MF_MT_FIXED_SIZE_SAMPLES, MF_MT_FRAME_RATE,
    MF_MT_FRAME_RATE_RANGE_MAX, MF_MT_FRAME_RATE_RANGE_MIN, MF_MT_FRAME_SIZE,
    MF_MT_INTERLACE_MODE, MF_MT_MAJOR_TYPE, MF_MT_MPEG2_LEVEL, MF_MT_MPEG2_PROFILE,
    MF_MT_MPEG_SEQUENCE_HEADER, MF_MT_PIXEL_ASPECT_RATIO, MF_MT_SAMPLE_SIZE, MF_MT_SUBTYPE,
    MF_SA_D3D11_AWARE, MF_TRANSFORM_ASYNC, MF_TRANSFORM_ASYNC_UNLOCK,
};
use windows::Win32::System::Com::CoTaskMemFree;

use crate::export::mux::H264Mp4Mux;

use super::gpu::{create_bgra_staging, create_nv12_encode};
use super::session_aac::SessionAacEncoder;

/// Proven 1080p60 defaults used only when a caller asks for the safety-net size.
const FALLBACK_ENCODER_W: u32 = 1920;
const FALLBACK_ENCODER_H: u32 = 1080;
const MFT_SET_TYPE_TEST_ONLY: u32 = 1;
/// Same depth as `gpu_dxgi` `VP_OUTPUT_RING`. A 3-slot pool stalls an async HMFT.
const POOL: usize = 16;
const EVENT_WAIT: Duration = Duration::from_secs(8);
/// Same as `gpu_dxgi` `COMPOSE_DRAIN_TIMEOUT`.
const DRAIN_TIMEOUT: Duration = Duration::from_secs(15);
const HNS_PER_SECOND: i64 = 10_000_000;
const MF_E_TRANSFORM_NEED_MORE_INPUT: u32 = 0xC00D6D72;
const MF_E_NOTACCEPTING: u32 = 0xC00D36B5;

struct SoftwareReadback {
    context: ID3D11DeviceContext,
    staging: ID3D11Texture2D,
}

#[derive(Debug, Clone, Default)]
pub struct EncoderPipelineStats {
    pub process_input: u64,
    pub process_output: u64,
    pub muxed: u64,
    pub first_input_hns: Option<i64>,
    pub last_input_hns: Option<i64>,
    pub first_encoded_hns: Option<i64>,
    pub last_encoded_hns: Option<i64>,
    pub first_mux_hns: Option<i64>,
    pub last_mux_hns: Option<i64>,
    pub surfaces_acquired: u64,
    pub surfaces_released: u64,
    pub max_in_flight: u64,
    pub wait_count: u64,
    pub drain: &'static str,
    pub audio_track_created: bool,
    pub audio_encoder_input_frames: u64,
    pub audio_encoded_packets: u64,
    pub audio_muxed_packets: u64,
    pub first_audio_hns: Option<i64>,
    pub last_audio_hns: Option<i64>,
    pub audio_pending_bytes: u64,
}

pub struct ComposedGpuEncoder {
    transform: IMFTransform,
    events: Option<IMFMediaEventGenerator>,
    software: bool,
    readback: Option<SoftwareReadback>,
    mux: Option<H264Mp4Mux>,
    mux_path: std::path::PathBuf,
    pool: Vec<ID3D11Texture2D>,
    in_flight: VecDeque<usize>,
    need_input: u32,
    name: String,
    width: u32,
    height: u32,
    fps: u32,
    logged_first: bool,
    stats: EncoderPipelineStats,
    include_audio: bool,
    aac: Option<SessionAacEncoder>,
    pending_pcm: Vec<u8>,
}

impl ComposedGpuEncoder {
    pub fn open(
        device: &ID3D11Device,
        manager: &IMFDXGIDeviceManager,
        path: &Path,
        width: u32,
        height: u32,
        fps: u32,
        bitrate: u32,
        include_audio: bool,
    ) -> Result<Self, String> {
        let width = if width == 0 { FALLBACK_ENCODER_W } else { width };
        let height = if height == 0 { FALLBACK_ENCODER_H } else { height };
        let fps = fps.clamp(24, 60);
        tracing::info!(
            input_width = width,
            input_height = height,
            output_width = width,
            output_height = height,
            fps,
            "composed encoder resolved integer canvas before SetInputType"
        );
        if width == 0 || height == 0 || width % 2 != 0 || height % 2 != 0 {
            return Err("encoder canvas is invalid".into());
        }
        let prepared = prepare_encoder(manager, width, height, fps, bitrate)?;
        let events = if prepared.software {
            None
        } else {
            Some(prepared.transform.cast().map_err(|err| {
                format!("encoder has no event generator: {err}")
            })?)
        };
        // Do not open the mux here. GetOutputCurrentType before the first encoded
        // sample often lacks MF_MT_MPEG_SEQUENCE_HEADER (SPS/PPS). That is the
        // known-good gpu_dxgi rule and the likely unplayable/~2s GOP symptom.
        // Software MFTs take a CPU NV12 buffer. Skip NV12 GPU textures so a driver
        // that rejects DXGI_FORMAT_NV12 (E_INVALIDARG) can still open.
        let mut pool = Vec::new();
        let readback = if prepared.software {
            let context = unsafe { device.GetImmediateContext() }
                .map_err(|err| format!("D3D11 immediate context: {err}"))?;
            Some(SoftwareReadback {
                context,
                staging: create_bgra_staging(device, width, height)?,
            })
        } else {
            pool.reserve(POOL);
            for _ in 0..POOL {
                pool.push(create_nv12_encode(device, width, height)?);
            }
            None
        };
        tracing::info!(
            encoder = %prepared.name,
            software_fallback = prepared.software,
            input = if prepared.software { "BGRA" } else { "NV12" },
            output = "H264",
            negotiate_w = width,
            negotiate_h = height,
            fps,
            d3d_aware = ?prepared.aware,
            pool = pool.len(),
            mux_ready = false,
            include_audio,
            "composed encoder media types accepted; mux waits for first H.264 sample"
        );
        let aac = if include_audio {
            Some(SessionAacEncoder::open()?)
        } else {
            None
        };
        Ok(Self {
            transform: prepared.transform,
            events,
            software: prepared.software,
            readback,
            mux: None,
            mux_path: path.to_path_buf(),
            pool,
            in_flight: VecDeque::new(),
            need_input: 0,
            name: prepared.name,
            width,
            height,
            fps,
            logged_first: false,
            stats: EncoderPipelineStats::default(),
            include_audio,
            aac,
            pending_pcm: Vec::new(),
        })
    }

    pub fn width(&self) -> u32 {
        self.width
    }

    pub fn height(&self) -> u32 {
        self.height
    }

    pub fn fps(&self) -> u32 {
        self.fps
    }

    /// Advisory TEST_ONLY + real SetOutput/SetInput on the same MFT path.
    /// Used to walk the resolution ladder before opening the compositor.
    pub fn probe_candidate(
        manager: &IMFDXGIDeviceManager,
        width: u32,
        height: u32,
        fps: u32,
        bitrate: u32,
    ) -> Result<(), String> {
        let width = if width == 0 { FALLBACK_ENCODER_W } else { width };
        let height = if height == 0 { FALLBACK_ENCODER_H } else { height };
        let fps = fps.clamp(24, 60);
        if width % 2 != 0 || height % 2 != 0 {
            return Err("candidate dimensions must be even".into());
        }
        let _prepared = prepare_encoder(manager, width, height, fps, bitrate)?;
        Ok(())
    }

    pub fn frame_duration_hns(&self) -> i64 {
        HNS_PER_SECOND / i64::from(self.fps.max(1))
    }

    pub fn sample_time_hns(&self, frame_index: u64) -> i64 {
        i64::try_from(frame_index)
            .unwrap_or(i64::MAX)
            .saturating_mul(HNS_PER_SECOND)
            / i64::from(self.fps.max(1))
    }

    pub fn pipeline_stats(&self) -> EncoderPipelineStats {
        self.stats.clone()
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn software_fallback(&self) -> bool {
        self.software
    }

    pub fn has_audio(&self) -> bool {
        self.include_audio
    }

    pub fn acquire(&mut self) -> Result<usize, String> {
        if self.software {
            self.stats.surfaces_acquired = self.stats.surfaces_acquired.saturating_add(1);
            return Ok(0);
        }
        let deadline = Instant::now() + EVENT_WAIT;
        let mut waited = false;
        loop {
            self.pump(false)?;
            if let Some(index) = (0..self.pool.len()).find(|index| !self.in_flight.contains(index)) {
                if waited {
                    self.stats.wait_count = self.stats.wait_count.saturating_add(1);
                }
                self.stats.surfaces_acquired = self.stats.surfaces_acquired.saturating_add(1);
                return Ok(index);
            }
            waited = true;
            if Instant::now() > deadline {
                return Err("Composed GPU encoder did not release a surface. Update your graphics driver and try again.".into());
            }
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    pub fn texture(&self, index: usize) -> &ID3D11Texture2D {
        &self.pool[index]
    }

    /// Software H.264 reads the composed BGRA canvas. No NV12 GPU texture is required.
    pub fn submit_bgra(
        &mut self,
        canvas: &ID3D11Texture2D,
        time_hns: i64,
        duration_hns: i64,
    ) -> Result<(), String> {
        if !self.software {
            return Err("hardware encoder expects an NV12 surface".into());
        }
        if !self.logged_first {
            log_handoff(
                &self.name,
                canvas,
                self.width,
                self.height,
                self.fps,
                time_hns,
                duration_hns,
                true,
            );
            self.logged_first = true;
        }
        self.submit_software(canvas, time_hns, duration_hns)
    }

    pub fn submit(&mut self, index: usize, time_hns: i64, duration_hns: i64) -> Result<(), String> {
        if self.software {
            return Err("software encoder reads the composed BGRA canvas".into());
        }
        if !self.logged_first {
            log_handoff(
                &self.name,
                &self.pool[index],
                self.width,
                self.height,
                self.fps,
                time_hns,
                duration_hns,
                false,
            );
            self.logged_first = true;
        }
        let texture = &self.pool[index];
        let sample = wrap_surface(texture, time_hns, duration_hns)?;
        self.wait_need_input()?;
        unsafe {
            self.transform
                .ProcessInput(0, &sample, 0)
                .map_err(|err| {
                    format!(
                        "Composed GPU encoder ProcessInput failed: process_hr={:#x} {err}",
                        err.code().0 as u32
                    )
                })?;
        }
        self.need_input = self.need_input.saturating_sub(1);
        self.in_flight.push_back(index);
        self.stats.process_input = self.stats.process_input.saturating_add(1);
        self.stats.max_in_flight = self.stats.max_in_flight.max(self.in_flight.len() as u64);
        if self.stats.first_input_hns.is_none() {
            self.stats.first_input_hns = Some(time_hns);
        }
        self.stats.last_input_hns = Some(time_hns);
        self.pump(false)?;
        Ok(())
    }

    pub fn write_pcm(&mut self, pcm: &[u8]) -> Result<(), String> {
        self.write_pcm_inner(pcm, false)
    }

    pub fn write_pcm_closing(&mut self, pcm: &[u8]) -> Result<(), String> {
        // Last MixSink bytes only. AAC drain happens in finish() after video drain.
        self.write_pcm_inner(pcm, false)
    }

    fn write_pcm_inner(&mut self, pcm: &[u8], closing: bool) -> Result<(), String> {
        if !self.include_audio {
            return Ok(());
        }
        const ALIGN: usize = 4;
        const PENDING_CAP: usize = 48_000 * 4 * 4; // 4 s of 48 kHz stereo s16
        let aligned = pcm.len() - (pcm.len() % ALIGN);
        if aligned > 0 {
            self.pending_pcm.extend_from_slice(&pcm[..aligned]);
            self.stats.audio_encoder_input_frames = self
                .stats
                .audio_encoder_input_frames
                .saturating_add((aligned / ALIGN) as u64);
        }
        if self.pending_pcm.len() > PENDING_CAP {
            self.pending_pcm.truncate(PENDING_CAP);
            tracing::warn!("composed audio prebuffer is full; later packets wait for the mux");
        }
        self.stats.audio_pending_bytes = self.pending_pcm.len() as u64;
        if self.mux.as_ref().is_some_and(|mux| mux.has_audio()) {
            self.flush_pending_audio(closing)
        } else {
            Ok(())
        }
    }

    fn flush_pending_audio(&mut self, closing: bool) -> Result<(), String> {
        if self.aac.is_none() {
            self.pending_pcm.clear();
            return Ok(());
        }
        if self.mux.as_ref().is_none_or(|mux| !mux.has_audio()) {
            return Ok(());
        }
        let pcm = std::mem::take(&mut self.pending_pcm);
        let packets = self
            .aac
            .as_mut()
            .expect("aac checked")
            .encode(&pcm, closing)?;
        self.stats.audio_encoded_packets = self
            .stats
            .audio_encoded_packets
            .saturating_add(packets.len() as u64);
        let mux = self.mux.as_mut().expect("mux checked");
        for (sample, duration) in packets {
            if self.stats.first_audio_hns.is_none() {
                self.stats.first_audio_hns = Some(mux.audio_time_hns());
            }
            mux.write_audio(&sample, duration)?;
            self.stats.last_audio_hns = Some(mux.audio_time_hns());
            self.stats.audio_muxed_packets = self.stats.audio_muxed_packets.saturating_add(1);
        }
        self.stats.audio_track_created = mux.has_audio();
        self.stats.audio_pending_bytes = 0;
        Ok(())
    }

    pub fn finish(&mut self) -> Result<(), String> {
        if self.software {
            return self.finish_software();
        }
        send_message(&self.transform, MFT_MESSAGE_NOTIFY_END_OF_STREAM);
        send_message(&self.transform, MFT_MESSAGE_COMMAND_DRAIN);
        self.stats.drain = "drain_sent";
        let deadline = Instant::now() + DRAIN_TIMEOUT;
        let mut drain_complete = false;
        while Instant::now() < deadline && !drain_complete {
            drain_complete = self.pump(true)?;
            if drain_complete {
                break;
            }
            std::thread::sleep(Duration::from_millis(1));
        }
        send_message(&self.transform, MFT_MESSAGE_NOTIFY_END_STREAMING);
        self.stats.drain = if drain_complete {
            "drain_complete"
        } else {
            "drain_timeout"
        };
        if !drain_complete {
            tracing::warn!(
                in_flight = self.in_flight.len(),
                "composed encoder drain timed out; finalizing mux with samples already written"
            );
        }
        self.finish_mux()
    }

    fn wait_need_input(&mut self) -> Result<(), String> {
        let deadline = Instant::now() + EVENT_WAIT;
        while self.need_input == 0 {
            self.pump(false)?;
            if self.need_input > 0 {
                return Ok(());
            }
            if Instant::now() > deadline {
                return Err("Composed GPU encoder did not request input. Update your graphics driver and try again.".into());
            }
            std::thread::sleep(Duration::from_millis(1));
        }
        Ok(())
    }

    fn pump(&mut self, draining: bool) -> Result<bool, String> {
        if self.software {
            return Ok(false);
        }
        let mut drain_complete = false;
        loop {
            let event = {
                let Some(events) = self.events.as_ref() else {
                    return Err("composed encoder has no event generator".into());
                };
                match unsafe { events.GetEvent(MF_EVENT_FLAG_NO_WAIT) } {
                    Ok(event) => event,
                    Err(_) => break,
                }
            };
            let ty = unsafe { event.GetType().unwrap_or(0) };
            let status = unsafe { event.GetStatus().ok() };
            if status.is_some_and(|hr| hr.is_err()) || ty == MEError.0 as u32 {
                return Err("Composed GPU encoder reported an error. Update your graphics driver and try again.".into());
            }
            if ty == METransformNeedInput.0 as u32 && !draining {
                self.need_input = self.need_input.saturating_add(1);
            } else if ty == METransformHaveOutput.0 as u32 {
                self.take_and_mux()?;
            } else if ty == METransformDrainComplete.0 as u32 {
                drain_complete = true;
            }
        }
        Ok(drain_complete)
    }

    fn take_and_mux(&mut self) -> Result<(), String> {
        let Some(nalu) = take_output(&self.transform)? else {
            return Err("encoder ProcessOutput returned no sample".into());
        };
        self.mux_nalu(nalu)
    }

    fn submit_software(
        &mut self,
        canvas: &ID3D11Texture2D,
        time_hns: i64,
        duration_hns: i64,
    ) -> Result<(), String> {
        let bytes = {
            let readback = self
                .readback
                .as_ref()
                .ok_or_else(|| "software encoder has no readback surface".to_string())?;
            read_bgra(
                &readback.context,
                &readback.staging,
                canvas,
                self.width,
                self.height,
            )?
        };
        let sample = wrap_nv12_memory(&bytes, time_hns, duration_hns)?;
        self.software_process_input(&sample)?;
        self.stats.process_input = self.stats.process_input.saturating_add(1);
        if self.stats.first_input_hns.is_none() {
            self.stats.first_input_hns = Some(time_hns);
        }
        self.stats.last_input_hns = Some(time_hns);
        self.stats.surfaces_released = self.stats.surfaces_released.saturating_add(1);
        Ok(())
    }

    fn software_process_input(&mut self, sample: &IMFSample) -> Result<(), String> {
        let first = unsafe { self.transform.ProcessInput(0, sample, 0) };
        if let Err(err) = first {
            if err.code().0 as u32 != MF_E_NOTACCEPTING {
                return Err(format!(
                    "ProcessInput hr={:#x} {err}",
                    err.code().0 as u32
                ));
            }
            self.pull_software(8)?;
            unsafe { self.transform.ProcessInput(0, sample, 0) }.map_err(|err| {
                format!("ProcessInput hr={:#x} {err}", err.code().0 as u32)
            })?;
        }
        self.pull_software(8)
    }

    fn pull_software(&mut self, limit: u32) -> Result<(), String> {
        let mut pulled = 0u32;
        while pulled < limit {
            match take_output(&self.transform)? {
                Some(nalu) => {
                    self.mux_nalu(nalu)?;
                    pulled = pulled.saturating_add(1);
                }
                None => return Ok(()),
            }
        }
        Err("software H.264 encoder produced more samples than one frame can hold".into())
    }

    fn finish_software(&mut self) -> Result<(), String> {
        send_message(&self.transform, MFT_MESSAGE_NOTIFY_END_OF_STREAM);
        send_message(&self.transform, MFT_MESSAGE_COMMAND_DRAIN);
        self.stats.drain = "drain_sent";
        let deadline = Instant::now() + DRAIN_TIMEOUT;
        let mut pulled = 0u32;
        while Instant::now() < deadline && pulled < 64 {
            match take_output(&self.transform)? {
                Some(nalu) => {
                    self.mux_nalu(nalu)?;
                    pulled = pulled.saturating_add(1);
                }
                None => {
                    self.stats.drain = "drain_complete";
                    break;
                }
            }
        }
        if self.stats.drain != "drain_complete" {
            self.stats.drain = "drain_timeout";
            tracing::warn!(
                "software H.264 drain timed out; finalizing mux with samples already written"
            );
        }
        send_message(&self.transform, MFT_MESSAGE_NOTIFY_END_STREAMING);
        self.finish_mux()
    }

    fn mux_nalu(&mut self, nalu: EncodedNalu) -> Result<(), String> {
        self.stats.process_output = self.stats.process_output.saturating_add(1);
        let encoded_time = unsafe { nalu.sample.GetSampleTime().ok() };
        if self.stats.first_encoded_hns.is_none() {
            self.stats.first_encoded_hns = encoded_time;
        }
        if let Some(time) = encoded_time {
            self.stats.last_encoded_hns = Some(time);
        }
        if self.mux.is_none() {
            let video_type = unsafe { self.transform.GetOutputCurrentType(0) }.map_err(|err| {
                format!(
                    "GetOutputCurrentType after first H.264 hr={:#x} {err}",
                    err.code().0 as u32
                )
            })?;
            log_mux_type(&video_type);
            let audio_type = self.aac.as_ref().map(|aac| aac.output_type());
            self.mux = Some(H264Mp4Mux::create(
                &self.mux_path,
                &video_type,
                audio_type.as_ref(),
            )?);
            self.stats.audio_track_created = self.mux.as_ref().is_some_and(|mux| mux.has_audio());
            tracing::info!(
                audio_track = self.stats.audio_track_created,
                software_fallback = self.software,
                "composed mux opened from encoder output type after first H.264 sample"
            );
            self.flush_pending_audio(false)?;
        }
        if let Some(mux) = self.mux.as_mut() {
            mux.write_video(&nalu.sample)?;
            self.stats.muxed = self.stats.muxed.saturating_add(1);
            if self.stats.first_mux_hns.is_none() {
                self.stats.first_mux_hns = encoded_time;
            }
            if let Some(time) = encoded_time {
                self.stats.last_mux_hns = Some(time);
            }
            if self.stats.muxed == 1 {
                tracing::info!(
                    mux_write_sample_hr = "0x0",
                    timestamp = encoded_time,
                    "composed first mux WriteSample"
                );
            }
        }
        if self.in_flight.pop_front().is_some() {
            self.stats.surfaces_released = self.stats.surfaces_released.saturating_add(1);
        }
        Ok(())
    }

    fn finish_mux(&mut self) -> Result<(), String> {
        self.log_pipeline("composed encoder finish");
        if let Err(err) = self.flush_pending_audio(true) {
            tracing::warn!("composed AAC flush failed: {err}");
        }
        match self.mux.take() {
            Some(mux) => mux.finish(),
            None => {
                if self.stats.process_input == 0 {
                    Ok(())
                } else {
                    Err("composed encoder produced no H.264 samples".into())
                }
            }
        }
    }

    fn log_pipeline(&self, at: &str) {
        tracing::info!(
            at,
            process_input_count = self.stats.process_input,
            process_output_count = self.stats.process_output,
            encoded_packet_count = self.stats.process_output,
            muxed_video_packet_count = self.stats.muxed,
            first_input_hns = self.stats.first_input_hns,
            last_input_hns = self.stats.last_input_hns,
            first_encoded_hns = self.stats.first_encoded_hns,
            last_encoded_hns = self.stats.last_encoded_hns,
            first_mux_hns = self.stats.first_mux_hns,
            last_mux_hns = self.stats.last_mux_hns,
            surfaces_acquired = self.stats.surfaces_acquired,
            surfaces_released = self.stats.surfaces_released,
            max_in_flight = self.stats.max_in_flight,
            in_flight = self.in_flight.len(),
            wait_count = self.stats.wait_count,
            drain = self.stats.drain,
            pool = POOL,
            "composed encoder pipeline"
        );
    }
}

struct EnumeratedEncoder {
    name: String,
    clsid: String,
    activate: IMFActivate,
}

struct PreparedEncoder {
    name: String,
    transform: IMFTransform,
    software: bool,
    aware: Option<bool>,
}

fn prepare_encoder(
    manager: &IMFDXGIDeviceManager,
    width: u32,
    height: u32,
    fps: u32,
    bitrate: u32,
) -> Result<PreparedEncoder, String> {
    let _ = crate::camera::encoder::log_h264_inventory();
    let candidates = enumerate_h264_candidates()?;
    let names: Vec<String> = candidates.iter().map(|item| item.name.clone()).collect();
    let ranked = crate::camera::encoder::rank_h264_encoder_names(&names);
    tracing::info!(
        candidates = ?names,
        ranked = ?ranked,
        "composed H.264 encoder rank"
    );
    let mut errors = Vec::new();
    for name in &ranked {
        let Some(candidate) = candidates
            .iter()
            .find(|item| item.name.eq_ignore_ascii_case(name))
        else {
            continue;
        };
        let software = crate::camera::encoder::is_software_h264_name(&candidate.name);
        match try_encoder_candidate(candidate, software, manager, width, height, fps, bitrate) {
            Ok(prepared) => {
                tracing::info!(
                    encoder = %prepared.name,
                    software_fallback = prepared.software,
                    d3d_aware = ?prepared.aware,
                    "composed encoder selected"
                );
                return Ok(prepared);
            }
            Err(err) => {
                tracing::warn!(
                    encoder = %candidate.name,
                    software,
                    error = %err,
                    "composed encoder candidate skipped"
                );
                errors.push(format!("{}: {err}", candidate.name));
            }
        }
    }
    let found = if names.is_empty() {
        "none".to_string()
    } else {
        names.join(", ")
    };
    let last = errors
        .last()
        .map(|err| format!(" Last error: {err}"))
        .unwrap_or_default();
    Err(format!("no usable H.264 encoder. Found: {found}.{last}"))
}

fn try_encoder_candidate(
    candidate: &EnumeratedEncoder,
    software: bool,
    manager: &IMFDXGIDeviceManager,
    width: u32,
    height: u32,
    fps: u32,
    bitrate: u32,
) -> Result<PreparedEncoder, String> {
    let transform = unsafe { candidate.activate.ActivateObject::<IMFTransform>() }
        .map_err(|err| format!("could not activate: {err}"))?;
    let aware = d3d11_aware(&transform);
    if !software && aware == Some(false) {
        return Err("encoder is not D3D11-aware".into());
    }
    configure_encoder(
        &transform,
        manager,
        &candidate.name,
        &candidate.clsid,
        aware,
        fps,
        bitrate,
        width,
        height,
        software,
    )?;
    verify_configured_types(&transform, width, height, fps)?;
    if !software {
        let _events: IMFMediaEventGenerator = transform
            .cast()
            .map_err(|err| format!("encoder has no event generator: {err}"))?;
    }
    Ok(PreparedEncoder {
        name: candidate.name.clone(),
        transform,
        software,
        aware,
    })
}

fn enumerate_h264_candidates() -> Result<Vec<EnumeratedEncoder>, String> {
    let output = MFT_REGISTER_TYPE_INFO {
        guidMajorType: MFMediaType_Video,
        guidSubtype: MFVideoFormat_H264,
    };
    let mut raw: *mut Option<IMFActivate> = std::ptr::null_mut();
    let mut count = 0u32;
    let result = unsafe {
        MFTEnumEx(
            MFT_CATEGORY_VIDEO_ENCODER,
            MFT_ENUM_FLAG_ALL,
            None,
            Some(&output),
            &mut raw,
            &mut count,
        )
    };
    if result.is_err() || raw.is_null() || count == 0 {
        if !raw.is_null() {
            unsafe { CoTaskMemFree(Some(raw as *const std::ffi::c_void)) };
        }
        return Err("no H.264 MFT was enumerated".into());
    }
    let slice = unsafe { std::slice::from_raw_parts_mut(raw, count as usize) };
    let mut candidates = Vec::new();
    for slot in slice.iter_mut() {
        let Some(activate) = slot.take() else {
            continue;
        };
        let name = unsafe { friendly_name(&activate) };
        let clsid = unsafe { activate_clsid(&activate) };
        if name.is_empty() {
            continue;
        }
        candidates.push(EnumeratedEncoder {
            name,
            clsid,
            activate,
        });
    }
    unsafe { CoTaskMemFree(Some(raw as *const std::ffi::c_void)) };
    if candidates.is_empty() {
        return Err("no H.264 MFT was enumerated".into());
    }
    Ok(candidates)
}

unsafe fn friendly_name(activate: &IMFActivate) -> String {
    let mut pwstr = windows::core::PWSTR::null();
    let mut len = 0u32;
    if activate
        .GetAllocatedString(&MFT_FRIENDLY_NAME_Attribute, &mut pwstr, &mut len)
        .is_ok()
        && !pwstr.is_null()
    {
        let value = pwstr.to_string().unwrap_or_default();
        CoTaskMemFree(Some(pwstr.0 as *const std::ffi::c_void));
        value
    } else {
        String::new()
    }
}

unsafe fn activate_clsid(activate: &IMFActivate) -> String {
    match activate.GetGUID(&MFT_TRANSFORM_CLSID_Attribute) {
        Ok(guid) => format!("{guid:?}"),
        Err(_) => "unknown".into(),
    }
}

fn d3d11_aware(transform: &IMFTransform) -> Option<bool> {
    unsafe {
        let attrs = transform.GetAttributes().ok()?;
        match attrs.GetUINT32(&MF_SA_D3D11_AWARE) {
            Ok(value) => Some(value != 0),
            Err(_) => None,
        }
    }
}

fn configure_encoder(
    transform: &IMFTransform,
    manager: &IMFDXGIDeviceManager,
    name: &str,
    clsid: &str,
    aware: Option<bool>,
    fps: u32,
    bitrate: u32,
    canvas_w: u32,
    canvas_h: u32,
    system_memory: bool,
) -> Result<(), String> {
    let (input_stream, output_stream) = stream_ids(transform);
    let async_mft = unsafe {
        transform
            .GetAttributes()
            .ok()
            .and_then(|attrs| attrs.GetUINT32(&MF_TRANSFORM_ASYNC).ok())
            .unwrap_or(0)
            != 0
    };
    unsafe {
        if async_mft {
            if let Ok(attrs) = transform.GetAttributes() {
                attrs
                    .SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1)
                    .map_err(|err| format!("MF_TRANSFORM_ASYNC_UNLOCK hr={:#x}", err.code().0 as u32))?;
            }
        }
        if !system_memory && aware != Some(false) {
            transform
                .ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, manager.as_raw() as usize)
                .map_err(|err| format!("SET_D3D_MANAGER hr={:#x}", err.code().0 as u32))?;
        }
    }
    let output_type = known_good_h264_output(canvas_w, canvas_h, fps, bitrate)?;
    let input_type = known_good_nv12_input(canvas_w, canvas_h, fps)?;
    if system_memory {
        let sample_bytes = canvas_w.saturating_mul(canvas_h).saturating_mul(3) / 2;
        unsafe {
            input_type
                .SetUINT32(&MF_MT_DEFAULT_STRIDE, canvas_w)
                .map_err(|err| format!("MF_MT_DEFAULT_STRIDE hr={:#x}", err.code().0 as u32))?;
            input_type
                .SetUINT32(&MF_MT_SAMPLE_SIZE, sample_bytes)
                .map_err(|err| format!("MF_MT_SAMPLE_SIZE hr={:#x}", err.code().0 as u32))?;
            input_type
                .SetUINT32(&MF_MT_FIXED_SIZE_SAMPLES, 1)
                .map_err(|err| format!("MF_MT_FIXED_SIZE_SAMPLES hr={:#x}", err.code().0 as u32))?;
        }
    }
    dump_media_type("composed output type before SetOutputType", &output_type);
    dump_media_type("composed input type before SetInputType", &input_type);
    log_negotiation(
        name,
        clsid,
        async_mft,
        aware,
        fps,
        bitrate,
        input_stream,
        output_stream,
        canvas_w,
        canvas_h,
        fps,
    );
    unsafe {
        transform
            .SetOutputType(0, &output_type, 0)
            .map_err(|err| format!("SetOutputType hr={:#x} {err}", err.code().0 as u32))?;
        tracing::info!(set_output_type_hr = "0x0", "composed encoder SetOutputType");
        log_available_inputs(transform);
        match transform.SetInputType(0, &input_type, MFT_SET_TYPE_TEST_ONLY) {
            Ok(()) => tracing::info!(
                set_input_type_test_only_hr = "0x0",
                fps,
                width = canvas_w,
                height = canvas_h,
                "composed encoder SetInputType TEST_ONLY"
            ),
            Err(err) => tracing::warn!(
                set_input_type_test_only_hr = format!("{:#x}", err.code().0 as u32),
                fps,
                width = canvas_w,
                height = canvas_h,
                %err,
                "composed encoder SetInputType TEST_ONLY"
            ),
        }
        transform
            .SetInputType(0, &input_type, 0)
            .map_err(|err| format!("SetInputType hr={:#x} {err}", err.code().0 as u32))?;
        tracing::info!(set_input_type_hr = "0x0", "composed encoder SetInputType");
        let _ = transform.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0);
        let _ = transform.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0);
    }
    Ok(())
}

fn verify_configured_types(
    transform: &IMFTransform,
    expect_w: u32,
    expect_h: u32,
    expect_fps: u32,
) -> Result<(), String> {
    unsafe {
        let input = transform
            .GetInputCurrentType(0)
            .map_err(|err| format!("GetInputCurrentType hr={:#x}", err.code().0 as u32))?;
        let output = transform
            .GetOutputCurrentType(0)
            .map_err(|err| format!("GetOutputCurrentType hr={:#x}", err.code().0 as u32))?;
        let (in_w, in_h, in_fps) = read_frame_geometry(&input)?;
        let (out_w, out_h, out_fps) = read_frame_geometry(&output)?;
        if in_w != expect_w || in_h != expect_h {
            return Err(format!(
                "encoder input current type {in_w}x{in_h} != candidate {expect_w}x{expect_h}"
            ));
        }
        if out_w != expect_w || out_h != expect_h {
            return Err(format!(
                "encoder output current type {out_w}x{out_h} != candidate {expect_w}x{expect_h}"
            ));
        }
        if in_fps != expect_fps || out_fps != expect_fps {
            return Err(format!(
                "encoder fps input={in_fps} output={out_fps} != candidate {expect_fps}"
            ));
        }
        tracing::info!(
            input = format!("{in_w}x{in_h}@{in_fps}"),
            output = format!("{out_w}x{out_h}@{out_fps}"),
            "composed encoder current media types match candidate"
        );
    }
    Ok(())
}

fn read_frame_geometry(media: &IMFMediaType) -> Result<(u32, u32, u32), String> {
    unsafe {
        let size = media
            .GetUINT64(&MF_MT_FRAME_SIZE)
            .map_err(|err| format!("MF_MT_FRAME_SIZE hr={:#x}", err.code().0 as u32))?;
        let rate = media
            .GetUINT64(&MF_MT_FRAME_RATE)
            .map_err(|err| format!("MF_MT_FRAME_RATE hr={:#x}", err.code().0 as u32))?;
        let width = (size >> 32) as u32;
        let height = size as u32;
        let num = (rate >> 32) as u32;
        let den = (rate as u32).max(1);
        let fps = num / den;
        Ok((width, height, fps))
    }
}

fn log_available_inputs(transform: &IMFTransform) {
    for index in 0..8u32 {
        match unsafe { transform.GetInputAvailableType(0, index) } {
            Ok(media) => {
                let subtype = unsafe { media.GetGUID(&MF_MT_SUBTYPE).ok() };
                let size = unsafe { media.GetUINT64(&MF_MT_FRAME_SIZE).ok() };
                let rate = unsafe { media.GetUINT64(&MF_MT_FRAME_RATE).ok() };
                let interlace = unsafe { media.GetUINT32(&MF_MT_INTERLACE_MODE).ok() };
                tracing::info!(
                    index,
                    subtype = ?subtype,
                    nv12 = subtype.is_some_and(|guid| guid == MFVideoFormat_NV12),
                    frame_size = size.map(|packed| format!("{}x{}", packed >> 32, packed as u32)),
                    frame_rate = rate.map(|packed| format!("{}/{}", packed >> 32, packed as u32)),
                    interlace,
                    "composed encoder available input type"
                );
            }
            Err(_) => break,
        }
    }
}

fn stream_ids(transform: &IMFTransform) -> (u32, u32) {
    let mut input = 0u32;
    let mut output = 0u32;
    if unsafe { transform.GetStreamCount(&mut input, &mut output) }.is_ok() {
        tracing::info!(input_streams = input, output_streams = output, "composed encoder GetStreamCount");
    }
    (0, 0)
}

fn log_mux_type(media: &IMFMediaType) {
    unsafe {
        let subtype = media.GetGUID(&MF_MT_SUBTYPE).ok();
        let size = media.GetUINT64(&MF_MT_FRAME_SIZE).ok();
        let rate = media.GetUINT64(&MF_MT_FRAME_RATE).ok();
        let seq_len = media
            .GetBlobSize(&MF_MT_MPEG_SEQUENCE_HEADER)
            .ok()
            .unwrap_or(0);
        tracing::info!(
            subtype = ?subtype,
            frame_size = size.map(|packed| format!("{}x{}", packed >> 32, packed as u32)),
            frame_rate = rate.map(|packed| format!("{}/{}", packed >> 32, packed as u32)),
            mpeg_sequence_header_bytes = seq_len,
            "composed mux input from encoder GetOutputCurrentType"
        );
    }
}

fn dump_media_type(label: &str, media: &IMFMediaType) {
    unsafe {
        let major = media.GetGUID(&MF_MT_MAJOR_TYPE).ok();
        let subtype = media.GetGUID(&MF_MT_SUBTYPE).ok();
        let size = media.GetUINT64(&MF_MT_FRAME_SIZE).ok();
        let rate = media.GetUINT64(&MF_MT_FRAME_RATE).ok();
        let rate_min = media.GetUINT64(&MF_MT_FRAME_RATE_RANGE_MIN).ok();
        let rate_max = media.GetUINT64(&MF_MT_FRAME_RATE_RANGE_MAX).ok();
        let aspect = media.GetUINT64(&MF_MT_PIXEL_ASPECT_RATIO).ok();
        let interlace = media.GetUINT32(&MF_MT_INTERLACE_MODE).ok();
        let stride = media.GetUINT32(&MF_MT_DEFAULT_STRIDE).ok();
        let sample_size = media.GetUINT32(&MF_MT_SAMPLE_SIZE).ok();
        let fixed = media.GetUINT32(&MF_MT_FIXED_SIZE_SAMPLES).ok();
        let bitrate = media.GetUINT32(&MF_MT_AVG_BITRATE).ok();
        let profile = media.GetUINT32(&MF_MT_MPEG2_PROFILE).ok();
        let level = media.GetUINT32(&MF_MT_MPEG2_LEVEL).ok();
        tracing::info!(
            label,
            major = ?major,
            subtype = ?subtype,
            frame_size = size.map(|packed| format!("{}x{}", packed >> 32, packed as u32)),
            frame_rate_num = rate.map(|packed| packed >> 32),
            frame_rate_den = rate.map(|packed| packed as u32),
            frame_rate_range_min = rate_min,
            frame_rate_range_max = rate_max,
            aspect = aspect.map(|packed| format!("{}:{}", packed >> 32, packed as u32)),
            interlace,
            stride,
            sample_size,
            fixed_size_samples = fixed,
            bitrate,
            mpeg2_profile = profile,
            mpeg2_level = level,
            "composed encoder media type dump"
        );
    }
}

fn encoder_vendor(name: &str) -> &'static str {
    let lower = name.to_ascii_lowercase();
    if lower.contains("nvidia") || lower.contains("nvenc") {
        "NVIDIA"
    } else if lower.contains("dx12") || lower.contains("microsoft") {
        "Microsoft"
    } else if lower.contains("amd") || lower.contains("amf") {
        "AMD"
    } else if lower.contains("intel") || lower.contains("qsv") {
        "Intel"
    } else {
        "unknown"
    }
}

fn log_negotiation(
    name: &str,
    clsid: &str,
    async_mft: bool,
    aware: Option<bool>,
    requested_fps: u32,
    bitrate: u32,
    input_stream: u32,
    output_stream: u32,
    canvas_w: u32,
    canvas_h: u32,
    negotiate_fps: u32,
) {
    let vendor = encoder_vendor(name);
    tracing::info!(
        name,
        clsid,
        vendor,
        nvidia_or_microsoft = vendor == "NVIDIA" || vendor == "Microsoft",
        hardware = true,
        async_mft,
        d3d_aware = ?aware,
        d3d_manager_attached = aware != Some(false),
        input_stream,
        output_stream,
        set_type_order = "SetOutputType then SetInputType",
        canvas_w,
        canvas_h,
        requested_fps,
        output_subtype = "H264",
        output_w = canvas_w,
        output_h = canvas_h,
        output_fps_num = negotiate_fps,
        output_fps_den = 1,
        output_bitrate = bitrate,
        output_profile = "unset (known-good)",
        output_interlace = "progressive",
        input_subtype = "NV12",
        input_w = canvas_w,
        input_h = canvas_h,
        input_fps_num = negotiate_fps,
        input_fps_den = 1,
        input_aspect = "1:1",
        input_interlace = "progressive",
        input_stride = "unset (known-good)",
        input_sample_size = "unset (known-good)",
        "COMPOSED ENCODER"
    );
}

fn known_good_nv12_input(width: u32, height: u32, fps: u32) -> Result<IMFMediaType, String> {
    nv12_or_h264_type(true, width, height, fps, 0)
}

fn known_good_h264_output(
    width: u32,
    height: u32,
    fps: u32,
    bitrate: u32,
) -> Result<IMFMediaType, String> {
    nv12_or_h264_type(false, width, height, fps, bitrate)
}

fn nv12_or_h264_type(
    nv12_input: bool,
    width: u32,
    height: u32,
    fps: u32,
    bitrate: u32,
) -> Result<IMFMediaType, String> {
    let fps = fps.max(1) as u64;
    unsafe {
        let media = MFCreateMediaType().map_err(|err| err.to_string())?;
        media
            .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
            .map_err(|err| err.to_string())?;
        if nv12_input {
            media
                .SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12)
                .map_err(|err| err.to_string())?;
            media
                .SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, (1u64 << 32) | 1)
                .map_err(|err| err.to_string())?;
        } else {
            media
                .SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264)
                .map_err(|err| err.to_string())?;
            media
                .SetUINT32(&MF_MT_AVG_BITRATE, bitrate)
                .map_err(|err| err.to_string())?;
        }
        media
            .SetUINT64(
                &MF_MT_FRAME_SIZE,
                (u64::from(width) << 32) | u64::from(height),
            )
            .map_err(|err| err.to_string())?;
        media
            .SetUINT64(&MF_MT_FRAME_RATE, (fps << 32) | 1)
            .map_err(|err| err.to_string())?;
        media
            .SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)
            .map_err(|err| err.to_string())?;
        Ok(media)
    }
}

fn wrap_surface(texture: &ID3D11Texture2D, time: i64, duration: i64) -> Result<IMFSample, String> {
    unsafe {
        let media_buffer = MFCreateDXGISurfaceBuffer(&ID3D11Texture2D::IID, texture, 0, false)
            .map_err(|err| format!("wrap_hr={:#x} {err}", err.code().0 as u32))?;
        let sample = MFCreateVideoSampleFromSurface(None)
            .map_err(|err| format!("wrap_hr={:#x} {err}", err.code().0 as u32))?;
        sample
            .AddBuffer(&media_buffer)
            .map_err(|err| format!("wrap_hr={:#x} {err}", err.code().0 as u32))?;
        sample
            .SetSampleTime(time.max(0))
            .map_err(|err| format!("SetSampleTime hr={:#x}", err.code().0 as u32))?;
        sample
            .SetSampleDuration(duration.max(10_000))
            .map_err(|err| format!("SetSampleDuration hr={:#x}", err.code().0 as u32))?;
        let _ = sample.SetUINT32(&MFSampleExtension_CleanPoint, u32::from(time == 0));
        Ok(sample)
    }
}

fn wrap_nv12_memory(bytes: &[u8], time: i64, duration: i64) -> Result<IMFSample, String> {
    unsafe {
        let buffer = MFCreateMemoryBuffer(bytes.len() as u32)
            .map_err(|err| format!("MFCreateMemoryBuffer hr={:#x}", err.code().0 as u32))?;
        let mut dest = std::ptr::null_mut();
        buffer
            .Lock(&mut dest, None, None)
            .map_err(|err| format!("NV12 Lock hr={:#x}", err.code().0 as u32))?;
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), dest, bytes.len());
        let _ = buffer.Unlock();
        buffer
            .SetCurrentLength(bytes.len() as u32)
            .map_err(|err| format!("SetCurrentLength hr={:#x}", err.code().0 as u32))?;
        let sample = MFCreateSample().map_err(|err| format!("MFCreateSample hr={:#x}", err.code().0 as u32))?;
        sample
            .AddBuffer(&buffer)
            .map_err(|err| format!("AddBuffer hr={:#x}", err.code().0 as u32))?;
        sample
            .SetSampleTime(time.max(0))
            .map_err(|err| format!("SetSampleTime hr={:#x}", err.code().0 as u32))?;
        sample
            .SetSampleDuration(duration.max(10_000))
            .map_err(|err| format!("SetSampleDuration hr={:#x}", err.code().0 as u32))?;
        let _ = sample.SetUINT32(&MFSampleExtension_CleanPoint, u32::from(time == 0));
        Ok(sample)
    }
}

fn read_bgra(
    context: &ID3D11DeviceContext,
    staging: &ID3D11Texture2D,
    source: &ID3D11Texture2D,
    width: u32,
    height: u32,
) -> Result<Vec<u8>, String> {
    unsafe {
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        source.GetDesc(&mut desc);
        if desc.Width != width || desc.Height != height {
            return Err(format!(
                "software encoder size {width}x{height} does not match the composed canvas {}x{}",
                desc.Width, desc.Height
            ));
        }
        let src: ID3D11Resource = source
            .cast()
            .map_err(|err| format!("BGRA source cast: {err}"))?;
        let dst: ID3D11Resource = staging
            .cast()
            .map_err(|err| format!("BGRA staging cast: {err}"))?;
        context.CopyResource(&dst, &src);
        context.Flush();
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        context
            .Map(&dst, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
            .map_err(|err| format!("BGRA map hr={:#x} {err}", err.code().0 as u32))?;
        let pitch = mapped.RowPitch as usize;
        let bytes = if mapped.pData.is_null() {
            &[]
        } else {
            std::slice::from_raw_parts(mapped.pData as *const u8, pitch.saturating_mul(height as usize))
        };
        let copied = crate::camera::color::bgra_to_nv12(bytes, width, height, pitch)
            .ok_or_else(|| "Could not convert the composed frame to NV12".to_string());
        context.Unmap(&dst, 0);
        copied
    }
}

struct EncodedNalu {
    sample: IMFSample,
    duration: Option<i64>,
}

fn take_output(transform: &IMFTransform) -> Result<Option<EncodedNalu>, String> {
    unsafe {
        let info = transform
            .GetOutputStreamInfo(0)
            .map_err(|err| format!("GetOutputStreamInfo hr={:#x}", err.code().0 as u32))?;
        let provides = info.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32 != 0;
        let sample = if provides {
            None
        } else {
            let sample = MFCreateSample().map_err(|err| err.to_string())?;
            if info.cbSize > 0 {
                let buffer = MFCreateMemoryBuffer(info.cbSize).map_err(|err| err.to_string())?;
                sample.AddBuffer(&buffer).map_err(|err| err.to_string())?;
            }
            Some(sample)
        };
        let mut buffers = [MFT_OUTPUT_DATA_BUFFER {
            dwStreamID: 0,
            pSample: ManuallyDrop::new(sample),
            dwStatus: 0,
            pEvents: ManuallyDrop::new(None),
        }];
        let mut status = 0u32;
        let result = transform.ProcessOutput(0, &mut buffers, &mut status);
        let out = ManuallyDrop::take(&mut buffers[0].pSample);
        let _ = ManuallyDrop::take(&mut buffers[0].pEvents);
        if let Err(err) = result {
            if err.code().0 as u32 == MF_E_TRANSFORM_NEED_MORE_INPUT {
                return Ok(None);
            }
            return Err(format!("ProcessOutput hr={:#x} {err}", err.code().0 as u32));
        }
        let hmft = out.ok_or_else(|| "ProcessOutput returned no sample".to_string())?;
        let encoded = if provides {
            let owned = own_encoded(&hmft)?;
            drop(hmft);
            owned
        } else {
            hmft
        };
        let duration = encoded.GetSampleDuration().ok();
        Ok(Some(EncodedNalu {
            sample: encoded,
            duration,
        }))
    }
}

fn own_encoded(src: &IMFSample) -> Result<IMFSample, String> {
    unsafe {
        let src_buffer = src
            .ConvertToContiguousBuffer()
            .map_err(|err| format!("ConvertToContiguousBuffer hr={:#x}", err.code().0 as u32))?;
        let mut src_ptr = std::ptr::null_mut();
        let mut src_len = 0_u32;
        src_buffer
            .Lock(&mut src_ptr, None, Some(&mut src_len))
            .map_err(|err| format!("encoded Lock hr={:#x}", err.code().0 as u32))?;
        let dest_buffer = MFCreateMemoryBuffer(src_len.max(1))
            .map_err(|err| format!("MFCreateMemoryBuffer hr={:#x}", err.code().0 as u32))?;
        let mut dest_ptr = std::ptr::null_mut();
        dest_buffer
            .Lock(&mut dest_ptr, None, None)
            .map_err(|err| format!("owned Lock hr={:#x}", err.code().0 as u32))?;
        std::ptr::copy_nonoverlapping(src_ptr, dest_ptr, src_len as usize);
        let _ = dest_buffer.Unlock();
        let _ = src_buffer.Unlock();
        dest_buffer
            .SetCurrentLength(src_len)
            .map_err(|err| format!("SetCurrentLength hr={:#x}", err.code().0 as u32))?;
        let dest = MFCreateSample().map_err(|err| format!("MFCreateSample hr={:#x}", err.code().0 as u32))?;
        dest.AddBuffer(&dest_buffer)
            .map_err(|err| format!("owned AddBuffer hr={:#x}", err.code().0 as u32))?;
        let _ = src.CopyAllItems(&dest);
        if let Ok(time) = src.GetSampleTime() {
            let _ = dest.SetSampleTime(time);
        }
        if let Ok(duration) = src.GetSampleDuration() {
            let _ = dest.SetSampleDuration(duration);
        }
        Ok(dest)
    }
}

fn send_message(transform: &IMFTransform, message: windows::Win32::Media::MediaFoundation::MFT_MESSAGE_TYPE) {
    let _ = unsafe { transform.ProcessMessage(message, 0) };
}

fn log_handoff(
    encoder: &str,
    texture: &ID3D11Texture2D,
    width: u32,
    height: u32,
    fps: u32,
    time: i64,
    duration: i64,
    software: bool,
) {
    let mut desc = D3D11_TEXTURE2D_DESC::default();
    unsafe { texture.GetDesc(&mut desc) };
    tracing::info!(
        encoder,
        hardware = !software,
        software_fallback = software,
        input_subtype = "NV12",
        output_subtype = "H264",
        width,
        height,
        fps,
        tex_format = format!("{:#x}", desc.Format.0),
        tex_width = desc.Width,
        tex_height = desc.Height,
        tex_mips = desc.MipLevels,
        tex_array = desc.ArraySize,
        tex_samples = desc.SampleDesc.Count,
        tex_usage = desc.Usage.0,
        tex_bind = format!("{:#x}", desc.BindFlags),
        tex_cpu = desc.CPUAccessFlags,
        tex_misc = desc.MiscFlags,
        sample_time = time,
        sample_duration = duration,
        wrap = if software {
            "system memory NV12"
        } else {
            "MFCreateVideoSampleFromSurface"
        },
        subresource = 0,
        "composed GPU encoder first-frame handoff"
    );
}
