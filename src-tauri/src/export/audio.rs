//! Export audio decode, stitch, and compose remux helpers.

use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;

use windows::core::{GUID, PCWSTR};
use windows::Win32::Media::MediaFoundation::{
    IMFMediaType, IMFSample, IMFSinkWriter, IMFSourceReader, MFAudioFormat_AAC, MFCreateAttributes,
    MFCreateMemoryBuffer, MFCreateSample, MFCreateSourceReaderFromURL, MFMediaType_Audio,
    MF_MT_MAJOR_TYPE, MF_MT_SUBTYPE, MF_SOURCE_READERF_ENDOFSTREAM,
    MF_SOURCE_READER_FIRST_AUDIO_STREAM, MF_SOURCE_READER_FIRST_VIDEO_STREAM,
};
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;

use crate::encode::MfWriter;

use super::writer::{pcm_input_type, wide_path, MF_READWRITE_DISABLE_CONVERTERS};

const MF_LOW_LATENCY: GUID = GUID::from_u128(0x9c27891a_ed7a_40e1_88e8_b22727a024ee);
pub(super) const PCM_RATE: u32 = 48_000;
#[allow(dead_code)]
pub(super) const PCM_CHANNELS: u32 = 2;
pub(super) const PCM_ALIGN: usize = 4;
pub(super) const PCM_BYTES_PER_SEC: u32 = PCM_RATE * PCM_ALIGN as u32;
const AAC_CHUNK_BYTES: usize = 1024 * PCM_ALIGN;
const JOIN_FADE_BYTES: usize = (PCM_RATE as usize * PCM_ALIGN * 10) / 1000;

pub(crate) fn spawn_compose_audio(
    gameplay: &Path,
    start_hns: i64,
    end_hns: i64,
) -> std::sync::mpsc::Receiver<Vec<u8>> {
    let path = gameplay.to_path_buf();
    let (tx, rx) = std::sync::mpsc::channel();
    let _ = std::thread::Builder::new()
        .name("compose-audio".into())
        .spawn(move || {
            let pcm = if start_hns > 0 || end_hns < i64::MAX {
                decode_audio_range(&path, start_hns.max(0), end_hns).unwrap_or_default()
            } else {
                decode_audio_pcm(&path).unwrap_or_default()
            };
            let _ = tx.send(pcm);
        });
    rx
}

pub(super) fn decode_audio_range(
    path: &Path,
    start_hns: i64,
    end_hns: i64,
) -> Result<Vec<u8>, String> {
    let mut pcm = decode_audio_pcm(path)?;
    if start_hns <= 0 {
        skip_aac_encoder_delay(&mut pcm);
    }
    let start = hns_to_pcm_bytes(start_hns).min(pcm.len());
    let end = hns_to_pcm_bytes(end_hns).min(pcm.len()).max(start);
    if start == 0 && end == pcm.len() {
        return Ok(pcm);
    }
    if start == 0 {
        pcm.truncate(end);
        return Ok(pcm);
    }
    Ok(pcm[start..end].to_vec())
}

pub(super) fn load_segment_pcm(path: &Path) -> (Vec<u8>, bool) {
    let sidecar = crate::encode::pcm_sidecar_path(path);
    if sidecar.is_file() {
        match std::fs::read(&sidecar) {
            Ok(mut pcm) => {
                let aligned = pcm.len() - (pcm.len() % PCM_ALIGN);
                pcm.truncate(aligned);
                return (pcm, true);
            }
            Err(err) => {
                tracing::warn!("could not read PCM sidecar {}: {err}", sidecar.display());
            }
        }
    }
    match decode_audio_pcm(path) {
        Ok(mut pcm) => {
            skip_aac_encoder_delay(&mut pcm);
            (pcm, false)
        }
        Err(err) => {
            tracing::warn!("could not decode segment audio for stitch: {err}");
            (Vec::new(), false)
        }
    }
}

/// Media Foundation AAC encode/decode inserts ~2048–2112 priming frames.
/// Leaving them in would click at every 2 s join and then `fit_pcm_to_video` would
/// chop real audio off the end of the segment.
fn skip_aac_encoder_delay(pcm: &mut Vec<u8>) {
    const DELAY_BYTES: usize = 2112 * PCM_ALIGN;
    if pcm.len() > DELAY_BYTES {
        pcm.drain(..DELAY_BYTES);
    }
}

pub(super) fn decode_audio_pcm(path: &Path) -> Result<Vec<u8>, String> {
    let wide = wide_path(path);
    let reader = unsafe {
        let mut attrs = None;
        MFCreateAttributes(&mut attrs, 3).map_err(|err| err.to_string())?;
        let attrs = attrs.ok_or_else(|| "Could not create reader attributes.".to_string())?;
        let _ = attrs.SetUINT32(&MF_LOW_LATENCY, 1);
        let reader = MFCreateSourceReaderFromURL(PCWSTR(wide.as_ptr()), Some(&attrs))
            .map_err(|err| format!("Could not open {}: {err}", path.display()))?;
        let _ = reader.SetStreamSelection(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32, false);
        let _ = reader.SetStreamSelection(MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32, true);
        let pcm_type = pcm_input_type()?;
        reader
            .SetCurrentMediaType(
                MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32,
                None,
                &pcm_type,
            )
            .map_err(|err| format!("Could not decode audio from {}: {err}", path.display()))?;
        reader
    };
    let mut pcm = Vec::new();
    loop {
        let mut flags = 0_u32;
        let mut sample: Option<IMFSample> = None;
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
                .map_err(|err| format!("Could not read decoded audio: {err}"))?;
        }
        if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
            break;
        }
        let Some(sample) = sample else {
            continue;
        };
        let buffer = unsafe { sample.ConvertToContiguousBuffer() }
            .map_err(|err| format!("Could not read an audio buffer: {err}"))?;
        let mut data = std::ptr::null_mut();
        let mut length = 0_u32;
        unsafe {
            buffer
                .Lock(&mut data, None, Some(&mut length))
                .map_err(|err| err.to_string())?;
            if !data.is_null() && length > 0 {
                pcm.extend_from_slice(std::slice::from_raw_parts(data, length as usize));
            }
            let _ = buffer.Unlock();
        }
    }
    let aligned = pcm.len() - (pcm.len() % PCM_ALIGN);
    pcm.truncate(aligned);
    Ok(pcm)
}

pub(super) fn append_pcm_file(
    file: &mut std::fs::File,
    dest_len: &mut u64,
    next: &[u8],
) -> Result<(), String> {
    let next_len = next.len() - (next.len() % PCM_ALIGN);
    if next_len == 0 {
        return Ok(());
    }
    file.write_all(&next[..next_len])
        .map_err(|err| format!("Could not write audio: {err}"))?;
    *dest_len += next_len as u64;
    Ok(())
}

pub(super) fn append_crossfade_file(
    file: &mut std::fs::File,
    dest_len: &mut u64,
    next: &[u8],
) -> Result<(), String> {
    let next_len = next.len() - (next.len() % PCM_ALIGN);
    if *dest_len == 0 || next_len == 0 {
        return append_pcm_file(file, dest_len, next);
    }
    let fade = JOIN_FADE_BYTES.min(*dest_len as usize).min(next_len);
    let fade = fade - (fade % PCM_ALIGN);
    if fade == 0 {
        return append_pcm_file(file, dest_len, next);
    }
    file.seek(SeekFrom::End(-(fade as i64)))
        .map_err(|err| format!("Could not join audio: {err}"))?;
    let mut dest_fade = vec![0u8; fade];
    file.read_exact(&mut dest_fade)
        .map_err(|err| format!("Could not join audio: {err}"))?;
    let frames = fade / PCM_ALIGN;
    for index in 0..frames {
        let t = (index + 1) as f32 / (frames + 1) as f32;
        for channel in 0..2 {
            let offset = index * PCM_ALIGN + channel * 2;
            let previous = i16::from_le_bytes([dest_fade[offset], dest_fade[offset + 1]]) as f32;
            let incoming = i16::from_le_bytes([next[offset], next[offset + 1]]) as f32;
            let mixed = previous * (1.0 - t) + incoming * t;
            dest_fade[offset..offset + 2].copy_from_slice(&(mixed.round() as i16).to_le_bytes());
        }
    }
    file.seek(SeekFrom::End(-(fade as i64)))
        .map_err(|err| format!("Could not join audio: {err}"))?;
    file.write_all(&dest_fade)
        .map_err(|err| format!("Could not write audio: {err}"))?;
    file.write_all(&next[fade..next_len])
        .map_err(|err| format!("Could not write audio: {err}"))?;
    *dest_len += (next_len - fade) as u64;
    Ok(())
}

pub(super) fn hns_to_pcm_bytes(hns: i64) -> usize {
    let bytes = (hns.max(0) as u64) * u64::from(PCM_BYTES_PER_SEC) / 10_000_000;
    let bytes = bytes as usize;
    bytes - (bytes % PCM_ALIGN)
}

/// Pins `pcm` to the duration of the video it accompanies. Returns how far off
/// it was, in bytes; anything but a rounding error means audio went missing
/// upstream.
pub(crate) fn fit_pcm_to_video(pcm: &mut Vec<u8>, video_hns: i64) -> i64 {
    let want = hns_to_pcm_bytes(video_hns);
    let drift = pcm.len() as i64 - want as i64;
    if pcm.len() > want {
        pcm.truncate(want);
    } else if pcm.len() < want {
        pcm.resize(want, 0);
    }
    drift
}

pub(super) fn fit_pcm_file(
    file: &mut std::fs::File,
    len: &mut u64,
    video_hns: i64,
) -> Result<i64, String> {
    let want = hns_to_pcm_bytes(video_hns) as u64;
    let drift = *len as i64 - want as i64;
    if *len > want {
        file.set_len(want)
            .map_err(|err| format!("Could not trim audio: {err}"))?;
        *len = want;
    } else if *len < want {
        file.seek(SeekFrom::End(0))
            .map_err(|err| format!("Could not pad audio: {err}"))?;
        let zeros = [0u8; 8192];
        let mut remain = want - *len;
        while remain > 0 {
            let n = remain.min(zeros.len() as u64) as usize;
            file.write_all(&zeros[..n])
                .map_err(|err| format!("Could not pad audio: {err}"))?;
            remain -= n as u64;
        }
        *len = want;
    }
    Ok(drift)
}

pub(super) fn pcm_bytes_to_ms(bytes: i64) -> i64 {
    bytes * 1000 / i64::from(PCM_BYTES_PER_SEC)
}

pub(super) fn write_stitched_aac(
    writer: &IMFSinkWriter,
    stream: u32,
    mut pcm: impl Read,
) -> Result<(), String> {
    let mut time = 0_i64;
    let mut leftover = Vec::new();
    let mut buf = [0u8; AAC_CHUNK_BYTES];
    loop {
        while leftover.len() < AAC_CHUNK_BYTES {
            let n = pcm.read(&mut buf).map_err(|err| err.to_string())?;
            if n == 0 {
                break;
            }
            leftover.extend_from_slice(&buf[..n]);
        }
        if leftover.is_empty() {
            break;
        }
        let copy = leftover.len().min(AAC_CHUNK_BYTES);
        let copy = copy - (copy % PCM_ALIGN);
        if copy == 0 {
            break;
        }
        // Short last frames make the AAC MFT click. Pad to a full 1024-sample frame.
        let mut frame = vec![0u8; AAC_CHUNK_BYTES];
        frame[..copy].copy_from_slice(&leftover[..copy]);
        leftover.drain(..copy);
        let duration = (AAC_CHUNK_BYTES as i64) * 10_000_000 / i64::from(PCM_BYTES_PER_SEC);
        unsafe {
            let media_buffer =
                MFCreateMemoryBuffer(AAC_CHUNK_BYTES as u32).map_err(|err| err.to_string())?;
            let mut data = std::ptr::null_mut();
            media_buffer
                .Lock(&mut data, None, None)
                .map_err(|err| err.to_string())?;
            if !data.is_null() {
                std::ptr::copy_nonoverlapping(frame.as_ptr(), data, AAC_CHUNK_BYTES);
            }
            media_buffer.Unlock().map_err(|err| err.to_string())?;
            media_buffer
                .SetCurrentLength(AAC_CHUNK_BYTES as u32)
                .map_err(|err| err.to_string())?;
            let sample = MFCreateSample().map_err(|err| err.to_string())?;
            sample
                .AddBuffer(&media_buffer)
                .map_err(|err| err.to_string())?;
            sample.SetSampleTime(time).map_err(|err| err.to_string())?;
            sample
                .SetSampleDuration(duration)
                .map_err(|err| err.to_string())?;
            writer
                .WriteSample(stream, &sample)
                .map_err(|err| format!("Could not write stitched audio: {err}"))?;
        }
        time += duration;
        if leftover.is_empty() && copy < AAC_CHUNK_BYTES {
            break;
        }
    }
    Ok(())
}

pub(crate) fn probe_copyable_audio(path: &Path) -> Option<IMFMediaType> {
    let reader = open_copy_reader(path).ok()?;
    let media_type = unsafe {
        reader
            .GetNativeMediaType(MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32, 0)
            .ok()?
    };
    let major = unsafe { media_type.GetGUID(&MF_MT_MAJOR_TYPE).ok()? };
    if major != MFMediaType_Audio {
        return None;
    }
    let subtype = unsafe { media_type.GetGUID(&MF_MT_SUBTYPE).ok()? };
    if subtype != MFAudioFormat_AAC {
        tracing::info!(
            ?subtype,
            "compose audio is not AAC; will decode to PCM if needed"
        );
        return None;
    }
    Some(media_type)
}

pub(crate) fn remux_aac(
    writer: &mut MfWriter,
    path: &Path,
    start_hns: i64,
    end_hns: i64,
) -> Result<&'static str, String> {
    let reader = open_copy_reader(path)?;
    if start_hns > 0 {
        unsafe {
            let position = PROPVARIANT::from(start_hns);
            reader
                .SetCurrentPosition(&GUID::zeroed(), &position)
                .map_err(|err| format!("Could not seek compose audio: {err}"))?;
        }
    }
    let mut origin = None;
    let mut previous = None;
    loop {
        let mut flags = 0_u32;
        let mut timestamp = 0_i64;
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
                .map_err(|err| format!("Could not read compose audio: {err}"))?;
        }
        if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
            break;
        }
        if timestamp >= end_hns {
            break;
        }
        let Some(sample) = sample else {
            continue;
        };
        let from_sample = unsafe { sample.GetSampleDuration().unwrap_or(0) };
        let from_delta = previous
            .map(|last: i64| timestamp.saturating_sub(last))
            .unwrap_or(0);
        previous = Some(timestamp);
        let duration = if from_sample >= 10_000 {
            from_sample
        } else if from_delta >= 10_000 {
            from_delta
        } else {
            10_000_000 / 48
        };
        let _ = origin.get_or_insert(timestamp);
        writer.write_copied_audio(&sample, duration)?;
    }
    Ok("aac_copy")
}

/// Streams compressed AAC into the MP4 mux alongside the video encode instead of after
/// it, so the sink never holds a whole clip of video waiting for audio to catch up.
pub(crate) struct AacFeeder {
    reader: IMFSourceReader,
    end_hns: i64,
    previous: Option<i64>,
    done: bool,
    written: u64,
}

impl AacFeeder {
    pub(crate) fn open(path: &Path, start_hns: i64, end_hns: i64) -> Result<Self, String> {
        let reader = open_copy_reader(path)?;
        if start_hns > 0 {
            unsafe {
                let position = PROPVARIANT::from(start_hns);
                reader
                    .SetCurrentPosition(&GUID::zeroed(), &position)
                    .map_err(|err| format!("Could not seek compose audio: {err}"))?;
            }
        }
        Ok(Self {
            reader,
            end_hns,
            previous: None,
            done: false,
            written: 0,
        })
    }

    pub(crate) fn is_done(&self) -> bool {
        self.done
    }

    pub(crate) fn samples_written(&self) -> u64 {
        self.written
    }

    /// Feeds AAC until the mux audio clock reaches `target_hns`, or the source runs out.
    pub(crate) fn feed_until(
        &mut self,
        mux: &mut super::mux::H264Mp4Mux,
        target_hns: i64,
    ) -> Result<(), String> {
        while !self.done && mux.audio_time_hns() < target_hns {
            let mut flags = 0_u32;
            let mut timestamp = 0_i64;
            let mut sample: Option<IMFSample> = None;
            unsafe {
                self.reader
                    .ReadSample(
                        MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32,
                        0,
                        None,
                        Some(&mut flags),
                        Some(&mut timestamp),
                        Some(&mut sample),
                    )
                    .map_err(|err| format!("Could not read compose audio: {err}"))?;
            }
            if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 || timestamp >= self.end_hns {
                self.done = true;
                break;
            }
            let Some(sample) = sample else {
                continue;
            };
            let from_sample = unsafe { sample.GetSampleDuration().unwrap_or(0) };
            let from_delta = self
                .previous
                .map(|last: i64| timestamp.saturating_sub(last))
                .unwrap_or(0);
            self.previous = Some(timestamp);
            let duration = if from_sample >= 10_000 {
                from_sample
            } else if from_delta >= 10_000 {
                from_delta
            } else {
                10_000_000 / 48
            };
            mux.write_audio(&sample, duration)?;
            self.written += 1;
        }
        Ok(())
    }

    /// Drains whatever audio remains once the video encode has finished.
    pub(crate) fn finish(&mut self, mux: &mut super::mux::H264Mp4Mux) -> Result<(), String> {
        self.feed_until(mux, i64::MAX)
    }
}

fn open_copy_reader(path: &Path) -> Result<IMFSourceReader, String> {
    let wide = wide_path(path);
    unsafe {
        let mut attrs = None;
        MFCreateAttributes(&mut attrs, 2).map_err(|err| err.to_string())?;
        let attrs = attrs.ok_or_else(|| "Could not create audio reader attributes.".to_string())?;
        let _ = attrs.SetUINT32(&MF_READWRITE_DISABLE_CONVERTERS, 1);
        let reader = MFCreateSourceReaderFromURL(PCWSTR(wide.as_ptr()), Some(&attrs))
            .map_err(|err| format!("Could not open compose audio {}: {err}", path.display()))?;
        let _ = reader.SetStreamSelection(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32, false);
        let _ = reader.SetStreamSelection(MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32, true);
        Ok(reader)
    }
}
