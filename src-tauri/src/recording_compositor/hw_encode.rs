//! Session-only GPU H.264 ingest. Same semantics as `export/compose/gpu_dxgi`:
//! DXGI NV12 surface → MFCreateVideoSampleFromSurface → async MFT ProcessInput.
//! Instant Replay and clips never call this.

#![cfg(windows)]

use std::collections::VecDeque;
use std::mem::ManuallyDrop;
use std::path::Path;
use std::time::{Duration, Instant};

use windows::core::Interface;
use windows::Win32::Graphics::Direct3D11::{ID3D11Device, ID3D11Texture2D, D3D11_TEXTURE2D_DESC};
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

use super::gpu::create_nv12_encode;
use super::session_aac::SessionAacEncoder;

/// Same canvas the proven `gpu_dxgi` encoder negotiates. Do not pass Native/0x0.
const GPU_ENCODER_W: u32 = 1920;
const GPU_ENCODER_H: u32 = 1080;
/// Forced for this negotiation-only iteration. Product FPS stays on the session clock.
const NEGOTIATE_FPS: u32 = 60;
const MFT_SET_TYPE_TEST_ONLY: u32 = 1;
/// Same depth as `gpu_dxgi` `VP_OUTPUT_RING`. A 3-slot pool stalls an async HMFT.
const POOL: usize = 16;
const EVENT_WAIT: Duration = Duration::from_secs(8);
/// Same as `gpu_dxgi` `COMPOSE_DRAIN_TIMEOUT`.
const DRAIN_TIMEOUT: Duration = Duration::from_secs(15);
const HNS_PER_SECOND: i64 = 10_000_000;

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
    events: IMFMediaEventGenerator,
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
        let requested_fps = fps.max(1);
        tracing::info!(
            input_width = width,
            input_height = height,
            output_width = GPU_ENCODER_W,
            output_height = GPU_ENCODER_H,
            requested_fps,
            negotiate_fps = NEGOTIATE_FPS,
            "composed encoder resolved integer canvas before SetInputType"
        );
        if GPU_ENCODER_W == 0 || GPU_ENCODER_H == 0 || GPU_ENCODER_W % 2 != 0 || GPU_ENCODER_H % 2 != 0 {
            return Err(
                "Composed GPU encoding could not start: encoder canvas is invalid. Use Legacy recording."
                    .into(),
            );
        }
        let (name, clsid, transform) = activate_gpu_encoder()?;
        let aware = d3d11_aware(&transform);
        if aware == Some(false) {
            return Err(
                "Composed GPU encoding could not start: the selected encoder is not D3D11-aware. Use Legacy recording."
                    .into(),
            );
        }
        configure_encoder(
            &transform,
            manager,
            &name,
            &clsid,
            aware,
            requested_fps,
            bitrate,
            width,
            height,
        )?;
        let events: IMFMediaEventGenerator = transform.cast().map_err(|err| {
            format!("Composed GPU encoding could not start: {err} Use Legacy recording.")
        })?;
        // Do not open the mux here. GetOutputCurrentType before the first encoded
        // sample often lacks MF_MT_MPEG_SEQUENCE_HEADER (SPS/PPS). That is the
        // known-good gpu_dxgi rule and the likely unplayable/~2s GOP symptom.
        let mut pool = Vec::with_capacity(POOL);
        for _ in 0..POOL {
            pool.push(create_nv12_encode(device, GPU_ENCODER_W, GPU_ENCODER_H)?);
        }
        tracing::info!(
            encoder = %name,
            input = "NV12",
            output = "H264",
            negotiate_w = GPU_ENCODER_W,
            negotiate_h = GPU_ENCODER_H,
            fps = NEGOTIATE_FPS,
            d3d_aware = ?aware,
            pool = POOL,
            mux_ready = false,
            include_audio,
            "composed GPU encoder media types accepted; mux waits for first H.264 sample"
        );
        let aac = if include_audio {
            Some(SessionAacEncoder::open()?)
        } else {
            None
        };
        Ok(Self {
            transform,
            events,
            mux: None,
            mux_path: path.to_path_buf(),
            pool,
            in_flight: VecDeque::new(),
            need_input: 0,
            name,
            width: GPU_ENCODER_W,
            height: GPU_ENCODER_H,
            fps: NEGOTIATE_FPS,
            logged_first: false,
            stats: EncoderPipelineStats::default(),
            include_audio,
            aac,
            pending_pcm: Vec::new(),
        })
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

    pub fn has_audio(&self) -> bool {
        self.include_audio
    }

    pub fn acquire(&mut self) -> Result<usize, String> {
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
                return Err("Composed GPU encoder did not release a surface. Use Legacy recording.".into());
            }
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    pub fn texture(&self, index: usize) -> &ID3D11Texture2D {
        &self.pool[index]
    }

    pub fn submit(&mut self, index: usize, time_hns: i64, duration_hns: i64) -> Result<(), String> {
        let texture = &self.pool[index];
        if !self.logged_first {
            log_handoff(&self.name, texture, self.width, self.height, self.fps, time_hns, duration_hns);
            self.logged_first = true;
        }
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
        self.log_pipeline("composed encoder finish");
        if !drain_complete {
            tracing::warn!(
                in_flight = self.in_flight.len(),
                "composed encoder drain timed out; finalizing mux with samples already written"
            );
        }
        if let Err(err) = self.flush_pending_audio(true) {
            tracing::warn!("composed AAC flush failed: {err}");
        }
        match self.mux.take() {
            Some(mux) => mux.finish(),
            None => {
                if self.stats.process_input == 0 {
                    Ok(())
                } else {
                    Err("Composed GPU encoder produced no H.264 samples. Use Legacy recording.".into())
                }
            }
        }
    }

    fn wait_need_input(&mut self) -> Result<(), String> {
        let deadline = Instant::now() + EVENT_WAIT;
        while self.need_input == 0 {
            self.pump(false)?;
            if self.need_input > 0 {
                return Ok(());
            }
            if Instant::now() > deadline {
                return Err("Composed GPU encoder did not request input. Use Legacy recording.".into());
            }
            std::thread::sleep(Duration::from_millis(1));
        }
        Ok(())
    }

    fn pump(&mut self, draining: bool) -> Result<bool, String> {
        let mut drain_complete = false;
        loop {
            match unsafe { self.events.GetEvent(MF_EVENT_FLAG_NO_WAIT) } {
                Ok(event) => {
                    let ty = unsafe { event.GetType().unwrap_or(0) };
                    let status = unsafe { event.GetStatus().ok() };
                    if status.is_some_and(|hr| hr.is_err()) || ty == MEError.0 as u32 {
                        return Err("Composed GPU encoder reported an error. Use Legacy recording.".into());
                    }
                    if ty == METransformNeedInput.0 as u32 && !draining {
                        self.need_input = self.need_input.saturating_add(1);
                    } else if ty == METransformHaveOutput.0 as u32 {
                        self.take_and_mux()?;
                    } else if ty == METransformDrainComplete.0 as u32 {
                        drain_complete = true;
                    }
                }
                Err(_) => break,
            }
        }
        Ok(drain_complete)
    }

    fn take_and_mux(&mut self) -> Result<(), String> {
        let nalu = take_output(&self.transform)?;
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
                format!("GetOutputCurrentType after first H.264 hr={:#x} {err}", err.code().0 as u32)
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

fn pick_direct_encoder_name(inventory: &[crate::camera::encoder::EncoderInfo]) -> String {
    inventory
        .iter()
        .find(|item| {
            let name = item.name.to_ascii_lowercase();
            name.contains("dx12") || name.contains("nvidia") || name.contains("nvenc")
        })
        .map(|item| item.name.clone())
        .unwrap_or_else(|| "Microsoft AVC DX12 Encoder".into())
}

fn activate_gpu_encoder() -> Result<(String, String, IMFTransform), String> {
    let inventory = crate::camera::encoder::log_h264_inventory();
    let selected = pick_direct_encoder_name(&inventory);
    tracing::info!(
        selected = %selected,
        enum_flags = "MFT_ENUM_FLAG_ALL",
        "composed encoder pick matches gpu_dxgi"
    );
    let (matched, clsid, transform) = activate_named_h264_encoder(&selected)?;
    if is_software_only_name(&matched) || is_software_only_name(&selected) {
        return Err(
            "Composed GPU encoding could not start: no D3D-aware hardware H.264 encoder. Use Legacy recording."
                .into(),
        );
    }
    Ok((selected, clsid, transform))
}

/// Same matching rules as `export/compose/gpu_dxgi/encoder.rs` `activate_named_h264_encoder`.
fn activate_named_h264_encoder(selected: &str) -> Result<(String, String, IMFTransform), String> {
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
        return Err("Composed GPU encoding could not start: no H.264 MFT. Use Legacy recording.".into());
    }
    let slice = unsafe { std::slice::from_raw_parts(raw, count as usize) };
    let mut names = Vec::new();
    let mut chosen: Option<(String, String, IMFActivate)> = None;
    for item in slice {
        let Some(activate) = item else {
            continue;
        };
        let name = unsafe { friendly_name(activate) };
        let clsid = unsafe { activate_clsid(activate) };
        if !name.is_empty() {
            names.push(name.clone());
        }
        if chosen.is_none()
            && (name.eq_ignore_ascii_case(selected)
                || selected.contains(&name)
                || name.contains(selected))
        {
            chosen = Some((name, clsid, activate.clone()));
        }
    }
    tracing::info!(
        all_enum_flag = MFT_ENUM_FLAG_ALL.0,
        candidates = ?names,
        selected,
        matched = chosen.is_some(),
        "composed H.264 MFTEnumEx(ALL) candidates for direct ProcessInput"
    );
    let (matched_name, clsid, activate) = chosen.ok_or_else(|| {
        unsafe { CoTaskMemFree(Some(raw as *const std::ffi::c_void)) };
        format!(
            "Composed GPU encoding could not start: {selected} was not enumerated. Use Legacy recording."
        )
    })?;
    let transform = unsafe { activate.ActivateObject::<IMFTransform>() }.map_err(|err| {
        unsafe { CoTaskMemFree(Some(raw as *const std::ffi::c_void)) };
        format!("Composed GPU encoding could not start ({matched_name}): {err} Use Legacy recording.")
    })?;
    unsafe { CoTaskMemFree(Some(raw as *const std::ffi::c_void)) };
    Ok((matched_name, clsid, transform))
}

fn is_software_only_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower == "h264 encoder mft" || lower.contains("software")
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
    requested_fps: u32,
    bitrate: u32,
    canvas_w: u32,
    canvas_h: u32,
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
        if aware != Some(false) {
            transform
                .ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, manager.as_raw() as usize)
                .map_err(|err| format!("SET_D3D_MANAGER hr={:#x}", err.code().0 as u32))?;
        }
    }
    let output_type = known_good_h264_output(NEGOTIATE_FPS, bitrate)?;
    let input_type = known_good_nv12_input(NEGOTIATE_FPS)?;
    dump_media_type("composed output type before SetOutputType", &output_type);
    dump_media_type("composed input type before SetInputType", &input_type);
    log_negotiation(
        name,
        clsid,
        async_mft,
        aware,
        requested_fps,
        bitrate,
        input_stream,
        output_stream,
        canvas_w,
        canvas_h,
    );
    unsafe {
        transform
            .SetOutputType(0, &output_type, 0)
            .map_err(|err| format!("SetOutputType hr={:#x} {err}", err.code().0 as u32))?;
        tracing::info!(set_output_type_hr = "0x0", "composed encoder SetOutputType");
        log_available_inputs(transform);
        if let Ok(probe_30) = known_good_nv12_input(30) {
            match transform.SetInputType(0, &probe_30, MFT_SET_TYPE_TEST_ONLY) {
                Ok(()) => tracing::info!(
                    set_input_type_test_only_30_hr = "0x0",
                    "composed encoder SetInputType TEST_ONLY 30fps (diagnostic only)"
                ),
                Err(err) => tracing::info!(
                    set_input_type_test_only_30_hr = format!("{:#x}", err.code().0 as u32),
                    "composed encoder SetInputType TEST_ONLY 30fps (diagnostic only)"
                ),
            }
        }
        match transform.SetInputType(0, &input_type, MFT_SET_TYPE_TEST_ONLY) {
            Ok(()) => tracing::info!(
                set_input_type_test_only_hr = "0x0",
                fps = NEGOTIATE_FPS,
                "composed encoder SetInputType TEST_ONLY"
            ),
            Err(err) => tracing::warn!(
                set_input_type_test_only_hr = format!("{:#x}", err.code().0 as u32),
                fps = NEGOTIATE_FPS,
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
        output_w = GPU_ENCODER_W,
        output_h = GPU_ENCODER_H,
        output_fps_num = NEGOTIATE_FPS,
        output_fps_den = 1,
        output_bitrate = bitrate,
        output_profile = "unset (known-good)",
        output_interlace = "progressive",
        input_subtype = "NV12",
        input_w = GPU_ENCODER_W,
        input_h = GPU_ENCODER_H,
        input_fps_num = NEGOTIATE_FPS,
        input_fps_den = 1,
        input_aspect = "1:1",
        input_interlace = "progressive",
        input_stride = "unset (known-good)",
        input_sample_size = "unset (known-good)",
        "COMPOSED ENCODER"
    );
    tracing::info!(
        field_mft = "same pick as gpu_dxgi (inventory + MFTEnumEx ALL)",
        field_input_subtype = "NV12 = NV12",
        field_width = format!("{GPU_ENCODER_W} = {GPU_ENCODER_W}"),
        field_height = format!("{GPU_ENCODER_H} = {GPU_ENCODER_H}"),
        field_fps = format!("{NEGOTIATE_FPS}/1 = {NEGOTIATE_FPS}/1"),
        field_interlace = "progressive = progressive",
        field_aspect = "1:1 (input only) = 1:1 (input only)",
        field_output_subtype = "H264 = H264",
        field_bitrate = bitrate,
        field_profile = "unset = unset",
        field_d3d_manager = "before SetOutputType = before SetOutputType",
        field_set_type_order = "SetOutputType then SetInputType",
        field_async_unlock = "if MF_TRANSFORM_ASYNC = if MF_TRANSFORM_ASYNC",
        "KNOWN GOOD vs COMPOSED"
    );
}

fn known_good_nv12_input(fps: u32) -> Result<IMFMediaType, String> {
    let fps = fps.max(1) as u64;
    unsafe {
        let media = MFCreateMediaType().map_err(|err| err.to_string())?;
        media.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).map_err(|err| err.to_string())?;
        media.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12).map_err(|err| err.to_string())?;
        media
            .SetUINT64(
                &MF_MT_FRAME_SIZE,
                (u64::from(GPU_ENCODER_W) << 32) | u64::from(GPU_ENCODER_H),
            )
            .map_err(|err| err.to_string())?;
        media
            .SetUINT64(&MF_MT_FRAME_RATE, (fps << 32) | 1)
            .map_err(|err| err.to_string())?;
        media
            .SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)
            .map_err(|err| err.to_string())?;
        media
            .SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, (1u64 << 32) | 1)
            .map_err(|err| err.to_string())?;
        Ok(media)
    }
}

fn known_good_h264_output(fps: u32, bitrate: u32) -> Result<IMFMediaType, String> {
    let fps = fps.max(1) as u64;
    unsafe {
        let media = MFCreateMediaType().map_err(|err| err.to_string())?;
        media.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).map_err(|err| err.to_string())?;
        media.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264).map_err(|err| err.to_string())?;
        media
            .SetUINT64(
                &MF_MT_FRAME_SIZE,
                (u64::from(GPU_ENCODER_W) << 32) | u64::from(GPU_ENCODER_H),
            )
            .map_err(|err| err.to_string())?;
        media
            .SetUINT64(&MF_MT_FRAME_RATE, (fps << 32) | 1)
            .map_err(|err| err.to_string())?;
        media
            .SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)
            .map_err(|err| err.to_string())?;
        media
            .SetUINT32(&MF_MT_AVG_BITRATE, bitrate)
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

struct EncodedNalu {
    sample: IMFSample,
    duration: Option<i64>,
}

fn take_output(transform: &IMFTransform) -> Result<EncodedNalu, String> {
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
        result.map_err(|err| format!("ProcessOutput hr={:#x} {err}", err.code().0 as u32))?;
        let hmft = out.ok_or_else(|| "ProcessOutput returned no sample".to_string())?;
        let encoded = if provides {
            let owned = own_encoded(&hmft)?;
            drop(hmft);
            owned
        } else {
            hmft
        };
        let duration = encoded.GetSampleDuration().ok();
        Ok(EncodedNalu {
            sample: encoded,
            duration,
        })
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
) {
    let mut desc = D3D11_TEXTURE2D_DESC::default();
    unsafe { texture.GetDesc(&mut desc) };
    tracing::info!(
        encoder,
        hardware = true,
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
        wrap = "MFCreateVideoSampleFromSurface",
        subresource = 0,
        "composed GPU encoder first-frame handoff"
    );
}
