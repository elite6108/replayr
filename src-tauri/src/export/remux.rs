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
    append_pcm_file, append_silence_file, fit_pcm_file, fit_pcm_to_video, hns_to_pcm_bytes,
    load_segment_pcm, pcm_bytes_to_ms, write_stitched_aac,
};
use super::session_place::{
    clip_sample_keep, hold_hns, output_pts, placement_error_hns, plan_joins, ClipSampleKeep,
    SessionSegment,
};
use super::writer::{open_writer, wide_path, WriterAudio, MF_READWRITE_DISABLE_CONVERTERS};

/// One Instant Replay or webcam file plus its session bounds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConcatSegment {
    pub path: PathBuf,
    pub start_hns: i64,
    pub end_hns: i64,
}

#[derive(Clone, Copy)]
enum GapPolicy {
    /// Gameplay: extend the last video sample through a session hole.
    HoldVideo,
    /// Webcam: leave the PTS hole so follow holds the last overlay frame.
    LeaveHole,
}

const MF_LOW_LATENCY: GUID = GUID::from_u128(0x9c27891a_ed7a_40e1_88e8_b22727a024ee);

struct RemovePath(PathBuf);

impl Drop for RemovePath {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

pub fn concat_mp4s(
    segments: &[ConcatSegment],
    output: &Path,
    window_start_hns: i64,
) -> Result<(), String> {
    concat_session(
        segments,
        output,
        window_start_hns,
        None,
        GapPolicy::HoldVideo,
        "gameplay",
    )
}

/// Webcam sidecar concat. Clip t=0 is `window_start_hns`, never the first
/// webcam sample. Samples before the window are dropped; samples at/after
/// `window_end_hns` are dropped. Leading gaps stay in the file PTS.
pub fn concat_mp4s_preserve_timeline(
    segments: &[ConcatSegment],
    output: &Path,
    window_start_hns: i64,
    window_end_hns: i64,
) -> Result<(), String> {
    let duration = (window_end_hns - window_start_hns).max(0);
    concat_session(
        segments,
        output,
        window_start_hns,
        Some(duration),
        GapPolicy::LeaveHole,
        "webcam",
    )
}

fn concat_session(
    segments: &[ConcatSegment],
    output: &Path,
    origin_hns: i64,
    max_output_pts: Option<i64>,
    gaps: GapPolicy,
    stream: &'static str,
) -> Result<(), String> {
    if segments.is_empty() {
        return Err("Replay buffer is empty.".into());
    }
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let started = Instant::now();
    unsafe {
        MFStartup(MF_VERSION, MFSTARTUP_FULL).map_err(|err| err.to_string())?;
    }

    let first = open_reader(&segments[0].path)?;
    let video_type = native_type(&first, MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32)
        .ok_or_else(|| "Replay segment has no video.".to_string())?;
    let has_mp4_audio = native_type(&first, MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32).is_some();
    drop(first);
    let has_audio = matches!(gaps, GapPolicy::HoldVideo)
        && (has_mp4_audio
            || segments
                .iter()
                .any(|segment| crate::encode::pcm_sidecar_path(&segment.path).is_file()));

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
    let mut logged_first_retained = false;
    let plans = plan_joins(
        &segments
            .iter()
            .map(|segment| SessionSegment {
                start_hns: segment.start_hns,
                end_hns: segment.end_hns,
            })
            .collect::<Vec<_>>(),
        origin_hns,
    );

    for (index, (segment, plan)) in segments.iter().zip(plans.iter()).enumerate() {
        let next_offset = plans.get(index + 1).map(|next| next.session_offset_hns);
        if plan.overlap_hns > 0 {
            tracing::warn!(
                stream,
                segment_index = plan.segment_index,
                overlap_hns = plan.overlap_hns,
                "session remux overlap; dropping prefix so the timeline does not double"
            );
        }
        let min_output_pts = match gaps {
            GapPolicy::LeaveHole => 0,
            GapPolicy::HoldVideo => video_time,
        };
        let hold_until = match (gaps, next_offset) {
            (GapPolicy::HoldVideo, Some(next)) => Some(next),
            _ => None,
        };
        let reader = open_reader(&segment.path)?;
        let copied = copy_stream_session(
            &reader,
            &writer,
            0,
            MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32,
            plan.session_offset_hns,
            min_output_pts,
            max_output_pts,
            hold_until,
            &mut video_time,
            fallback,
        )?;
        drop(reader);
        let expected = output_pts(segment.start_hns, origin_hns, copied.source_first_pts);
        if stream == "webcam" && !logged_first_retained && copied.output_first_pts >= 0 {
            logged_first_retained = true;
            tracing::info!(
                stream,
                source_pts = copied.source_first_pts,
                expected_output_pts = expected,
                actual_output_pts = copied.output_first_pts,
                "first retained webcam sample"
            );
        }
        tracing::info!(
            stream,
            segment_index = plan.segment_index,
            segment_start_hns = plan.segment_start_hns,
            segment_end_hns = plan.segment_end_hns,
            session_offset_hns = plan.session_offset_hns,
            source_first_pts = copied.source_first_pts,
            source_last_pts = copied.source_last_pts,
            output_first_pts = copied.output_first_pts,
            expected_output_first_pts = expected,
            placement_error_hns = placement_error_hns(copied.output_first_pts, expected),
            gap_from_previous_hns = plan.gap_from_previous_hns,
            "session remux join"
        );
        if let Some(pcm_file) = pcm_file.as_mut() {
            if plan.gap_from_previous_hns > 0 || copied.hold_hns > 0 {
                let silence = plan.gap_from_previous_hns.max(copied.hold_hns);
                append_silence_file(pcm_file, &mut pcm_len, silence)?;
            }
            let (mut chunk, from_sidecar) = load_segment_pcm(&segment.path);
            if plan.overlap_hns > 0 {
                let skip = hns_to_pcm_bytes(plan.overlap_hns).min(chunk.len());
                chunk.drain(..skip);
            }
            if from_sidecar {
                let drift = fit_pcm_to_video(&mut chunk, copied.file_duration_hns);
                if drift.abs() > hns_to_pcm_bytes(200_000) as i64 {
                    tracing::warn!(
                        "segment {} audio was {} ms off its video",
                        segment.path.display(),
                        pcm_bytes_to_ms(drift)
                    );
                }
            } else if chunk.is_empty() {
                chunk = vec![0u8; hns_to_pcm_bytes(copied.file_duration_hns)];
            }
            append_pcm_file(pcm_file, &mut pcm_len, &chunk)?;
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
        stream,
        segments = segments.len(),
        origin_hns,
        video_time,
        "session-placed remux finished in {} ms -> {}",
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

struct SessionCopy {
    source_first_pts: i64,
    source_last_pts: i64,
    output_first_pts: i64,
    file_duration_hns: i64,
    hold_hns: i64,
}

struct PendingSample {
    sample: IMFSample,
    out_pts: i64,
    duration: i64,
}

fn copy_stream_session(
    reader: &IMFSourceReader,
    writer: &IMFSinkWriter,
    writer_stream: u32,
    reader_stream: u32,
    segment_offset: i64,
    min_output_pts: i64,
    max_output_pts: Option<i64>,
    hold_until: Option<i64>,
    timeline: &mut i64,
    fallback_duration: i64,
) -> Result<SessionCopy, String> {
    let mut previous_ts: Option<i64> = None;
    let mut pending: Option<PendingSample> = None;
    let mut source_first_pts = 0_i64;
    let mut source_last_pts = 0_i64;
    let mut output_first_pts = -1_i64;
    let mut file_end_pts = segment_offset;
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
        let out_time = segment_offset.saturating_add(timestamp.max(0));
        if let Some(limit) = max_output_pts {
            match clip_sample_keep(out_time, limit) {
                ClipSampleKeep::DropBefore => continue,
                ClipSampleKeep::DropAfter => break,
                ClipSampleKeep::Keep => {}
            }
        }
        if out_time < min_output_pts {
            continue;
        }
        if let Some(previous) = pending.take() {
            write_pending(writer, writer_stream, previous, 0, timeline)?;
        } else {
            source_first_pts = timestamp.max(0);
            output_first_pts = out_time;
        }
        source_last_pts = timestamp.max(0);
        file_end_pts = out_time.saturating_add(duration);
        pending = Some(PendingSample {
            sample,
            out_pts: out_time,
            duration,
        });
    }
    let hold = pending
        .as_ref()
        .and_then(|last| hold_until.map(|until| hold_hns(last.out_pts.saturating_add(last.duration), until)))
        .unwrap_or(0);
    if let Some(last) = pending.take() {
        file_end_pts = last.out_pts.saturating_add(last.duration);
        write_pending(writer, writer_stream, last, hold, timeline)?;
    }
    Ok(SessionCopy {
        source_first_pts,
        source_last_pts,
        output_first_pts,
        file_duration_hns: file_end_pts.saturating_sub(segment_offset).max(0),
        hold_hns: hold,
    })
}

fn write_pending(
    writer: &IMFSinkWriter,
    writer_stream: u32,
    pending: PendingSample,
    hold_extra: i64,
    timeline: &mut i64,
) -> Result<(), String> {
    let duration = pending.duration.saturating_add(hold_extra.max(0));
    unsafe {
        pending
            .sample
            .SetSampleTime(pending.out_pts)
            .map_err(|err| err.to_string())?;
        pending
            .sample
            .SetSampleDuration(duration)
            .map_err(|err| err.to_string())?;
        writer
            .WriteSample(writer_stream, &pending.sample)
            .map_err(|err| format!("Could not copy a replay sample: {err}"))?;
    }
    *timeline = pending.out_pts.saturating_add(duration);
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
