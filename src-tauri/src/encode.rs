use std::ffi::OsStr;
use std::fs::File;
use std::io::Write;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use windows::core::PCWSTR;
use windows::Win32::Media::MediaFoundation::{
    IMFMediaType, IMFSample, IMFSinkWriter, MFCreateAttributes, MFCreateMediaType, MFCreateMemoryBuffer,
    MFCreateSample, MFCreateSinkWriterFromURL, MFMediaType_Audio, MFMediaType_Video, MFStartup,
    MFAudioFormat_AAC, MFAudioFormat_PCM, MFVideoFormat_H264, MFVideoFormat_RGB32, MFVideoInterlace_Progressive,
    MF_MT_AAC_AUDIO_PROFILE_LEVEL_INDICATION, MF_MT_AAC_PAYLOAD_TYPE, MF_MT_AUDIO_AVG_BYTES_PER_SECOND,
    MF_MT_AUDIO_BITS_PER_SAMPLE, MF_MT_AUDIO_BLOCK_ALIGNMENT, MF_MT_AUDIO_NUM_CHANNELS,
    MF_MT_AUDIO_SAMPLES_PER_SECOND, MF_MT_AVG_BITRATE, MF_MT_DEFAULT_STRIDE, MF_MT_FRAME_RATE, MF_MT_FRAME_SIZE,
    MF_MT_INTERLACE_MODE, MF_MT_MAJOR_TYPE, MF_MT_MAX_KEYFRAME_SPACING, MF_MT_MPEG2_PROFILE,
    MF_MT_PIXEL_ASPECT_RATIO, MF_MT_SUBTYPE, MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS,
    MF_SINK_WRITER_DISABLE_THROTTLING, MFSampleExtension_CleanPoint, MFSTARTUP_FULL, MF_VERSION,
};

const H264_PROFILE_BASELINE: u32 = 66;
const AUDIO_RATE: u32 = 48_000;
const AUDIO_CHANNELS: u32 = 2;
const AUDIO_BITS: u32 = 16;
const AUDIO_ALIGN: usize = (AUDIO_CHANNELS * (AUDIO_BITS / 8)) as usize;
const AUDIO_LEFTOVER_MAX: usize = (AUDIO_RATE as usize * AUDIO_ALIGN * 200) / 1000;
const AUDIO_HARD_DROP_BYTES: usize = (AUDIO_RATE as usize * AUDIO_ALIGN * 200) / 1000;
const CROSSFADE_FRAMES: usize = 128;
const AAC_FRAME_BYTES: usize = 1024 * AUDIO_ALIGN;
const JOIN_FADE_FRAMES: usize = 240;

pub struct MfWriter {
    writer: IMFSinkWriter,
    video_stream: u32,
    audio_stream: Option<u32>,
    width: u32,
    height: u32,
    frame_duration: i64,
    video_time: i64,
    audio_time: i64,
    first_video: bool,
    first_audio: bool,
    last_capture_hns: Option<i64>,
    audio_leftover: Vec<u8>,
    crossfade_incoming: bool,
    pcm_file: Option<File>,
}

// Used only on the dedicated encode thread; required because the pump type is Send.
unsafe impl Send for MfWriter {}

fn ensure_mf() -> Result<(), String> {
    static START: OnceLock<Result<(), String>> = OnceLock::new();
    START
        .get_or_init(|| unsafe { MFStartup(MF_VERSION, MFSTARTUP_FULL) }.map_err(|err| err.to_string()))
        .clone()
}

fn pack(high: u32, low: u32) -> u64 {
    (u64::from(high) << 32) | u64::from(low)
}

fn wide_path(path: &Path) -> Vec<u16> {
    OsStr::new(path).encode_wide().chain(std::iter::once(0)).collect()
}

fn video_output_type(width: u32, height: u32, fps: u32, bitrate: u32) -> Result<IMFMediaType, String> {
    unsafe {
        let media_type = MFCreateMediaType().map_err(|err| err.to_string())?;
        media_type
            .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
            .map_err(|err| err.to_string())?;
        media_type
            .SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264)
            .map_err(|err| err.to_string())?;
        media_type
            .SetUINT32(&MF_MT_AVG_BITRATE, bitrate)
            .map_err(|err| err.to_string())?;
        media_type
            .SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)
            .map_err(|err| err.to_string())?;
        media_type
            .SetUINT32(&MF_MT_MPEG2_PROFILE, H264_PROFILE_BASELINE)
            .map_err(|err| err.to_string())?;
        media_type
            .SetUINT32(&MF_MT_MAX_KEYFRAME_SPACING, fps.max(1) * 2)
            .map_err(|err| err.to_string())?;
        media_type
            .SetUINT64(&MF_MT_FRAME_SIZE, pack(width, height))
            .map_err(|err| err.to_string())?;
        media_type
            .SetUINT64(&MF_MT_FRAME_RATE, pack(fps, 1))
            .map_err(|err| err.to_string())?;
        media_type
            .SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack(1, 1))
            .map_err(|err| err.to_string())?;
        Ok(media_type)
    }
}

fn video_input_type(width: u32, height: u32, fps: u32) -> Result<IMFMediaType, String> {
    unsafe {
        let media_type = MFCreateMediaType().map_err(|err| err.to_string())?;
        media_type
            .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
            .map_err(|err| err.to_string())?;
        media_type
            .SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_RGB32)
            .map_err(|err| err.to_string())?;
        media_type
            .SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)
            .map_err(|err| err.to_string())?;
        media_type
            .SetUINT64(&MF_MT_FRAME_SIZE, pack(width, height))
            .map_err(|err| err.to_string())?;
        media_type
            .SetUINT64(&MF_MT_FRAME_RATE, pack(fps, 1))
            .map_err(|err| err.to_string())?;
        media_type
            .SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack(1, 1))
            .map_err(|err| err.to_string())?;
        media_type
            .SetUINT32(&MF_MT_DEFAULT_STRIDE, width * 4)
            .map_err(|err| err.to_string())?;
        Ok(media_type)
    }
}

fn audio_output_type() -> Result<IMFMediaType, String> {
    unsafe {
        let media_type = MFCreateMediaType().map_err(|err| err.to_string())?;
        media_type
            .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)
            .map_err(|err| err.to_string())?;
        media_type
            .SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_AAC)
            .map_err(|err| err.to_string())?;
        media_type
            .SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, AUDIO_BITS)
            .map_err(|err| err.to_string())?;
        media_type
            .SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, AUDIO_RATE)
            .map_err(|err| err.to_string())?;
        media_type
            .SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, AUDIO_CHANNELS)
            .map_err(|err| err.to_string())?;
        media_type
            .SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, 1)
            .map_err(|err| err.to_string())?;
        media_type
            .SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, 24_000)
            .map_err(|err| err.to_string())?;
        media_type
            .SetUINT32(&MF_MT_AVG_BITRATE, 192_000)
            .map_err(|err| err.to_string())?;
        media_type
            .SetUINT32(&MF_MT_AAC_PAYLOAD_TYPE, 0)
            .map_err(|err| err.to_string())?;
        media_type
            .SetUINT32(&MF_MT_AAC_AUDIO_PROFILE_LEVEL_INDICATION, 0x29)
            .map_err(|err| err.to_string())?;
        Ok(media_type)
    }
}

fn audio_input_type() -> Result<IMFMediaType, String> {
    let block_align = AUDIO_CHANNELS * (AUDIO_BITS / 8);
    unsafe {
        let media_type = MFCreateMediaType().map_err(|err| err.to_string())?;
        media_type
            .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)
            .map_err(|err| err.to_string())?;
        media_type
            .SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_PCM)
            .map_err(|err| err.to_string())?;
        media_type
            .SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, AUDIO_BITS)
            .map_err(|err| err.to_string())?;
        media_type
            .SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, AUDIO_RATE)
            .map_err(|err| err.to_string())?;
        media_type
            .SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, AUDIO_CHANNELS)
            .map_err(|err| err.to_string())?;
        media_type
            .SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, block_align)
            .map_err(|err| err.to_string())?;
        media_type
            .SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, AUDIO_RATE * block_align)
            .map_err(|err| err.to_string())?;
        Ok(media_type)
    }
}

pub fn pcm_sidecar_path(mp4: &Path) -> PathBuf {
    mp4.with_extension("pcm")
}

impl MfWriter {
    pub fn new(
        path: &Path,
        width: u32,
        height: u32,
        fps: u32,
        bitrate: u32,
        with_audio: bool,
        pcm_path: Option<&Path>,
    ) -> Result<Self, String> {
        ensure_mf()?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
        }

        let fps = fps.clamp(24, 60);
        let width = width.max(16);
        let height = height.max(16);
        let wide = wide_path(path);

        unsafe {
            let mut attrs = None;
            MFCreateAttributes(&mut attrs, 2).map_err(|err| err.to_string())?;
            let attrs = attrs.ok_or_else(|| "Could not create Media Foundation attributes.".to_string())?;
            attrs
                .SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1)
                .map_err(|err| err.to_string())?;
            attrs
                .SetUINT32(&MF_SINK_WRITER_DISABLE_THROTTLING, 1)
                .map_err(|err| err.to_string())?;

            let writer = MFCreateSinkWriterFromURL(PCWSTR(wide.as_ptr()), None, Some(&attrs))
                .map_err(|err| format!("Could not create the MP4 writer: {err}"))?;

            let video_out = video_output_type(width, height, fps, bitrate)?;
            let video_stream = writer
                .AddStream(&video_out)
                .map_err(|err| format!("Could not add the H.264 stream: {err}"))?;
            let video_in = video_input_type(width, height, fps)?;
            writer
                .SetInputMediaType(video_stream, &video_in, None)
                .map_err(|err| format!("Could not set the RGB input type: {err}"))?;

            let audio_stream = if with_audio {
                match configure_audio(&writer) {
                    Ok(index) => Some(index),
                    Err(err) => {
                        tracing::warn!("recording without audio: {err}");
                        None
                    }
                }
            } else {
                None
            };

            writer
                .BeginWriting()
                .map_err(|err| format!("Could not begin writing the MP4: {err}"))?;

            let pcm_file = match pcm_path {
                Some(sidecar) => {
                    if let Some(parent) = sidecar.parent() {
                        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
                    }
                    Some(
                        File::create(sidecar)
                            .map_err(|err| format!("Could not create the PCM sidecar: {err}"))?,
                    )
                }
                None => None,
            };

            Ok(Self {
                writer,
                video_stream,
                audio_stream,
                width,
                height,
                frame_duration: 10_000_000 / i64::from(fps),
                video_time: 0,
                audio_time: 0,
                first_video: true,
                first_audio: true,
                last_capture_hns: None,
                audio_leftover: Vec::new(),
                crossfade_incoming: false,
                pcm_file,
            })
        }
    }

    pub fn preview_duration(&self, capture_hns: i64) -> i64 {
        match self.last_capture_hns {
            Some(previous) => (capture_hns - previous).max(10_000),
            None => self.frame_duration,
        }
    }

    pub fn last_capture_hns(&self) -> Option<i64> {
        self.last_capture_hns
    }

    pub fn set_last_capture_hns(&mut self, capture_hns: Option<i64>) {
        self.last_capture_hns = capture_hns;
    }

    pub fn write_bgra(
        &mut self,
        pixels: &[u8],
        row_pitch: u32,
        src_width: u32,
        src_height: u32,
        capture_hns: i64,
        force_keyframe: bool,
    ) -> Result<(), String> {
        let dst_pitch = self.width as usize * 4;
        let src_pitch = row_pitch as usize;
        let copy_width = src_width.min(self.width) as usize * 4;
        let copy_height = src_height.min(self.height) as usize;
        let buffer_size = dst_pitch * self.height as usize;

        unsafe {
            let media_buffer = MFCreateMemoryBuffer(buffer_size as u32).map_err(|err| err.to_string())?;
            let mut data = std::ptr::null_mut();
            media_buffer
                .Lock(&mut data, None, None)
                .map_err(|err| err.to_string())?;
            if data.is_null() {
                return Err("Media Foundation returned an empty video buffer.".into());
            }
            let dest = std::slice::from_raw_parts_mut(data, buffer_size);
            dest.fill(0);
            for y in 0..copy_height {
                let src_offset = y * src_pitch;
                let dst_offset = y * dst_pitch;
                if src_offset + copy_width > pixels.len() {
                    break;
                }
                dest[dst_offset..dst_offset + copy_width]
                    .copy_from_slice(&pixels[src_offset..src_offset + copy_width]);
            }
            media_buffer.Unlock().map_err(|err| err.to_string())?;
            media_buffer
                .SetCurrentLength(buffer_size as u32)
                .map_err(|err| err.to_string())?;

            let time = self.video_time;
            let duration = self.preview_duration(capture_hns);
            let keyframe = self.first_video || force_keyframe;
            let sample = make_sample(media_buffer, time, duration, keyframe)?;
            self.first_video = false;
            self.last_capture_hns = Some(capture_hns);
            self.writer
                .WriteSample(self.video_stream, &sample)
                .map_err(|err| err.to_string())?;
            self.video_time = time + duration;
        }
        Ok(())
    }

    pub fn write_pcm(&mut self, pcm: &[u8]) -> Result<(), String> {
        self.write_pcm_inner(pcm, false)
    }

    pub fn write_pcm_closing(&mut self, pcm: &[u8]) -> Result<(), String> {
        self.write_pcm_inner(pcm, true)
    }

    fn write_pcm_inner(&mut self, pcm: &[u8], closing: bool) -> Result<(), String> {
        if self.audio_stream.is_none() && self.pcm_file.is_none() {
            return Ok(());
        }
        if !pcm.is_empty() {
            if self.crossfade_incoming {
                crossfade_append(&mut self.audio_leftover, pcm);
                self.crossfade_incoming = false;
            } else {
                self.audio_leftover.extend_from_slice(pcm);
            }
        }
        if self.audio_leftover.len() > AUDIO_LEFTOVER_MAX {
            self.trim_audio_leftover();
        }
        let bytes_per_sec = AUDIO_RATE * AUDIO_CHANNELS * (AUDIO_BITS / 8);
        let align = AUDIO_ALIGN;
        let need_hns = self.video_time.saturating_sub(self.audio_time);
        let mut need_bytes = ((need_hns.max(0) as u64) * u64::from(bytes_per_sec) / 10_000_000) as usize;
        need_bytes -= need_bytes % align;
        let available = self.audio_leftover.len() - (self.audio_leftover.len() % align);
        let mut len = available.min(need_bytes);
        // AAC MFTs want 1024-sample frames. Sidecar-only writes every frame so leftover
        // does not pile up waiting for a batch (that hold was a splice source).
        if self.audio_stream.is_some() && !closing {
            if len >= AAC_FRAME_BYTES {
                len -= len % AAC_FRAME_BYTES;
            } else {
                return Ok(());
            }
        }
        if len == 0 {
            return Ok(());
        }
        let mut chunk: Vec<u8> = self.audio_leftover.drain(..len).collect();
        if self.audio_stream.is_some() {
            if self.first_audio {
                fade_in_s16_stereo(&mut chunk, JOIN_FADE_FRAMES);
                self.first_audio = false;
            }
            if closing {
                fade_out_s16_stereo(&mut chunk, JOIN_FADE_FRAMES);
            }
        }
        let duration = (len as i64) * 10_000_000 / i64::from(bytes_per_sec);
        if duration <= 0 {
            return Ok(());
        }
        if let Some(file) = &mut self.pcm_file {
            file.write_all(&chunk)
                .map_err(|err| format!("Could not write the PCM sidecar: {err}"))?;
        }
        if let Some(audio_stream) = self.audio_stream {
            unsafe {
                let media_buffer = MFCreateMemoryBuffer(len as u32).map_err(|err| err.to_string())?;
                let mut data = std::ptr::null_mut();
                media_buffer
                    .Lock(&mut data, None, None)
                    .map_err(|err| err.to_string())?;
                if !data.is_null() {
                    std::ptr::copy_nonoverlapping(chunk.as_ptr(), data, len);
                }
                media_buffer.Unlock().map_err(|err| err.to_string())?;
                media_buffer
                    .SetCurrentLength(len as u32)
                    .map_err(|err| err.to_string())?;
                let sample = make_sample(media_buffer, self.audio_time, duration, false)?;
                self.writer
                    .WriteSample(audio_stream, &sample)
                    .map_err(|err| err.to_string())?;
            }
        }
        self.audio_time += duration;
        Ok(())
    }

    fn trim_audio_leftover(&mut self) {
        let max_bytes = AUDIO_LEFTOVER_MAX - (AUDIO_LEFTOVER_MAX % AUDIO_ALIGN);
        let len = self.audio_leftover.len() - (self.audio_leftover.len() % AUDIO_ALIGN);
        if len <= max_bytes {
            return;
        }
        let drop = len - max_bytes;
        if drop >= AUDIO_HARD_DROP_BYTES {
            self.audio_leftover.drain(..drop);
            fade_in_s16_stereo(&mut self.audio_leftover, CROSSFADE_FRAMES);
            return;
        }
        drop_oldest_crossfade(&mut self.audio_leftover, drop);
    }

    pub fn take_audio_leftover(&mut self) -> Vec<u8> {
        self.trim_audio_leftover();
        std::mem::take(&mut self.audio_leftover)
    }

    pub fn prepend_audio_leftover(&mut self, mut pcm: Vec<u8>) {
        if pcm.is_empty() {
            return;
        }
        pcm.append(&mut self.audio_leftover);
        self.audio_leftover = pcm;
        if self.audio_leftover.len() > AUDIO_LEFTOVER_MAX {
            self.trim_audio_leftover();
        }
    }

    pub fn has_audio(&self) -> bool {
        self.audio_stream.is_some() || self.pcm_file.is_some()
    }

    pub fn timestamp(&self) -> i64 {
        self.video_time
    }

    pub fn finish(mut self) -> Result<(), String> {
        if let Some(file) = &mut self.pcm_file {
            let _ = file.flush();
        }
        unsafe { self.writer.Finalize().map_err(|err| err.to_string()) }
    }
}

fn configure_audio(writer: &IMFSinkWriter) -> Result<u32, String> {
    unsafe {
        let audio_out = audio_output_type()?;
        let index = writer
            .AddStream(&audio_out)
            .map_err(|err| format!("Could not add the AAC stream: {err}"))?;
        let audio_in = audio_input_type()?;
        writer
            .SetInputMediaType(index, &audio_in, None)
            .map_err(|err| format!("Could not set the PCM input type: {err}"))?;
        Ok(index)
    }
}

fn make_sample(
    buffer: windows::Win32::Media::MediaFoundation::IMFMediaBuffer,
    time: i64,
    duration: i64,
    keyframe: bool,
) -> Result<IMFSample, String> {
    unsafe {
        let sample = MFCreateSample().map_err(|err| err.to_string())?;
        sample.AddBuffer(&buffer).map_err(|err| err.to_string())?;
        sample.SetSampleTime(time).map_err(|err| err.to_string())?;
        sample
            .SetSampleDuration(duration)
            .map_err(|err| err.to_string())?;
        if keyframe {
            let _ = sample.SetUINT32(&MFSampleExtension_CleanPoint, 1);
        }
        Ok(sample)
    }
}

fn crossfade_append(dest: &mut Vec<u8>, incoming: &[u8]) {
    let incoming_len = incoming.len() - (incoming.len() % AUDIO_ALIGN);
    if dest.is_empty() || incoming_len == 0 {
        dest.extend_from_slice(&incoming[..incoming_len]);
        return;
    }
    let dest_len = dest.len() - (dest.len() % AUDIO_ALIGN);
    dest.truncate(dest_len);
    let cross = CROSSFADE_FRAMES
        .min(dest_len / AUDIO_ALIGN)
        .min(incoming_len / AUDIO_ALIGN);
    if cross == 0 {
        dest.extend_from_slice(&incoming[..incoming_len]);
        return;
    }
    let dest_frames = dest_len / AUDIO_ALIGN;
    for index in 0..cross {
        let t = (index + 1) as f32 / (cross + 1) as f32;
        let dest_frame = dest_frames - cross + index;
        for channel in 0..AUDIO_CHANNELS as usize {
            let dest_at = dest_frame * AUDIO_ALIGN + channel * 2;
            let src_at = index * AUDIO_ALIGN + channel * 2;
            let previous = i16::from_le_bytes([dest[dest_at], dest[dest_at + 1]]) as f32;
            let next = i16::from_le_bytes([incoming[src_at], incoming[src_at + 1]]) as f32;
            let mixed = previous * (1.0 - t) + next * t;
            dest[dest_at..dest_at + 2].copy_from_slice(&(mixed.round() as i16).to_le_bytes());
        }
    }
    dest.extend_from_slice(&incoming[cross * AUDIO_ALIGN..incoming_len]);
}

fn drop_oldest_crossfade(pcm: &mut Vec<u8>, drop_bytes: usize) {
    let drop_bytes = drop_bytes - (drop_bytes % AUDIO_ALIGN);
    if drop_bytes == 0 || drop_bytes >= pcm.len() {
        if drop_bytes >= pcm.len() {
            pcm.clear();
        }
        return;
    }
    let keep = pcm.len() - drop_bytes;
    let cross = CROSSFADE_FRAMES
        .min(drop_bytes / AUDIO_ALIGN)
        .min(keep / AUDIO_ALIGN);
    if cross > 0 {
        for index in 0..cross {
            let t = (index + 1) as f32 / (cross + 1) as f32;
            let old_frame = drop_bytes / AUDIO_ALIGN - cross + index;
            let new_frame = drop_bytes / AUDIO_ALIGN + index;
            for channel in 0..AUDIO_CHANNELS as usize {
                let old_at = old_frame * AUDIO_ALIGN + channel * 2;
                let new_at = new_frame * AUDIO_ALIGN + channel * 2;
                let previous = i16::from_le_bytes([pcm[old_at], pcm[old_at + 1]]) as f32;
                let next = i16::from_le_bytes([pcm[new_at], pcm[new_at + 1]]) as f32;
                let mixed = previous * (1.0 - t) + next * t;
                pcm[new_at..new_at + 2].copy_from_slice(&(mixed.round() as i16).to_le_bytes());
            }
        }
    }
    pcm.drain(..drop_bytes);
}

fn fade_out_s16_stereo(pcm: &mut [u8], frames: usize) {
    let available = pcm.len() / AUDIO_ALIGN;
    let frames = frames.min(available);
    if frames == 0 {
        return;
    }
    let start = available - frames;
    for index in 0..frames {
        let gain = 1.0 - (index as f32 / frames as f32);
        for channel in 0..AUDIO_CHANNELS as usize {
            let dest = (start + index) * AUDIO_ALIGN + channel * 2;
            let sample = i16::from_le_bytes([pcm[dest], pcm[dest + 1]]) as f32 * gain;
            pcm[dest..dest + 2].copy_from_slice(&(sample.round() as i16).to_le_bytes());
        }
    }
}

fn fade_in_s16_stereo(pcm: &mut [u8], frames: usize) {
    let available = pcm.len() / AUDIO_ALIGN;
    let frames = frames.min(available);
    if frames == 0 {
        return;
    }
    for index in 0..frames {
        let gain = index as f32 / frames as f32;
        for channel in 0..AUDIO_CHANNELS as usize {
            let dest = index * AUDIO_ALIGN + channel * 2;
            let sample = i16::from_le_bytes([pcm[dest], pcm[dest + 1]]) as f32 * gain;
            pcm[dest..dest + 2].copy_from_slice(&(sample.round() as i16).to_le_bytes());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drop_oldest_crossfade_keeps_cap() {
        let mut pcm = vec![0u8; 200 * AUDIO_ALIGN];
        drop_oldest_crossfade(&mut pcm, 40 * AUDIO_ALIGN);
        assert_eq!(pcm.len(), 160 * AUDIO_ALIGN);
    }
}
