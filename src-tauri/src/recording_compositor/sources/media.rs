//! Local video and audio files. The file is streamed. Its sound goes into the
//! existing mix. A failure here never replaces the game capture.

#![cfg(windows)]

use std::path::Path;
use std::time::Instant;

use windows::core::PCWSTR;
use windows::Win32::Media::MediaFoundation::{
    IMFMediaType, IMFSample, IMFSourceReader, MFAudioFormat_PCM, MFCreateAttributes,
    MFCreateMediaType, MFCreateSourceReaderFromURL, MFMediaType_Audio, MF_MT_AUDIO_AVG_BYTES_PER_SECOND,
    MF_MT_AUDIO_BITS_PER_SAMPLE, MF_MT_AUDIO_BLOCK_ALIGNMENT, MF_MT_AUDIO_NUM_CHANNELS,
    MF_MT_AUDIO_SAMPLES_PER_SECOND, MF_MT_MAJOR_TYPE, MF_MT_SUBTYPE, MF_SOURCE_READERF_ENDOFSTREAM,
    MF_SOURCE_READER_FIRST_AUDIO_STREAM, MF_SOURCE_READER_FIRST_VIDEO_STREAM,
};

use crate::audio_timeline::MixSink;
use crate::media_policy::{validate_media_file, MediaKind};
use crate::still::StillFrame;
use crate::thumb::{open_rgb_reader, read_rgb_sample, seek_hns};

use super::super::scene::ValidatedMedia;

const MAX_VIDEO_W: u32 = 3840;
const MAX_VIDEO_H: u32 = 2160;
const PCM_RATE: u32 = 48_000;

pub struct MediaPlayer {
    video: Option<IMFSourceReader>,
    audio: Option<IMFSourceReader>,
    looping: bool,
    gain: f32,
    origin: Instant,
    next_video: i64,
    next_audio: i64,
    video_done: bool,
    audio_done: bool,
    latest: Option<StillFrame>,
    sink: std::sync::Arc<MixSink>,
}

impl MediaPlayer {
    pub fn open(spec: &ValidatedMedia, visual: bool, sink: std::sync::Arc<MixSink>) -> Result<Self, String> {
        let (path, kind) = validate_media_file(&spec.path)?;
        if visual && kind != MediaKind::Video {
            return Err("Use an MP4 or MOV video.".into());
        }
        if !visual && kind != MediaKind::Audio {
            return Err("Use an MP3, M4A, or WAV file.".into());
        }
        let video_missing;
        let audio_missing;
        let video = if visual {
            Some(open_rgb_reader(&path).map_err(|err| {
                tracing::warn!(error = %err, "media video did not open");
                "That video could not be opened.".to_string()
            })?)
        } else {
            None
        };
        let audio = match open_audio_reader(&path) {
            Ok(reader) => Some(reader),
            Err(err) => {
                if visual {
                    tracing::info!(error = %err, "media file has no audio track");
                    None
                } else {
                    return Err("That audio file could not be opened.".into());
                }
            }
        };
        video_missing = video.is_none();
        audio_missing = audio.is_none();
        Ok(Self {
            video,
            audio,
            looping: spec.looping,
            gain: spec.gain.clamp(0.0, 2.0),
            origin: Instant::now(),
            next_video: 0,
            next_audio: 0,
            video_done: video_missing,
            audio_done: audio_missing,
            latest: None,
            sink,
        })
    }

    pub fn latest(&self) -> Option<StillFrame> {
        self.latest.clone()
    }

    /// Pulls at most one video frame and one audio chunk that are due now.
    pub fn pump(&mut self) {
        let elapsed = self.origin.elapsed().as_nanos().min(i64::MAX as u128) as i64 / 100;
        if !self.video_done && self.next_video <= elapsed {
            match self.read_video() {
                Some(true) => {}
                Some(false) => self.finish_video(),
                None => self.video_done = true,
            }
        }
        if !self.audio_done && self.next_audio <= elapsed {
            match self.read_audio() {
                Some(true) => {}
                Some(false) => self.finish_audio(),
                None => self.audio_done = true,
            }
        }
    }

    fn read_video(&mut self) -> Option<bool> {
        let reader = self.video.as_ref()?;
        match read_rgb_sample(reader) {
            Ok(Some((frame, timestamp, duration))) => {
                if frame.width > MAX_VIDEO_W || frame.height > MAX_VIDEO_H || frame.width < 2 || frame.height < 2 {
                    tracing::warn!("media video is too large to record");
                    return None;
                }
                self.latest = Some(opaque_bgra(frame));
                self.next_video = timestamp.saturating_add(duration.max(10_000));
                Some(true)
            }
            Ok(None) => Some(false),
            Err(err) => {
                tracing::warn!(error = %err, "media video stopped");
                None
            }
        }
    }

    fn read_audio(&mut self) -> Option<bool> {
        let reader = self.audio.as_ref()?;
        match read_pcm(reader) {
            Ok(Some((samples, timestamp, duration))) => {
                let at = self.sink.frame_at(crate::audio_timeline::qpc_hns());
                self.sink.mix(at, &samples, self.gain);
                self.next_audio = timestamp.saturating_add(duration.max(10_000));
                Some(true)
            }
            Ok(None) => Some(false),
            Err(err) => {
                tracing::warn!(error = %err, "media audio stopped");
                None
            }
        }
    }

    fn finish_video(&mut self) {
        if self.looping {
            self.restart();
        } else {
            self.video_done = true;
        }
    }

    fn finish_audio(&mut self) {
        if self.looping {
            self.restart();
        } else {
            self.audio_done = true;
        }
    }

    fn restart(&mut self) {
        if let Some(reader) = self.video.as_ref() {
            let _ = seek_hns(reader, 0);
        }
        if let Some(reader) = self.audio.as_ref() {
            let _ = seek_audio(reader, 0);
        }
        self.origin = Instant::now();
        self.next_video = 0;
        self.next_audio = 0;
        self.video_done = self.video.is_none();
        self.audio_done = self.audio.is_none();
    }
}

fn opaque_bgra(mut frame: StillFrame) -> StillFrame {
    let width = frame.width as usize;
    let height = frame.height as usize;
    let row = width.saturating_mul(4);
    let pitch = frame.pitch as usize;
    if row == 0 || height == 0 || pitch < row {
        return frame;
    }
    let mut packed = vec![0u8; row * height];
    for y in 0..height {
        let start = y.saturating_mul(pitch);
        let end = start.saturating_add(row).min(frame.bgra.len());
        if start >= frame.bgra.len() || end < start + row {
            break;
        }
        let dest = y * row;
        packed[dest..dest + row].copy_from_slice(&frame.bgra[start..start + row]);
        for pixel in packed[dest..dest + row].chunks_exact_mut(4) {
            pixel[3] = 255;
        }
    }
    frame.bgra = packed;
    frame.pitch = row as u32;
    frame
}

fn open_audio_reader(path: &Path) -> Result<IMFSourceReader, String> {
    let wide = wide_path(path);
    unsafe {
        let mut attrs = None;
        MFCreateAttributes(&mut attrs, 1).map_err(|err| err.to_string())?;
        let reader = MFCreateSourceReaderFromURL(PCWSTR(wide.as_ptr()), attrs.as_ref())
            .map_err(|err| err.to_string())?;
        let _ = reader.SetStreamSelection(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32, false);
        reader
            .SetStreamSelection(MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32, true)
            .map_err(|err| err.to_string())?;
        let pcm = pcm_type()?;
        reader
            .SetCurrentMediaType(MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32, None, &pcm)
            .map_err(|err| err.to_string())?;
        Ok(reader)
    }
}

fn pcm_type() -> Result<IMFMediaType, String> {
    unsafe {
        let media = MFCreateMediaType().map_err(|err| err.to_string())?;
        media.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio).map_err(|err| err.to_string())?;
        media.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_PCM).map_err(|err| err.to_string())?;
        media.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16).map_err(|err| err.to_string())?;
        media.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, PCM_RATE).map_err(|err| err.to_string())?;
        media.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, 2).map_err(|err| err.to_string())?;
        media.SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, 4).map_err(|err| err.to_string())?;
        media
            .SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, PCM_RATE * 4)
            .map_err(|err| err.to_string())?;
        Ok(media)
    }
}

fn read_pcm(reader: &IMFSourceReader) -> Result<Option<(Vec<i16>, i64, i64)>, String> {
    let mut flags = 0u32;
    let mut timestamp = 0i64;
    let mut sample: Option<IMFSample> = None;
    unsafe {
        reader
            .ReadSample(
                MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32,
                0,
                None,
                Some(&mut flags),
                Some(&mut timestamp),
                Some(&mut sample),
            )
            .map_err(|err| err.to_string())?;
    }
    if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
        return Ok(None);
    }
    let Some(sample) = sample else {
        return Ok(None);
    };
    let duration = unsafe { sample.GetSampleDuration().unwrap_or(0) }.max(10_000);
    let buffer = unsafe { sample.ConvertToContiguousBuffer().map_err(|err| err.to_string())? };
    let mut data = std::ptr::null_mut();
    let mut length = 0u32;
    unsafe {
        buffer.Lock(&mut data, None, Some(&mut length)).map_err(|err| err.to_string())?;
    }
    if data.is_null() || length < 4 {
        let _ = unsafe { buffer.Unlock() };
        return Ok(None);
    }
    let bytes = unsafe { std::slice::from_raw_parts(data, length as usize) };
    let samples: Vec<i16> = bytes
        .chunks_exact(2)
        .map(|pair| i16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    unsafe { buffer.Unlock().map_err(|err| err.to_string())? };
    if samples.len() < 2 {
        return Ok(None);
    }
    Ok(Some((samples, timestamp, duration)))
}

fn seek_audio(reader: &IMFSourceReader, position_hns: i64) -> Result<(), String> {
    seek_hns(reader, position_hns)
}

fn wide_path(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
}
