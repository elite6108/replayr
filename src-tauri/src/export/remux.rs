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
    append_pcm_file, fit_pcm_file, fit_pcm_to_video, hns_to_pcm_bytes, load_segment_pcm,
    pcm_bytes_to_ms, write_stitched_aac,
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
                "session remux overlap; gameplay preserves the incoming keyframe and bounds the previous tail"
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
            hold_hns = copied.hold_hns,
            "session remux join"
        );
        if let Some(pcm_file) = pcm_file.as_mut() {
            let (mut chunk, _) = load_segment_pcm(&segment.path);
            let drift = place_session_pcm(
                pcm_file,
                &mut pcm_len,
                &mut chunk,
                plan.session_offset_hns,
                copied.file_duration_hns,
                video_time,
            )?;
            if drift.abs() > hns_to_pcm_bytes(200_000) as i64 {
                tracing::warn!(
                    "segment {} audio was {} ms off its video",
                    segment.path.display(),
                    pcm_bytes_to_ms(drift)
                );
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

#[cfg(test)]
mod ir_boundary_tests {
    use super::*;

    #[test]
    fn gameplay_rounding_shortens_tail_without_moving_next_start() {
        assert_eq!(
            gameplay_tail_duration(20_000_000, 166_667, 20_166_586).unwrap(),
            166_586
        );
        assert_eq!(
            gameplay_tail_duration(20_000_000, 166_667, 20_165_586).unwrap(),
            165_586
        );
        assert_eq!(
            gameplay_tail_duration(20_000_000, 166_667, 21_000_000).unwrap(),
            166_667
        );
    }

    #[test]
    fn gameplay_frame_overlaps_fail_instead_of_discarding_references() {
        assert!(gameplay_tail_duration(20_000_000, 166_667, 20_000_000).is_err());
        assert!(gameplay_tail_duration(20_000_000, 166_667, 19_999_000).is_err());
        assert!(gameplay_tail_duration(20_000_000, 166_667, 20_000_001).is_err());
    }

    #[test]
    fn pcm_holds_follow_audio_and_next_head_is_not_trimmed() {
        let mut file = tempfile::tempfile().unwrap();
        let mut len = 0;
        let mut first = vec![1; hns_to_pcm_bytes(20_000_000)];
        place_session_pcm(&mut file, &mut len, &mut first, 0, 19_999_000, 21_000_000).unwrap();
        let mut second = vec![2; hns_to_pcm_bytes(20_000_000)];
        place_session_pcm(
            &mut file,
            &mut len,
            &mut second,
            21_000_000,
            20_000_000,
            41_000_000,
        )
        .unwrap();
        file.seek(SeekFrom::Start(0)).unwrap();
        let mut actual = Vec::new();
        std::io::Read::read_to_end(&mut file, &mut actual).unwrap();
        let first_end = hns_to_pcm_bytes(19_999_000);
        let second_start = hns_to_pcm_bytes(21_000_000);
        assert!(actual[..first_end].iter().all(|b| *b == 1));
        assert!(actual[first_end..second_start].iter().all(|b| *b == 0));
        assert_eq!(&actual[second_start..], second.as_slice());
        assert_eq!(len as usize, hns_to_pcm_bytes(41_000_000));
    }

    #[test]
    fn pcm_fractional_boundaries_do_not_accumulate_drift() {
        let mut file = tempfile::tempfile().unwrap();
        let mut len = 0;
        for index in 0..150 {
            let start = index * 19_999_920;
            let end = start + 19_999_920;
            let mut chunk = vec![1; hns_to_pcm_bytes(20_000_000)];
            place_session_pcm(&mut file, &mut len, &mut chunk, start, 19_999_920, end).unwrap();
            assert_eq!(len as usize, hns_to_pcm_bytes(end));
        }
    }

    #[test]
    #[ignore = "requires Windows Media Foundation; generates synthetic frames only"]
    fn ir_remux_keeps_new_idr_with_natural_60fps_rounding_and_negative_overlap() {
        use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED).ok().unwrap();
        }
        let temp = tempfile::tempdir().unwrap();
        let mut segments = Vec::new();
        let mut expected = Vec::new();
        let mut last_capture = None;
        let mut global = 0;
        for (index, count) in [121, 120].into_iter().enumerate() {
            let path = temp.path().join(format!("segment-{index}.mp4"));
            let mut encoder = crate::encode::MfWriter::create(
                &path,
                320,
                180,
                60,
                4_000_000,
                false,
                None,
                true,
                crate::encode::VideoInput::Bgra,
                false,
            )
            .unwrap();
            encoder.set_last_capture_hns(last_capture);
            for frame in 0..count {
                global += 1;
                let pixels = vec![(global % 255) as u8; 320 * 180 * 4];
                encoder
                    .write_bgra(
                        &pixels,
                        320 * 4,
                        320,
                        180,
                        global * 166_666,
                        frame + 1 == count,
                    )
                    .unwrap();
            }
            let duration = encoder.timestamp();
            last_capture = encoder.last_capture_hns();
            encoder.finish().unwrap();
            let samples = video_samples(&path);
            assert!(samples[0].is_sync);
            expected.extend(samples.into_iter().map(|sample| sample.bytes));
            let end = last_capture.unwrap();
            segments.push(ConcatSegment {
                path,
                start_hns: crate::capture_timing::segment_start_hns(end, duration),
                end_hns: end,
            });
        }
        for overlap in [0, 1_000] {
            let mut placed = segments.clone();
            placed[1].start_hns -= overlap;
            placed[1].end_hns -= overlap;
            let output = temp.path().join(format!("overlap-{overlap}.mp4"));
            concat_mp4s(&placed, &output, 0).unwrap();
            let actual = video_samples(&output);
            assert_eq!(
                actual.len(),
                241,
                "lost compressed frame with {overlap} hns overlap"
            );
            assert!(actual[121].is_sync, "new encoder IDR was removed");
            for (sample, bytes) in actual.iter().zip(&expected) {
                assert_eq!(&sample.bytes, bytes);
            }
            assert!(actual.windows(2).all(|w| w[0].start_time < w[1].start_time));
        }
        // Exercise the real mux for five minutes, not only the placement math.
        let mut repeated = Vec::new();
        let mut end = 0;
        for index in 0..150 {
            let source = &segments[index % 2];
            let duration = source.end_hns - source.start_hns;
            repeated.push(ConcatSegment {
                path: source.path.clone(),
                start_hns: end,
                end_hns: end + duration,
            });
            end += duration;
        }
        let long_output = temp.path().join("five-minutes.mp4");
        concat_mp4s(&repeated, &long_output, 0).unwrap();
        let long_samples = video_samples(&long_output);
        assert_eq!(long_samples.len(), 241 * 75);
        for (index, sample) in long_samples.iter().enumerate() {
            assert_eq!(sample.bytes, expected[index % 241]);
        }
        assert!(long_samples
            .windows(2)
            .all(|w| w[0].start_time < w[1].start_time));
        let file = std::fs::File::open(&long_output).unwrap();
        let size = file.metadata().unwrap().len();
        let reader = mp4::Mp4Reader::read_header(std::io::BufReader::new(file), size).unwrap();
        let timescale = reader
            .tracks()
            .values()
            .find(|track| track.track_type().ok() == Some(mp4::TrackType::Video))
            .unwrap()
            .timescale();
        let last = long_samples.last().unwrap();
        let actual_end = ((last.start_time + u64::from(last.duration)) * 10_000_000
            / u64::from(timescale)) as i64;
        assert!(
            (actual_end - end).abs() < 1_000,
            "session drift: {} hns",
            actual_end - end
        );
        segments[1].start_hns -= 1_000_000;
        assert!(concat_mp4s(&segments, &temp.path().join("unsafe-overlap.mp4"), 0).is_err());
        assert!(segments.iter().all(|segment| segment.path.is_file()));
    }

    fn video_samples(path: &Path) -> Vec<mp4::Mp4Sample> {
        let file = std::fs::File::open(path).unwrap();
        let size = file.metadata().unwrap().len();
        let mut reader = mp4::Mp4Reader::read_header(std::io::BufReader::new(file), size).unwrap();
        let id = *reader
            .tracks()
            .iter()
            .find(|(_, track)| track.track_type().ok() == Some(mp4::TrackType::Video))
            .unwrap()
            .0;
        (1..=reader.sample_count(id).unwrap())
            .map(|index| reader.read_sample(id, index).unwrap().unwrap())
            .collect()
    }

    #[test]
    #[ignore = "requires Windows Media Foundation; generates synthetic frames only"]
    fn ir_remux_preserves_every_compressed_sample_across_fractional_boundaries() {
        use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED).ok().unwrap();
        }
        let temp = tempfile::tempdir().unwrap();
        let mut segments = Vec::new();
        let mut expected = Vec::new();
        let mut last_capture = None;
        let mut capture_hns = 1_000_000_i64;
        for index in 0..3 {
            let path = temp.path().join(format!("segment-{index}.mp4"));
            let mut encoder = crate::encode::MfWriter::create(
                &path,
                320,
                180,
                60,
                4_000_000,
                false,
                None,
                true,
                crate::encode::VideoInput::Bgra,
                false,
            )
            .unwrap();
            encoder.set_last_capture_hns(last_capture);
            for frame in 0..45 {
                capture_hns += 166_667 + (index * 113 + frame % 3) as i64;
                let pixels = vec![(frame * 5 + index) as u8; 320 * 180 * 4];
                encoder
                    .write_bgra(&pixels, 320 * 4, 320, 180, capture_hns, false)
                    .unwrap();
            }
            let duration = encoder.timestamp();
            last_capture = encoder.last_capture_hns();
            encoder.finish().unwrap();
            let samples = video_samples(&path);
            assert!(
                samples[0].is_sync,
                "segment must begin with an independent sample"
            );
            expected.extend(samples.into_iter().map(|sample| sample.bytes));
            segments.push(ConcatSegment {
                path,
                start_hns: crate::capture_timing::segment_start_hns(capture_hns, duration),
                end_hns: capture_hns,
            });
        }
        let output = temp.path().join("clip.mp4");
        concat_mp4s(&segments, &output, segments[0].start_hns).unwrap();
        let actual = video_samples(&output);
        assert_eq!(
            actual.len(),
            expected.len(),
            "remux lost a compressed frame"
        );
        for (sample, bytes) in actual.iter().zip(expected) {
            assert_eq!(sample.bytes, bytes, "remux changed compressed video");
        }
        // Compare the former placement too. Encoder/mux timestamp rounding can
        // mask the false-overlap risk; do not claim this proves an incident's
        // cause if the old path also retains every sample on this machine.
        let rounded: Vec<_> = segments
            .iter()
            .map(|segment| ConcatSegment {
                path: segment.path.clone(),
                start_hns: segment.end_hns
                    - (segment.end_hns - segment.start_hns) / 10_000 * 10_000,
                end_hns: segment.end_hns,
            })
            .collect();
        let old_output = temp.path().join("rounded-negative-control.mp4");
        concat_mp4s(&rounded, &old_output, rounded[0].start_hns).unwrap();
        let old_count = video_samples(&old_output).len();
        println!(
            "exact timing retained {} samples; old rounded timing retained {old_count}",
            actual.len()
        );
    }
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

/// Keep the incoming encoder's IDR and all its dependent samples. MF's MP4
/// timescale can round the previous segment's end past the capture boundary.
/// Shorten only that final sample's presentation duration, never an H.264 head.
fn gameplay_tail_duration(pts: i64, duration: i64, next: i64) -> Result<i64, String> {
    let remaining = next.saturating_sub(pts);
    if remaining < duration && remaining < 10_000 {
        return Err("Replay segments overlap by a frame or more; refusing to discard compressed video. Replay source segments have not been changed.".into());
    }
    Ok(duration.min(remaining))
}

/// Use absolute session positions so sub-sample rounding cannot accumulate.
/// Any hold silence follows this segment's audio, not its beginning. A shortened
/// video tail shortens the matching audio tail; the next audio head stays intact.
fn place_session_pcm(
    file: &mut std::fs::File,
    len: &mut u64,
    chunk: &mut Vec<u8>,
    start: i64,
    duration: i64,
    end_with_hold: i64,
) -> Result<i64, String> {
    fit_pcm_file(file, len, start)?;
    file.seek(SeekFrom::Start(*len))
        .map_err(|err| err.to_string())?;
    let drift = fit_pcm_to_video(chunk, duration);
    append_pcm_file(file, len, chunk)?;
    fit_pcm_file(file, len, end_with_hold)?;
    Ok(drift)
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
        if let Some(next) = hold_until {
            // This path is gameplay only. An overlap reaching an actual sample
            // cannot be repaired by dropping the next encoder's reference frame.
            gameplay_tail_duration(out_time, duration, next)?;
        }
        if let Some(limit) = max_output_pts {
            match clip_sample_keep(out_time, limit) {
                ClipSampleKeep::DropBefore => continue,
                ClipSampleKeep::DropAfter => break,
                ClipSampleKeep::Keep => {}
            }
        }
        if out_time < min_output_pts {
            if max_output_pts.is_none() {
                return Err("Replay segment starts before the written timeline; refusing to drop its keyframe.".into());
            }
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
    if max_output_pts.is_none() && pending.is_none() {
        return Err("Replay segment contains no retained video.".into());
    }
    if let (Some(last), Some(next)) = (pending.as_mut(), hold_until) {
        let bounded = gameplay_tail_duration(last.out_pts, last.duration, next)?;
        if bounded != last.duration {
            tracing::info!(
                corrected_hns = last.duration - bounded,
                next_segment_pts = next,
                "bounded gameplay tail duration; incoming keyframe preserved"
            );
            last.duration = bounded;
        }
    }
    let hold = pending
        .as_ref()
        .and_then(|last| {
            hold_until.map(|until| hold_hns(last.out_pts.saturating_add(last.duration), until))
        })
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
