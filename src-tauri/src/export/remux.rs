use std::fs::OpenOptions;
use std::io::{Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::Instant;

use windows::core::{GUID, PCWSTR};
use windows::Win32::Media::MediaFoundation::{
    IMFMediaType, IMFSample, IMFSinkWriter, IMFSourceReader, MFCreateAttributes,
    MFCreateSourceReaderFromURL, MFStartup, MFSTARTUP_FULL, MF_MT_FRAME_RATE,
    MF_SOURCE_READERF_ENDOFSTREAM, MF_SOURCE_READER_FIRST_AUDIO_STREAM,
    MF_SOURCE_READER_FIRST_VIDEO_STREAM, MF_VERSION,
};
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;

use super::audio::{
    append_crossfade_file, append_pcm_file, fit_pcm_file, fit_pcm_to_video, hns_to_pcm_bytes,
    load_segment_pcm, pcm_bytes_to_ms, write_stitched_aac,
};
use super::writer::{open_writer, wide_path, WriterAudio, MF_READWRITE_DISABLE_CONVERTERS};

const MF_LOW_LATENCY: GUID = GUID::from_u128(0x9c27891a_ed7a_40e1_88e8_b22727a024ee);

struct RemovePath(PathBuf);

impl Drop for RemovePath {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

pub fn concat_mp4s(inputs: &[PathBuf], output: &Path) -> Result<(), String> {
    concat_mp4s_inner(inputs, output, false)
}

/// Like [`concat_mp4s`], but keeps each source sample's presentation gaps.
/// Webcam rolling writes sparse PTS for dropped frames; packing those gaps
/// out again would make the cam run ahead and hitch at segment joins.
pub fn concat_mp4s_preserve_timeline(inputs: &[PathBuf], output: &Path) -> Result<(), String> {
    concat_mp4s_inner(inputs, output, true)
}

fn concat_mp4s_inner(
    inputs: &[PathBuf],
    output: &Path,
    preserve_timeline: bool,
) -> Result<(), String> {
    if inputs.is_empty() {
        return Err("Replay buffer is empty.".into());
    }
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let started = Instant::now();
    unsafe {
        MFStartup(MF_VERSION, MFSTARTUP_FULL).map_err(|err| err.to_string())?;
    }

    let first = open_reader(&inputs[0])?;
    let video_type = native_type(&first, MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32)
        .ok_or_else(|| "Replay segment has no video.".to_string())?;
    let has_mp4_audio = native_type(&first, MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32).is_some();
    drop(first);
    let has_audio = has_mp4_audio
        || inputs
            .iter()
            .any(|path| crate::encode::pcm_sidecar_path(path).is_file());

    let writer = open_writer(
        output,
        &video_type,
        if has_audio {
            WriterAudio::StitchedAac
        } else {
            WriterAudio::None
        },
    )?;
    let fallback = frame_duration_hns(&video_type);
    let mut video_time = 0_i64;
    let pcm_tmp = output.with_extension("concat.pcm");
    let mut pcm_file = if has_audio {
        Some(
            OpenOptions::new()
                .create(true)
                .read(true)
                .write(true)
                .truncate(true)
                .open(&pcm_tmp)
                .map_err(|err| format!("Could not stage audio: {err}"))?,
        )
    } else {
        None
    };
    let _pcm_guard = has_audio.then(|| RemovePath(pcm_tmp.clone()));
    let mut pcm_len = 0_u64;

    for path in inputs {
        let reader = open_reader(path)?;
        let video_before = video_time;
        if preserve_timeline {
            copy_stream_preserve(
                &reader,
                &writer,
                0,
                MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32,
                &mut video_time,
                fallback,
            )?;
        } else {
            copy_stream(
                &reader,
                &writer,
                0,
                MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32,
                &mut video_time,
                fallback,
                None,
            )?;
        }
        drop(reader);
        if let Some(pcm_file) = pcm_file.as_mut() {
            let video_added = video_time.saturating_sub(video_before);
            let (mut chunk, from_sidecar) = load_segment_pcm(path);
            if from_sidecar {
                let drift = fit_pcm_to_video(&mut chunk, video_added);
                if drift.abs() > hns_to_pcm_bytes(200_000) as i64 {
                    tracing::warn!(
                        "segment {} audio was {} ms off its video",
                        path.display(),
                        pcm_bytes_to_ms(drift)
                    );
                }
                append_pcm_file(pcm_file, &mut pcm_len, &chunk)?;
            } else {
                if chunk.is_empty() {
                    chunk = vec![0u8; hns_to_pcm_bytes(video_added)];
                }
                append_crossfade_file(pcm_file, &mut pcm_len, &chunk)?;
            }
        }
    }

    if let Some(pcm_file) = pcm_file.as_mut() {
        fit_pcm_file(pcm_file, &mut pcm_len, video_time)?;
        pcm_file
            .seek(SeekFrom::Start(0))
            .map_err(|err| format!("Could not rewind audio: {err}"))?;
        write_stitched_aac(&writer, 1, pcm_file)?;
    }

    unsafe {
        writer
            .Finalize()
            .map_err(|err| format!("Could not finish the clip: {err}"))?;
    }
    tracing::info!(
        "remuxed {} segments in {} ms -> {}",
        inputs.len(),
        started.elapsed().as_millis(),
        output.display()
    );
    Ok(())
}

pub fn trim_mp4(input: &Path, output: &Path, start_hns: i64, end_hns: i64) -> Result<i64, String> {
    if !input.exists() {
        return Err("That clip is no longer on disk.".into());
    }
    if end_hns <= start_hns {
        return Err("Choose a longer selection.".into());
    }
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let started = Instant::now();
    unsafe {
        MFStartup(MF_VERSION, MFSTARTUP_FULL).map_err(|err| err.to_string())?;
    }

    let probe = open_reader(input)?;
    let video_type = native_type(&probe, MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32)
        .ok_or_else(|| "That clip has no video.".to_string())?;
    let audio_type = native_type(&probe, MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32);
    let copy_audio = audio_type.is_some();
    drop(probe);

    let writer = open_writer(
        output,
        &video_type,
        match audio_type {
            Some(media_type) => WriterAudio::Copy(media_type),
            None => WriterAudio::None,
        },
    )?;
    let fallback = frame_duration_hns(&video_type);
    let mut video_time = 0_i64;
    let mut audio_time = 0_i64;

    let video_reader = open_reader(input)?;
    seek_reader(&video_reader, start_hns)?;
    let mut origin = None;
    copy_stream_until(
        &video_reader,
        &writer,
        0,
        MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32,
        &mut video_time,
        fallback,
        end_hns,
        &mut origin,
    )?;
    drop(video_reader);

    if copy_audio {
        let audio_reader = open_reader(input)?;
        seek_reader(&audio_reader, start_hns)?;
        copy_stream_until(
            &audio_reader,
            &writer,
            1,
            MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32,
            &mut audio_time,
            10_000_000 / 48,
            end_hns,
            &mut origin,
        )?;
    }

    if video_time <= 0 {
        return Err("That range did not include any video.".into());
    }

    unsafe {
        writer
            .Finalize()
            .map_err(|err| format!("Could not finish the trimmed clip: {err}"))?;
    }
    tracing::info!(
        "trimmed {} -> {} ({} ms) in {} ms",
        input.display(),
        output.display(),
        video_time / 10_000,
        started.elapsed().as_millis()
    );
    Ok(video_time / 10_000)
}

fn seek_reader(reader: &IMFSourceReader, position_hns: i64) -> Result<(), String> {
    unsafe {
        let position = PROPVARIANT::from(position_hns.max(0));
        reader
            .SetCurrentPosition(&GUID::zeroed(), &position)
            .map_err(|err| format!("Could not seek the clip: {err}"))?;
    }
    Ok(())
}

fn open_reader(path: &Path) -> Result<IMFSourceReader, String> {
    let wide = wide_path(path);
    unsafe {
        let mut attrs = None;
        MFCreateAttributes(&mut attrs, 4).map_err(|err| err.to_string())?;
        let attrs = attrs.ok_or_else(|| "Could not create reader attributes.".to_string())?;
        let _ = attrs.SetUINT32(&MF_READWRITE_DISABLE_CONVERTERS, 1);
        let _ = attrs.SetUINT32(&MF_LOW_LATENCY, 1);
        let reader = MFCreateSourceReaderFromURL(PCWSTR(wide.as_ptr()), Some(&attrs))
            .map_err(|err| format!("Could not open {}: {err}", path.display()))?;
        let _ = reader.SetStreamSelection(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32, true);
        let _ = reader.SetStreamSelection(MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32, true);
        Ok(reader)
    }
}

fn native_type(reader: &IMFSourceReader, stream: u32) -> Option<IMFMediaType> {
    unsafe { reader.GetNativeMediaType(stream, 0).ok() }
}

fn frame_duration_hns(media_type: &IMFMediaType) -> i64 {
    let packed = unsafe {
        media_type
            .GetUINT64(&MF_MT_FRAME_RATE)
            .unwrap_or((60 << 32) | 1)
    };
    let num = (packed >> 32) as i64;
    let den = (packed as u32) as i64;
    if num <= 0 || den <= 0 {
        166_667
    } else {
        (10_000_000 * den / num).max(10_000)
    }
}

fn copy_stream(
    reader: &IMFSourceReader,
    writer: &IMFSinkWriter,
    writer_stream: u32,
    reader_stream: u32,
    timeline: &mut i64,
    fallback_duration: i64,
    budget: Option<i64>,
) -> Result<(), String> {
    let limit = budget.map(|added| *timeline + added.max(0));
    let mut previous_ts: Option<i64> = None;
    loop {
        if let Some(end) = limit {
            if *timeline >= end {
                break;
            }
        }
        let mut flags = 0_u32;
        let mut timestamp = 0_i64;
        let mut sample: Option<IMFSample> = None;
        unsafe {
            reader
                .ReadSample(
                    reader_stream,
                    0,
                    None,
                    Some(&mut flags),
                    Some(&mut timestamp),
                    Some(&mut sample),
                )
                .map_err(|err| format!("Could not read a replay sample: {err}"))?;
        }
        if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
            break;
        }
        let Some(sample) = sample else {
            continue;
        };
        let from_sample = unsafe { sample.GetSampleDuration().unwrap_or(0) };
        let from_delta = previous_ts
            .map(|previous| timestamp.saturating_sub(previous))
            .unwrap_or(0);
        previous_ts = Some(timestamp);
        let duration = if from_sample >= 10_000 {
            from_sample
        } else if from_delta >= 10_000 {
            from_delta
        } else {
            fallback_duration
        };
        unsafe {
            sample
                .SetSampleTime(*timeline)
                .map_err(|err| err.to_string())?;
            sample
                .SetSampleDuration(duration)
                .map_err(|err| err.to_string())?;
            writer
                .WriteSample(writer_stream, &sample)
                .map_err(|err| format!("Could not copy a replay sample: {err}"))?;
        }
        *timeline += duration;
    }
    Ok(())
}

/// Copy compressed samples while preserving source PTS gaps (webcam path).
fn copy_stream_preserve(
    reader: &IMFSourceReader,
    writer: &IMFSinkWriter,
    writer_stream: u32,
    reader_stream: u32,
    timeline: &mut i64,
    fallback_duration: i64,
) -> Result<(), String> {
    let file_start = *timeline;
    let mut origin: Option<i64> = None;
    loop {
        let mut flags = 0_u32;
        let mut timestamp = 0_i64;
        let mut sample: Option<IMFSample> = None;
        unsafe {
            reader
                .ReadSample(
                    reader_stream,
                    0,
                    None,
                    Some(&mut flags),
                    Some(&mut timestamp),
                    Some(&mut sample),
                )
                .map_err(|err| format!("Could not read a replay sample: {err}"))?;
        }
        if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
            break;
        }
        let Some(sample) = sample else {
            continue;
        };
        let base = *origin.get_or_insert(timestamp);
        let out_time = file_start
            .saturating_add(timestamp.saturating_sub(base))
            .max(*timeline);
        let from_sample = unsafe { sample.GetSampleDuration().unwrap_or(0) };
        let duration = if from_sample >= 10_000 {
            from_sample
        } else {
            fallback_duration
        };
        unsafe {
            sample
                .SetSampleTime(out_time)
                .map_err(|err| err.to_string())?;
            sample
                .SetSampleDuration(duration)
                .map_err(|err| err.to_string())?;
            writer
                .WriteSample(writer_stream, &sample)
                .map_err(|err| format!("Could not copy a replay sample: {err}"))?;
        }
        *timeline = out_time.saturating_add(duration);
    }
    Ok(())
}

fn copy_stream_until(
    reader: &IMFSourceReader,
    writer: &IMFSinkWriter,
    writer_stream: u32,
    reader_stream: u32,
    timeline: &mut i64,
    fallback_duration: i64,
    end_hns: i64,
    origin: &mut Option<i64>,
) -> Result<(), String> {
    let mut previous_ts: Option<i64> = None;
    loop {
        let mut flags = 0_u32;
        let mut timestamp = 0_i64;
        let mut sample: Option<IMFSample> = None;
        unsafe {
            reader
                .ReadSample(
                    reader_stream,
                    0,
                    None,
                    Some(&mut flags),
                    Some(&mut timestamp),
                    Some(&mut sample),
                )
                .map_err(|err| format!("Could not read a clip sample: {err}"))?;
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
        let from_delta = previous_ts
            .map(|previous| timestamp.saturating_sub(previous))
            .unwrap_or(0);
        previous_ts = Some(timestamp);
        let duration = if from_sample >= 10_000 {
            from_sample
        } else if from_delta >= 10_000 {
            from_delta
        } else {
            fallback_duration
        };
        let base = *origin.get_or_insert(timestamp);
        let out_time = timestamp.saturating_sub(base);
        if out_time < 0 {
            continue;
        }
        unsafe {
            sample
                .SetSampleTime(out_time)
                .map_err(|err| err.to_string())?;
            sample
                .SetSampleDuration(duration)
                .map_err(|err| err.to_string())?;
            writer
                .WriteSample(writer_stream, &sample)
                .map_err(|err| format!("Could not copy a clip sample: {err}"))?;
        }
        *timeline = out_time + duration;
    }
    Ok(())
}
