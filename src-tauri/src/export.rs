use std::path::{Path, PathBuf};
use std::time::Instant;
use tauri::Manager;

use windows::core::{GUID, PCWSTR};
use windows::Win32::Media::MediaFoundation::{
    IMFMediaType, IMFSample, IMFSinkWriter, IMFSourceReader, MFCreateAttributes, MFCreateMediaType,
    MFCreateMemoryBuffer, MFCreateSample, MFCreateSinkWriterFromURL, MFCreateSourceReaderFromURL, MFStartup,
    MFAudioFormat_AAC, MFAudioFormat_PCM, MFMediaType_Audio, MF_MT_AAC_AUDIO_PROFILE_LEVEL_INDICATION,
    MF_MT_AAC_PAYLOAD_TYPE, MF_MT_AUDIO_AVG_BYTES_PER_SECOND, MF_MT_AUDIO_BITS_PER_SAMPLE,
    MF_MT_AUDIO_BLOCK_ALIGNMENT, MF_MT_AUDIO_NUM_CHANNELS, MF_MT_AUDIO_SAMPLES_PER_SECOND, MF_MT_AVG_BITRATE,
    MF_MT_FRAME_RATE, MF_MT_MAJOR_TYPE, MF_MT_SUBTYPE, MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS,
    MF_SINK_WRITER_DISABLE_THROTTLING, MF_SOURCE_READERF_ENDOFSTREAM, MF_SOURCE_READER_FIRST_AUDIO_STREAM,
    MF_SOURCE_READER_FIRST_VIDEO_STREAM, MFSTARTUP_FULL, MF_VERSION,
};
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;

/// Pass encoded samples through. Video remux stays converter-free. Audio joins are decoded to PCM.
const MF_READWRITE_DISABLE_CONVERTERS: GUID = GUID::from_u128(0x98d5b065_1374_4847_8d5d_31520fee7156);
const MF_LOW_LATENCY: GUID = GUID::from_u128(0x9c27891a_ed7a_40e1_88e8_b22727a024ee);
const PCM_RATE: u32 = 48_000;
const PCM_CHANNELS: u32 = 2;
const PCM_ALIGN: usize = 4;
const PCM_BYTES_PER_SEC: u32 = PCM_RATE * PCM_ALIGN as u32;
const AAC_CHUNK_BYTES: usize = 1024 * PCM_ALIGN;
const JOIN_FADE_BYTES: usize = (PCM_RATE as usize * PCM_ALIGN * 10) / 1000;

fn wide_path(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
}

pub fn concat_mp4s(inputs: &[PathBuf], output: &Path) -> Result<(), String> {
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

    let writer = open_writer(output, &video_type, if has_audio { WriterAudio::StitchedAac } else { WriterAudio::None })?;
    let fallback = frame_duration_hns(&video_type);
    let mut video_time = 0_i64;
    let mut pcm = Vec::new();

    for path in inputs {
        let reader = open_reader(path)?;
        let video_before = video_time;
        copy_stream(
            &reader,
            &writer,
            0,
            MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32,
            &mut video_time,
            fallback,
            None,
        )?;
        drop(reader);
        if has_audio {
            let video_added = video_time.saturating_sub(video_before);
            let (mut chunk, from_sidecar) = load_segment_pcm(path);
            if from_sidecar {
                // Each sidecar already runs at 1x for exactly its own segment,
                // so pinning it to that segment's video length keeps every later
                // segment at its true offset. Correcting only the total would
                // let a short segment shift everything after it.
                let drift = fit_pcm_to_video(&mut chunk, video_added);
                if drift.abs() > hns_to_pcm_bytes(200_000) as i64 {
                    tracing::warn!(
                        "segment {} audio was {} ms off its video",
                        path.display(),
                        pcm_bytes_to_ms(drift)
                    );
                }
                append_pcm(&mut pcm, &chunk);
            } else {
                if chunk.is_empty() {
                    chunk = vec![0u8; hns_to_pcm_bytes(video_added)];
                }
                append_crossfade(&mut pcm, &chunk);
            }
        }
    }

    if has_audio {
        fit_pcm_to_video(&mut pcm, video_time);
        write_stitched_aac(&writer, 1, &pcm)?;
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

const SHORT_WIDTH: u32 = 1080;
const SHORT_HEIGHT: u32 = 1920;
const SHORT_BITRATE: u32 = 15_000_000;

/// Re-encodes `start_hns..end_hns` as 1080×1920 9:16. `pan` 0 is left, 1 is right.
pub fn write_vertical_mp4(
    input: &Path,
    output: &Path,
    start_hns: i64,
    end_hns: i64,
    pan: f32,
    fps: u32,
) -> Result<i64, String> {
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

    let pcm = decode_audio_range(input, start_hns, end_hns).unwrap_or_default();
    let has_audio = !pcm.is_empty();
    let mut writer = crate::encode::MfWriter::new(
        output,
        SHORT_WIDTH,
        SHORT_HEIGHT,
        fps,
        SHORT_BITRATE,
        has_audio,
        None,
    )?;

    let reader = crate::thumb::open_rgb_reader(input)?;
    if start_hns > 0 {
        crate::thumb::seek_hns(&reader, start_hns)?;
    }
    let mut origin: Option<i64> = None;
    let mut clock = 0_i64;
    let mut frames = 0_u32;
    loop {
        let Some((frame, timestamp, duration)) = crate::thumb::read_rgb_sample(&reader)? else {
            break;
        };
        if timestamp >= end_hns && origin.is_some() {
            break;
        }
        let base = *origin.get_or_insert(timestamp);
        if timestamp >= end_hns {
            break;
        }
        let from_source = (timestamp - base).max(0);
        let capture_hns = if from_source > clock { from_source } else { clock };
        let vertical = crate::still::crop_and_scale_9x16(&frame, pan, SHORT_WIDTH, SHORT_HEIGHT);
        writer.write_bgra(
            &vertical.bgra,
            vertical.pitch,
            vertical.width,
            vertical.height,
            capture_hns,
            frames == 0,
        )?;
        clock = capture_hns + duration;
        frames += 1;
    }
    drop(reader);

    if frames == 0 {
        return Err("That range did not include any video.".into());
    }

    let video_hns = writer.timestamp();
    if has_audio {
        let mut audio = pcm;
        let _ = fit_pcm_to_video(&mut audio, video_hns);
        writer.write_pcm_closing(&audio)?;
    } else {
        let _ = writer.write_pcm_closing(&[]);
    }
    let written_ms = (writer.timestamp() / 10_000).max(0);
    writer.finish()?;
    tracing::info!(
        "short {} -> {} ({} ms, {} frames) in {} ms",
        input.display(),
        output.display(),
        written_ms,
        frames,
        started.elapsed().as_millis()
    );
    Ok(written_ms)
}

/// Re-encodes `input` with a Replayr.tv watermark. The source file is not modified.
pub fn write_watermarked_mp4(input: &Path, output: &Path, fps: u32) -> Result<i64, String> {
    if !input.exists() {
        return Err("That clip is no longer on disk.".into());
    }
    if input == output {
        return Err("Watermark output cannot replace the original file.".into());
    }
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    unsafe {
        MFStartup(MF_VERSION, MFSTARTUP_FULL).map_err(|err| err.to_string())?;
    }
    let pcm = decode_audio_pcm(input).unwrap_or_default();
    let has_audio = !pcm.is_empty();
    let reader = crate::thumb::open_rgb_reader(input)?;
    let Some((first, _, duration)) = crate::thumb::read_rgb_sample(&reader)? else {
        return Err("That clip has no video.".into());
    };
    let width = first.width.max(16);
    let height = first.height.max(16);
    let fps = fps.clamp(24, 60);
    let bitrate = ((width as u64 * height as u64 * u64::from(fps)) / 6).clamp(4_000_000, 25_000_000) as u32;
    let mut writer = crate::encode::MfWriter::new(output, width, height, fps, bitrate, has_audio, None)?;
    let mut frame = first;
    crate::still::composite_watermark(&mut frame);
    writer.write_bgra(&frame.bgra, frame.pitch, frame.width, frame.height, 0, true)?;
    let mut clock = duration.max(1);
    let mut frames = 1_u32;
    loop {
        let Some((mut next, _, next_duration)) = crate::thumb::read_rgb_sample(&reader)? else {
            break;
        };
        crate::still::composite_watermark(&mut next);
        writer.write_bgra(&next.bgra, next.pitch, next.width, next.height, clock, false)?;
        clock += next_duration.max(1);
        frames += 1;
    }
    drop(reader);
    if frames == 0 {
        return Err("That clip has no video.".into());
    }
    let video_hns = writer.timestamp();
    if has_audio {
        let mut audio = pcm;
        let _ = fit_pcm_to_video(&mut audio, video_hns);
        writer.write_pcm_closing(&audio)?;
    } else {
        let _ = writer.write_pcm_closing(&[]);
    }
    let written_ms = (writer.timestamp() / 10_000).max(0);
    writer.finish()?;
    tracing::info!(
        "watermarked {} -> {} ({} ms, {} frames)",
        input.display(),
        output.display(),
        written_ms,
        frames
    );
    Ok(written_ms)
}

fn decode_audio_range(path: &Path, start_hns: i64, end_hns: i64) -> Result<Vec<u8>, String> {
    let mut pcm = decode_audio_pcm(path)?;
    if start_hns <= 0 {
        skip_aac_encoder_delay(&mut pcm);
    }
    let start = hns_to_pcm_bytes(start_hns).min(pcm.len());
    let end = hns_to_pcm_bytes(end_hns).min(pcm.len()).max(start);
    Ok(pcm[start..end].to_vec())
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

enum WriterAudio {
    None,
    Copy(IMFMediaType),
    StitchedAac,
}

fn open_writer(path: &Path, video_type: &IMFMediaType, audio: WriterAudio) -> Result<IMFSinkWriter, String> {
    let wide = wide_path(path);
    unsafe {
        let mut attrs = None;
        MFCreateAttributes(&mut attrs, 4).map_err(|err| err.to_string())?;
        let attrs = attrs.ok_or_else(|| "Could not create writer attributes.".to_string())?;
        if !matches!(audio, WriterAudio::StitchedAac) {
            let _ = attrs.SetUINT32(&MF_READWRITE_DISABLE_CONVERTERS, 1);
        }
        // Video is a copy. Hardware AAC MFTs and low-latency mode click/cackle
        // through the whole clip on both game and mic.
        if !matches!(audio, WriterAudio::StitchedAac) {
            let _ = attrs.SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1);
        }
        let _ = attrs.SetUINT32(&MF_SINK_WRITER_DISABLE_THROTTLING, 1);
        let writer = MFCreateSinkWriterFromURL(PCWSTR(wide.as_ptr()), None, Some(&attrs))
            .map_err(|err| format!("Could not create the clip writer: {err}"))?;
        let video_stream = writer
            .AddStream(video_type)
            .map_err(|err| format!("Could not add the video stream: {err}"))?;
        writer
            .SetInputMediaType(video_stream, video_type, None)
            .map_err(|err| format!("Could not set the video copy type: {err}"))?;
        match audio {
            WriterAudio::None => {}
            WriterAudio::Copy(audio_type) => {
                let audio_stream = writer
                    .AddStream(&audio_type)
                    .map_err(|err| format!("Could not add the audio stream: {err}"))?;
                writer
                    .SetInputMediaType(audio_stream, &audio_type, None)
                    .map_err(|err| format!("Could not set the audio copy type: {err}"))?;
            }
            WriterAudio::StitchedAac => {
                let audio_out = aac_output_type()?;
                let audio_stream = writer
                    .AddStream(&audio_out)
                    .map_err(|err| format!("Could not add the AAC stream: {err}"))?;
                let audio_in = pcm_input_type()?;
                writer
                    .SetInputMediaType(audio_stream, &audio_in, None)
                    .map_err(|err| format!("Could not set the PCM input type: {err}"))?;
            }
        }
        writer
            .BeginWriting()
            .map_err(|err| format!("Could not begin writing the clip: {err}"))?;
        Ok(writer)
    }
}

fn aac_output_type() -> Result<IMFMediaType, String> {
    unsafe {
        let media_type = MFCreateMediaType().map_err(|err| err.to_string())?;
        media_type
            .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)
            .map_err(|err| err.to_string())?;
        media_type
            .SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_AAC)
            .map_err(|err| err.to_string())?;
        media_type
            .SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)
            .map_err(|err| err.to_string())?;
        media_type
            .SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, PCM_RATE)
            .map_err(|err| err.to_string())?;
        media_type
            .SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, PCM_CHANNELS)
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

fn pcm_input_type() -> Result<IMFMediaType, String> {
    unsafe {
        let media_type = MFCreateMediaType().map_err(|err| err.to_string())?;
        media_type
            .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)
            .map_err(|err| err.to_string())?;
        media_type
            .SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_PCM)
            .map_err(|err| err.to_string())?;
        media_type
            .SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)
            .map_err(|err| err.to_string())?;
        media_type
            .SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, PCM_RATE)
            .map_err(|err| err.to_string())?;
        media_type
            .SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, PCM_CHANNELS)
            .map_err(|err| err.to_string())?;
        media_type
            .SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, PCM_ALIGN as u32)
            .map_err(|err| err.to_string())?;
        media_type
            .SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, PCM_BYTES_PER_SEC)
            .map_err(|err| err.to_string())?;
        Ok(media_type)
    }
}

fn load_segment_pcm(path: &Path) -> (Vec<u8>, bool) {
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

fn decode_audio_pcm(path: &Path) -> Result<Vec<u8>, String> {
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
            .SetCurrentMediaType(MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32, None, &pcm_type)
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

fn append_pcm(dest: &mut Vec<u8>, next: &[u8]) {
    let next_len = next.len() - (next.len() % PCM_ALIGN);
    dest.extend_from_slice(&next[..next_len]);
}

fn append_crossfade(dest: &mut Vec<u8>, next: &[u8]) {
    let next_len = next.len() - (next.len() % PCM_ALIGN);
    if dest.is_empty() || next_len == 0 {
        dest.extend_from_slice(&next[..next_len]);
        return;
    }
    let fade = JOIN_FADE_BYTES
        .min(dest.len())
        .min(next_len);
    let fade = fade - (fade % PCM_ALIGN);
    if fade == 0 {
        dest.extend_from_slice(&next[..next_len]);
        return;
    }
    let dest_at = dest.len() - fade;
    let frames = fade / PCM_ALIGN;
    for index in 0..frames {
        let t = (index + 1) as f32 / (frames + 1) as f32;
        for channel in 0..2 {
            let offset = index * PCM_ALIGN + channel * 2;
            let previous = i16::from_le_bytes([dest[dest_at + offset], dest[dest_at + offset + 1]]) as f32;
            let incoming = i16::from_le_bytes([next[offset], next[offset + 1]]) as f32;
            let mixed = previous * (1.0 - t) + incoming * t;
            dest[dest_at + offset..dest_at + offset + 2]
                .copy_from_slice(&(mixed.round() as i16).to_le_bytes());
        }
    }
    dest.extend_from_slice(&next[fade..next_len]);
}

fn hns_to_pcm_bytes(hns: i64) -> usize {
    let bytes = (hns.max(0) as u64) * u64::from(PCM_BYTES_PER_SEC) / 10_000_000;
    let bytes = bytes as usize;
    bytes - (bytes % PCM_ALIGN)
}

/// Pins `pcm` to the duration of the video it accompanies. Returns how far off
/// it was, in bytes; anything but a rounding error means audio went missing
/// upstream.
fn fit_pcm_to_video(pcm: &mut Vec<u8>, video_hns: i64) -> i64 {
    let want = hns_to_pcm_bytes(video_hns);
    let drift = pcm.len() as i64 - want as i64;
    if pcm.len() > want {
        pcm.truncate(want);
    } else if pcm.len() < want {
        pcm.resize(want, 0);
    }
    drift
}

fn pcm_bytes_to_ms(bytes: i64) -> i64 {
    bytes * 1000 / i64::from(PCM_BYTES_PER_SEC)
}

fn write_stitched_aac(writer: &IMFSinkWriter, stream: u32, pcm: &[u8]) -> Result<(), String> {
    let mut time = 0_i64;
    let mut offset = 0;
    while offset < pcm.len() {
        let remaining = pcm.len() - offset;
        let copy = remaining.min(AAC_CHUNK_BYTES);
        let copy = copy - (copy % PCM_ALIGN);
        if copy == 0 {
            break;
        }
        // Short last frames make the AAC MFT click. Pad to a full 1024-sample frame.
        let mut frame = vec![0u8; AAC_CHUNK_BYTES];
        frame[..copy].copy_from_slice(&pcm[offset..offset + copy]);
        let duration = (AAC_CHUNK_BYTES as i64) * 10_000_000 / i64::from(PCM_BYTES_PER_SEC);
        unsafe {
            let media_buffer = MFCreateMemoryBuffer(AAC_CHUNK_BYTES as u32).map_err(|err| err.to_string())?;
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
            sample.AddBuffer(&media_buffer).map_err(|err| err.to_string())?;
            sample.SetSampleTime(time).map_err(|err| err.to_string())?;
            sample
                .SetSampleDuration(duration)
                .map_err(|err| err.to_string())?;
            writer
                .WriteSample(stream, &sample)
                .map_err(|err| format!("Could not write stitched audio: {err}"))?;
        }
        time += duration;
        offset += copy;
    }
    Ok(())
}

fn frame_duration_hns(media_type: &IMFMediaType) -> i64 {
    let packed = unsafe { media_type.GetUINT64(&MF_MT_FRAME_RATE).unwrap_or((60 << 32) | 1) };
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
                .ReadSample(reader_stream, 0, None, Some(&mut flags), Some(&mut timestamp), Some(&mut sample))
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
            sample.SetSampleTime(*timeline).map_err(|err| err.to_string())?;
            sample.SetSampleDuration(duration).map_err(|err| err.to_string())?;
            writer
                .WriteSample(writer_stream, &sample)
                .map_err(|err| format!("Could not copy a replay sample: {err}"))?;
        }
        *timeline += duration;
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
                .ReadSample(reader_stream, 0, None, Some(&mut flags), Some(&mut timestamp), Some(&mut sample))
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
            sample.SetSampleTime(out_time).map_err(|err| err.to_string())?;
            sample.SetSampleDuration(duration).map_err(|err| err.to_string())?;
            writer
                .WriteSample(writer_stream, &sample)
                .map_err(|err| format!("Could not copy a clip sample: {err}"))?;
        }
        *timeline = out_time + duration;
    }
    Ok(())
}

pub fn should_watermark_exports(app: &tauri::AppHandle) -> bool {
    let state = app.state::<crate::database::AppState>();
    let Ok(db) = state.db.lock() else {
        return true;
    };
    crate::settings::load(&db)
        .map(|item| item.watermark_exports)
        .unwrap_or(true)
}

pub fn watermarked_temp(source: &Path, fps: u32) -> Result<PathBuf, String> {
    let dest = source.with_file_name(format!(
        "{}.watermark.mp4",
        source.file_stem().and_then(|name| name.to_str()).unwrap_or("clip")
    ));
    write_watermarked_mp4(source, &dest, fps)?;
    Ok(dest)
}
