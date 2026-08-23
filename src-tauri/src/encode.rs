use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::sync::OnceLock;
use std::time::Instant;

use windows::core::PCWSTR;
use windows::Win32::Media::MediaFoundation::{
    IMFMediaType, IMFSample, IMFSinkWriter, MFCreateAttributes, MFCreateMediaType, MFCreateMemoryBuffer,
    MFCreateSample, MFCreateSinkWriterFromURL, MFMediaType_Audio, MFMediaType_Video, MFStartup,
    MFAudioFormat_AAC, MFAudioFormat_PCM, MFVideoFormat_H264, MFVideoFormat_RGB32, MFVideoInterlace_Progressive,
    MF_MT_AUDIO_AVG_BYTES_PER_SECOND, MF_MT_AUDIO_BITS_PER_SAMPLE, MF_MT_AUDIO_BLOCK_ALIGNMENT,
    MF_MT_AUDIO_NUM_CHANNELS, MF_MT_AUDIO_SAMPLES_PER_SECOND, MF_MT_AVG_BITRATE, MF_MT_DEFAULT_STRIDE,
    MF_MT_FRAME_RATE, MF_MT_FRAME_SIZE, MF_MT_INTERLACE_MODE, MF_MT_MAJOR_TYPE, MF_MT_MAX_KEYFRAME_SPACING,
    MF_MT_MPEG2_PROFILE, MF_MT_PIXEL_ASPECT_RATIO, MF_MT_SUBTYPE, MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS,
    MF_SINK_WRITER_DISABLE_THROTTLING, MFSampleExtension_CleanPoint, MFSTARTUP_FULL, MF_VERSION,
};

const H264_PROFILE_BASELINE: u32 = 66;
const AUDIO_RATE: u32 = 48_000;
const AUDIO_CHANNELS: u32 = 2;
const AUDIO_BITS: u32 = 16;

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
    clock: Instant,
}

// Used only on the WGC capture thread; required because that handler type is Send.
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
            .SetUINT32(&MF_MT_AVG_BITRATE, 192_000)
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

impl MfWriter {
    pub fn new(
        path: &Path,
        width: u32,
        height: u32,
        fps: u32,
        bitrate: u32,
        with_audio: bool,
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
                clock: Instant::now(),
            })
        }
    }

    pub fn write_bgra(&mut self, pixels: &[u8], row_pitch: u32, src_width: u32, src_height: u32) -> Result<(), String> {
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

            let elapsed = (self.clock.elapsed().as_nanos() / 100) as i64;
            let time = self.video_time;
            let duration = if time == 0 {
                self.frame_duration
            } else {
                (elapsed - time).max(10_000)
            };
            let sample = make_sample(media_buffer, time, duration, self.first_video)?;
            self.first_video = false;
            self.writer
                .WriteSample(self.video_stream, &sample)
                .map_err(|err| err.to_string())?;
            self.video_time = time + duration;
        }
        Ok(())
    }

    pub fn write_pcm(&mut self, pcm: &[u8]) -> Result<(), String> {
        let Some(audio_stream) = self.audio_stream else {
            return Ok(());
        };
        if pcm.is_empty() {
            return Ok(());
        }
        let bytes_per_sec = AUDIO_RATE * AUDIO_CHANNELS * (AUDIO_BITS / 8);
        let duration = (pcm.len() as i64) * 10_000_000 / i64::from(bytes_per_sec);
        unsafe {
            let media_buffer = MFCreateMemoryBuffer(pcm.len() as u32).map_err(|err| err.to_string())?;
            let mut data = std::ptr::null_mut();
            media_buffer
                .Lock(&mut data, None, None)
                .map_err(|err| err.to_string())?;
            if !data.is_null() {
                std::ptr::copy_nonoverlapping(pcm.as_ptr(), data, pcm.len());
            }
            media_buffer.Unlock().map_err(|err| err.to_string())?;
            media_buffer
                .SetCurrentLength(pcm.len() as u32)
                .map_err(|err| err.to_string())?;
            let sample = make_sample(media_buffer, self.audio_time, duration.max(1), false)?;
            self.writer
                .WriteSample(audio_stream, &sample)
                .map_err(|err| err.to_string())?;
            self.audio_time += duration.max(1);
        }
        Ok(())
    }

    pub fn has_audio(&self) -> bool {
        self.audio_stream.is_some()
    }

    pub fn timestamp(&self) -> i64 {
        self.video_time
    }

    pub fn finish(self) -> Result<(), String> {
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
