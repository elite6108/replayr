//! Speech-sized AAC for transcription. The source file is streamed, never held as PCM.

use std::path::{Path, PathBuf};

use windows::core::PCWSTR;
use windows::Win32::Media::MediaFoundation::{
    IMFMediaType, IMFSinkWriter, MFAudioFormat_AAC, MFCreateAttributes,
    MFCreateMediaType, MFCreateMemoryBuffer, MFCreateSample, MFCreateSinkWriterFromURL,
    MFCreateSourceReaderFromURL, MFMediaType_Audio, MFStartup, MFSTARTUP_FULL,
    MF_MT_AAC_AUDIO_PROFILE_LEVEL_INDICATION, MF_MT_AAC_PAYLOAD_TYPE,
    MF_MT_AUDIO_AVG_BYTES_PER_SECOND, MF_MT_AUDIO_BITS_PER_SAMPLE, MF_MT_AUDIO_BLOCK_ALIGNMENT,
    MF_MT_AUDIO_NUM_CHANNELS, MF_MT_AUDIO_SAMPLES_PER_SECOND, MF_MT_AVG_BITRATE, MF_MT_MAJOR_TYPE,
    MF_MT_SUBTYPE, MF_SINK_WRITER_DISABLE_THROTTLING, MF_SOURCE_READERF_ENDOFSTREAM,
    MF_SOURCE_READER_FIRST_AUDIO_STREAM, MF_SOURCE_READER_FIRST_VIDEO_STREAM, MF_VERSION,
};

use super::writer::{pcm_input_type, wide_path};

const SOURCE_ALIGN: usize = 4;
const OUT_RATE: u32 = 48_000;
const FRAME_SAMPLES: usize = 1024;
const FRAME_BYTES: usize = FRAME_SAMPLES * SOURCE_ALIGN;
const PART_SAMPLES: u64 = 10 * 60 * OUT_RATE as u64;
const MAX_PART_BYTES: u64 = 15 * 1024 * 1024;
const MAX_PARTS: usize = 5;
pub const MAX_TRANSCRIPT_MS: u64 = 45 * 60 * 1000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpeechPart {
    pub path: PathBuf,
    pub start_ms: u64,
    pub duration_ms: u64,
}

pub struct SpeechAudio {
    pub parts: Vec<SpeechPart>,
    pub duration_ms: u64,
}

pub fn extract_speech_audio(source: &Path, dest_dir: &Path) -> Result<SpeechAudio, String> {
    unsafe {
        MFStartup(MF_VERSION, MFSTARTUP_FULL).map_err(|err| err.to_string())?;
    }
    let reader = open_reader(source)?;
    let mut pending = Vec::new();
    let mut current: Option<PartFile> = None;
    let mut parts = Vec::new();
    let mut start_ms = 0_u64;

    loop {
        let mut flags = 0_u32;
        let mut sample = None;
        unsafe {
            reader
                .ReadSample(
                    MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32,
                    0,
                    None,
                    Some(&mut flags),
                    None,
                    Some(&mut sample),
                )
                .map_err(|err| format!("Could not read audio: {err}"))?;
        }
        let ended = flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0;
        if let Some(sample) = sample {
            let buffer = unsafe { sample.ConvertToContiguousBuffer() }.map_err(|err| err.to_string())?;
            let mut data = std::ptr::null_mut();
            let mut length = 0_u32;
            unsafe {
                buffer
                    .Lock(&mut data, None, Some(&mut length))
                    .map_err(|err| err.to_string())?;
                if !data.is_null() && length > 0 {
                    let bytes = std::slice::from_raw_parts(data, length as usize);
                    let aligned = bytes.len() - (bytes.len() % SOURCE_ALIGN);
                    pending.extend_from_slice(&bytes[..aligned]);
                }
                let _ = buffer.Unlock();
            }
            flush_pcm(&mut pending, &mut current, &mut parts, dest_dir, &mut start_ms, false)?;
        }
        if ended {
            break;
        }
    }
    flush_pcm(&mut pending, &mut current, &mut parts, dest_dir, &mut start_ms, true)?;
    if let Some(file) = current.take() {
        let part = file.finish()?;
        start_ms += part.duration_ms;
        parts.push(part);
    }
    if parts.is_empty() || start_ms == 0 {
        return Err("This clip has no audio to transcribe.".into());
    }
    if start_ms > MAX_TRANSCRIPT_MS {
        return Err("Trim this clip under 45 minutes first.".into());
    }
    Ok(SpeechAudio {
        duration_ms: start_ms,
        parts,
    })
}

fn flush_pcm(
    mono: &mut Vec<u8>,
    current: &mut Option<PartFile>,
    parts: &mut Vec<SpeechPart>,
    dest_dir: &Path,
    start_ms: &mut u64,
    closing: bool,
) -> Result<(), String> {
    while mono.len() >= FRAME_BYTES || (closing && !mono.is_empty()) {
        let take = if mono.len() >= FRAME_BYTES {
            FRAME_BYTES
        } else {
            mono.len() - (mono.len() % 2)
        };
        if take == 0 {
            mono.clear();
            break;
        }
        let chunk: Vec<u8> = mono.drain(..take).collect();
        if current.as_ref().is_some_and(|file| file.needs_rotate()) {
            let finished = current.take().expect("rotate checked").finish()?;
            *start_ms += finished.duration_ms;
            parts.push(finished);
        }
        if current.is_none() {
            *current = Some(open_part(dest_dir, parts.len(), *start_ms)?);
        }
        current
            .as_mut()
            .expect("part opened")
            .write(&chunk)?;
    }
    Ok(())
}

fn open_part(dest_dir: &Path, index: usize, start_ms: u64) -> Result<PartFile, String> {
    if index >= MAX_PARTS {
        return Err("Trim this clip under 45 minutes first.".into());
    }
    let path = dest_dir.join(format!("part-{index:02}.m4a"));
    PartFile::create(&path, start_ms)
}

struct PartFile {
    writer: IMFSinkWriter,
    stream: u32,
    path: PathBuf,
    start_ms: u64,
    samples: u64,
    time: i64,
}

impl PartFile {
    fn create(path: &Path, start_ms: u64) -> Result<Self, String> {
        let (writer, stream) = open_aac_writer(path)?;
        Ok(Self {
            writer,
            stream,
            path: path.to_path_buf(),
            start_ms,
            samples: 0,
            time: 0,
        })
    }

    fn needs_rotate(&self) -> bool {
        if self.samples >= PART_SAMPLES {
            return true;
        }
        self.samples > 0
            && std::fs::metadata(&self.path)
                .map(|meta| meta.len() >= MAX_PART_BYTES)
                .unwrap_or(false)
    }

    fn write(&mut self, pcm: &[u8]) -> Result<(), String> {
        let samples = (pcm.len() / SOURCE_ALIGN) as u64;
        let next_ms = self.start_ms + ((self.samples + samples) * 1000) / OUT_RATE as u64;
        if next_ms > MAX_TRANSCRIPT_MS + 1000 {
            return Err("Trim this clip under 45 minutes first.".into());
        }
        let duration = (samples as i64) * 10_000_000 / OUT_RATE as i64;
        write_pcm_sample(&self.writer, self.stream, pcm, self.time, duration)?;
        self.time += duration;
        self.samples += samples;
        Ok(())
    }

    fn finish(self) -> Result<SpeechPart, String> {
        unsafe { self.writer.Finalize().map_err(|err| err.to_string())? };
        Ok(SpeechPart {
            path: self.path,
            start_ms: self.start_ms,
            duration_ms: self.samples.saturating_mul(1000) / OUT_RATE as u64,
        })
    }
}

fn open_reader(path: &Path) -> Result<windows::Win32::Media::MediaFoundation::IMFSourceReader, String> {
    let wide = wide_path(path);
    unsafe {
        let mut attrs = None;
        MFCreateAttributes(&mut attrs, 2).map_err(|err| err.to_string())?;
        let attrs = attrs.ok_or_else(|| "Could not create reader attributes.".to_string())?;
        let reader = MFCreateSourceReaderFromURL(PCWSTR(wide.as_ptr()), Some(&attrs))
            .map_err(|err| format!("Could not open {}: {err}", path.display()))?;
        let _ = reader.SetStreamSelection(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32, false);
        let _ = reader.SetStreamSelection(MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32, true);
        let pcm = pcm_input_type()?;
        reader
            .SetCurrentMediaType(MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32, None, &pcm)
            .map_err(|_| "This clip has no audio to transcribe.".to_string())?;
        Ok(reader)
    }
}

fn open_aac_writer(path: &Path) -> Result<(IMFSinkWriter, u32), String> {
    let wide = wide_path(path);
    unsafe {
        let mut attrs = None;
        MFCreateAttributes(&mut attrs, 2).map_err(|err| err.to_string())?;
        let attrs = attrs.ok_or_else(|| "Could not create writer attributes.".to_string())?;
        let _ = attrs.SetUINT32(&MF_SINK_WRITER_DISABLE_THROTTLING, 1);
        let writer = MFCreateSinkWriterFromURL(PCWSTR(wide.as_ptr()), None, Some(&attrs))
            .map_err(|err| format!("Could not create the speech file: {err}"))?;
        let output = aac_type()?;
        let stream = writer
            .AddStream(&output)
            .map_err(|err| format!("Could not add the speech stream: {err}"))?;
        let input = pcm_input_type()?;
        writer
            .SetInputMediaType(stream, &input, None)
            .map_err(|err| format!("Could not set the speech input: {err}"))?;
        writer
            .BeginWriting()
            .map_err(|err| format!("Could not begin the speech file: {err}"))?;
        Ok((writer, stream))
    }
}

fn aac_type() -> Result<IMFMediaType, String> {
    unsafe {
        let media = MFCreateMediaType().map_err(|err| err.to_string())?;
        media.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio).map_err(|err| err.to_string())?;
        media.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_AAC).map_err(|err| err.to_string())?;
        media.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16).map_err(|err| err.to_string())?;
        media.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, OUT_RATE).map_err(|err| err.to_string())?;
        media.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, 2).map_err(|err| err.to_string())?;
        media.SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, 1).map_err(|err| err.to_string())?;
        media.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, 24_000).map_err(|err| err.to_string())?;
        media.SetUINT32(&MF_MT_AVG_BITRATE, 192_000).map_err(|err| err.to_string())?;
        media.SetUINT32(&MF_MT_AAC_PAYLOAD_TYPE, 0).map_err(|err| err.to_string())?;
        media
            .SetUINT32(&MF_MT_AAC_AUDIO_PROFILE_LEVEL_INDICATION, 0x29)
            .map_err(|err| err.to_string())?;
        Ok(media)
    }
}

fn write_pcm_sample(writer: &IMFSinkWriter, stream: u32, pcm: &[u8], time: i64, duration: i64) -> Result<(), String> {
    unsafe {
        let buffer = MFCreateMemoryBuffer(pcm.len() as u32).map_err(|err| err.to_string())?;
        let mut data = std::ptr::null_mut();
        buffer.Lock(&mut data, None, None).map_err(|err| err.to_string())?;
        if !data.is_null() {
            std::ptr::copy_nonoverlapping(pcm.as_ptr(), data, pcm.len());
        }
        buffer.Unlock().map_err(|err| err.to_string())?;
        buffer.SetCurrentLength(pcm.len() as u32).map_err(|err| err.to_string())?;
        let sample = MFCreateSample().map_err(|err| err.to_string())?;
        sample.AddBuffer(&buffer).map_err(|err| err.to_string())?;
        sample.SetSampleTime(time).map_err(|err| err.to_string())?;
        sample.SetSampleDuration(duration).map_err(|err| err.to_string())?;
        writer.WriteSample(stream, &sample).map_err(|err| err.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_one_second_clip_becomes_a_timed_m4a() {
        let dir = std::env::temp_dir().join(format!("replayr-speech-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let source = dir.join("tone.mp4");
        let mut writer = crate::encode::MfWriter::create(
            &source,
            320,
            180,
            30,
            1_000_000,
            true,
            None,
            true,
            crate::encode::VideoInput::Bgra,
            false,
        )
        .unwrap();
        let mut bgra = vec![0_u8; 320 * 180 * 4];
        for pixel in bgra.chunks_exact_mut(4) {
            pixel[2] = 180;
            pixel[3] = 255;
        }
        for index in 0..30 {
            writer
                .write_bgra(&bgra, 320 * 4, 320, 180, index * 333_333, index == 0)
                .unwrap();
        }
        let mut pcm = Vec::new();
        for index in 0..(48_000 / 30 * 30) {
            let sample = ((index as f32 * 0.08).sin() * 4_000.0) as i16;
            pcm.extend_from_slice(&sample.to_le_bytes());
            pcm.extend_from_slice(&sample.to_le_bytes());
        }
        writer.write_pcm_closing(&pcm).unwrap();
        writer.finish().unwrap();

        let out = dir.join("out");
        std::fs::create_dir_all(&out).unwrap();
        let audio = super::extract_speech_audio(&source, &out).unwrap();
        assert_eq!(audio.parts.len(), 1);
        assert!((700..1_500).contains(&audio.duration_ms), "got {}", audio.duration_ms);
        let bytes = std::fs::read(&audio.parts[0].path).unwrap();
        assert!(bytes.len() > 500);
        assert_eq!(&bytes[4..8], b"ftyp");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
