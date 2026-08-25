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
    MFAudioFormat_AAC, MFAudioFormat_PCM, MFVideoFormat_H264, MFVideoFormat_NV12, MFVideoFormat_RGB32,
    MFVideoInterlace_Progressive,
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
const AAC_FRAME_BYTES: usize = 1024 * AUDIO_ALIGN;
const JOIN_FADE_FRAMES: usize = 240;

/// Pixel format the caller feeds the writer. Live capture hands over BGRA
/// straight from WGC; offline re-encodes stay in NV12 so Media Foundation never
/// has to colour-convert on the way in or on the way to the H.264 encoder.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum VideoInput {
    Bgra,
    Nv12,
}

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
    /// Only the AAC path needs this: the encoder wants whole 1024-sample
    /// frames, so a partial tail waits for the next write. The sidecar path
    /// writes everything immediately and holds nothing.
    aac_pending: Vec<u8>,
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

fn video_input_type(width: u32, height: u32, fps: u32, input: VideoInput) -> Result<IMFMediaType, String> {
    let subtype = match input {
        VideoInput::Bgra => MFVideoFormat_RGB32,
        VideoInput::Nv12 => MFVideoFormat_NV12,
    };
    let stride = match input {
        VideoInput::Bgra => width * 4,
        VideoInput::Nv12 => width,
    };
    unsafe {
        let media_type = MFCreateMediaType().map_err(|err| err.to_string())?;
        media_type
            .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
            .map_err(|err| err.to_string())?;
        media_type
            .SetGUID(&MF_MT_SUBTYPE, &subtype)
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
            .SetUINT32(&MF_MT_DEFAULT_STRIDE, stride)
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

fn bytes_to_hns(bytes: usize) -> i64 {
    let bytes_per_sec = i64::from(AUDIO_RATE * AUDIO_CHANNELS * (AUDIO_BITS / 8));
    bytes as i64 * 10_000_000 / bytes_per_sec
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
        live: bool,
        input: VideoInput,
    ) -> Result<Self, String> {
        ensure_mf()?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
        }

        let fps = fps.clamp(24, 60);
        let mut width = width.max(16);
        let mut height = height.max(16);
        if input == VideoInput::Nv12 {
            // NV12 subsamples chroma 2x2, so both dimensions have to be even.
            width &= !1;
            height &= !1;
        }
        let wide = wide_path(path);

        unsafe {
            let mut attrs = None;
            MFCreateAttributes(&mut attrs, 2).map_err(|err| err.to_string())?;
            let attrs = attrs.ok_or_else(|| "Could not create Media Foundation attributes.".to_string())?;
            attrs
                .SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1)
                .map_err(|err| err.to_string())?;
            if live {
                // Live capture must not block WGC. Offline re-encodes (watermark,
                // editor export) leave throttling on so MF cannot queue the whole
                // clip as uncompressed RGB.
                attrs
                    .SetUINT32(&MF_SINK_WRITER_DISABLE_THROTTLING, 1)
                    .map_err(|err| err.to_string())?;
            }

            let writer = MFCreateSinkWriterFromURL(PCWSTR(wide.as_ptr()), None, Some(&attrs))
                .map_err(|err| format!("Could not create the MP4 writer: {err}"))?;

            let video_out = video_output_type(width, height, fps, bitrate)?;
            let video_stream = writer
                .AddStream(&video_out)
                .map_err(|err| format!("Could not add the H.264 stream: {err}"))?;
            let video_in = video_input_type(width, height, fps, input)?;
            writer
                .SetInputMediaType(video_stream, &video_in, None)
                .map_err(|err| format!("Could not set the video input type: {err}"))?;

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
                aac_pending: Vec::new(),
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
            // Only clear when the source leaves part of the frame untouched;
            // a full-frame copy overwrites every byte anyway.
            if copy_width < dst_pitch || copy_height < self.height as usize {
                dest.fill(0);
            }
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

    /// Writes one NV12 frame: a full-height luma plane followed by a
    /// half-height interleaved chroma plane, both using `row_pitch`.
    pub fn write_nv12(
        &mut self,
        planes: &[u8],
        row_pitch: u32,
        src_height: u32,
        capture_hns: i64,
        force_keyframe: bool,
    ) -> Result<(), String> {
        let dst_pitch = self.width as usize;
        let dst_height = self.height as usize;
        let src_pitch = row_pitch as usize;
        let copy_width = dst_pitch.min(src_pitch);
        let copy_height = dst_height.min(src_height as usize);
        let buffer_size = dst_pitch * dst_height * 3 / 2;
        let src_chroma = src_pitch * src_height as usize;
        let dst_chroma = dst_pitch * dst_height;

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
            if copy_width < dst_pitch || copy_height < dst_height {
                // Neutral grey rather than zero: NV12 chroma is centred on 128,
                // so a zeroed border would come out bright green.
                dest[..dst_chroma].fill(0);
                dest[dst_chroma..].fill(128);
            }
            for y in 0..copy_height {
                let src_offset = y * src_pitch;
                let dst_offset = y * dst_pitch;
                if src_offset + copy_width > planes.len() {
                    break;
                }
                dest[dst_offset..dst_offset + copy_width]
                    .copy_from_slice(&planes[src_offset..src_offset + copy_width]);
            }
            for y in 0..copy_height / 2 {
                let src_offset = src_chroma + y * src_pitch;
                let dst_offset = dst_chroma + y * dst_pitch;
                if src_offset + copy_width > planes.len() {
                    break;
                }
                dest[dst_offset..dst_offset + copy_width]
                    .copy_from_slice(&planes[src_offset..src_offset + copy_width]);
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

    /// Writes `pcm` at the current audio position.
    ///
    /// The timeline hands over exactly the span the video clock advanced, with
    /// silence already filled in for anything a source did not deliver, so this
    /// writes all of it and never has to decide what to keep or drop. That
    /// decision is what every previous version got wrong: trimming compressed
    /// time, and stalling let the audio clock fall behind for good.
    fn write_pcm_inner(&mut self, pcm: &[u8], closing: bool) -> Result<(), String> {
        if self.audio_stream.is_none() && self.pcm_file.is_none() {
            return Ok(());
        }
        let aligned = pcm.len() - (pcm.len() % AUDIO_ALIGN);
        if aligned == 0 && !closing {
            return Ok(());
        }
        if let Some(file) = &mut self.pcm_file {
            file.write_all(&pcm[..aligned])
                .map_err(|err| format!("Could not write the PCM sidecar: {err}"))?;
            self.audio_time += bytes_to_hns(aligned);
        }
        if self.audio_stream.is_some() {
            self.aac_pending.extend_from_slice(&pcm[..aligned]);
            self.flush_aac(closing)?;
        }
        Ok(())
    }

    /// The AAC MFT clicks on short frames, so batch to 1024-sample boundaries
    /// and only pad on the final write.
    fn flush_aac(&mut self, closing: bool) -> Result<(), String> {
        let Some(audio_stream) = self.audio_stream else {
            return Ok(());
        };
        loop {
            let available = self.aac_pending.len();
            let len = if available >= AAC_FRAME_BYTES {
                AAC_FRAME_BYTES
            } else if closing && available > 0 {
                available
            } else {
                return Ok(());
            };
            let mut chunk: Vec<u8> = self.aac_pending.drain(..len).collect();
            if self.first_audio {
                fade_in_s16_stereo(&mut chunk, JOIN_FADE_FRAMES);
                self.first_audio = false;
            }
            if closing && self.aac_pending.is_empty() {
                fade_out_s16_stereo(&mut chunk, JOIN_FADE_FRAMES);
            }
            let duration = bytes_to_hns(len);
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
            self.audio_time += duration;
        }
    }

    /// How far the audio track lags the video track in this segment. The remux
    /// pads this out per segment; a growing value means audio is being lost.
    pub fn av_skew_hns(&self) -> i64 {
        self.video_time - self.audio_time
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
    fn a_second_of_pcm_is_a_second_of_timeline() {
        let second = AUDIO_RATE as usize * AUDIO_ALIGN;
        assert_eq!(bytes_to_hns(second), 10_000_000);
        assert_eq!(bytes_to_hns(AAC_FRAME_BYTES), 1024 * 10_000_000 / 48_000);
    }
}
