use std::path::{Path, PathBuf};
use std::time::Instant;

use windows::core::{GUID, PCWSTR};
use windows::Win32::Media::MediaFoundation::{
    IMFMediaType, IMFSample, IMFSinkWriter, IMFSourceReader, MFCreateAttributes, MFCreateSinkWriterFromURL,
    MFCreateSourceReaderFromURL, MFStartup, MF_MT_FRAME_RATE, MF_SINK_WRITER_DISABLE_THROTTLING,
    MF_SOURCE_READERF_ENDOFSTREAM, MF_SOURCE_READER_FIRST_AUDIO_STREAM, MF_SOURCE_READER_FIRST_VIDEO_STREAM,
    MFSTARTUP_FULL, MF_VERSION,
};

/// Pass encoded samples through. Do not load decoders/encoders (those are busy on the capture thread).
const MF_READWRITE_DISABLE_CONVERTERS: GUID = GUID::from_u128(0x98d5b065_1374_4847_8d5d_31520fee7156);
const MF_LOW_LATENCY: GUID = GUID::from_u128(0x9c27891a_ed7a_40e1_88e8_b22727a024ee);

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
    let audio_type = native_type(&first, MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32);
    drop(first);

    let writer = open_writer(output, &video_type, audio_type.as_ref())?;
    let fallback = frame_duration_hns(&video_type);
    let mut video_time = 0_i64;
    let mut audio_time = 0_i64;

    for path in inputs {
        let reader = open_reader(path)?;
        copy_stream(
            &reader,
            &writer,
            0,
            MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32,
            &mut video_time,
            fallback,
        )?;
        if audio_type.is_some() {
            copy_stream(
                &reader,
                &writer,
                1,
                MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32,
                &mut audio_time,
                10_000_000 / 48,
            )?;
        }
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

fn open_writer(
    path: &Path,
    video_type: &IMFMediaType,
    audio_type: Option<&IMFMediaType>,
) -> Result<IMFSinkWriter, String> {
    let wide = wide_path(path);
    unsafe {
        let mut attrs = None;
        MFCreateAttributes(&mut attrs, 4).map_err(|err| err.to_string())?;
        let attrs = attrs.ok_or_else(|| "Could not create writer attributes.".to_string())?;
        let _ = attrs.SetUINT32(&MF_READWRITE_DISABLE_CONVERTERS, 1);
        let _ = attrs.SetUINT32(&MF_SINK_WRITER_DISABLE_THROTTLING, 1);
        let _ = attrs.SetUINT32(&MF_LOW_LATENCY, 1);
        let writer = MFCreateSinkWriterFromURL(PCWSTR(wide.as_ptr()), None, Some(&attrs))
            .map_err(|err| format!("Could not create the clip writer: {err}"))?;
        let video_stream = writer
            .AddStream(video_type)
            .map_err(|err| format!("Could not add the video stream: {err}"))?;
        writer
            .SetInputMediaType(video_stream, video_type, None)
            .map_err(|err| format!("Could not set the video copy type: {err}"))?;
        if let Some(audio_type) = audio_type {
            let audio_stream = writer
                .AddStream(audio_type)
                .map_err(|err| format!("Could not add the audio stream: {err}"))?;
            writer
                .SetInputMediaType(audio_stream, audio_type, None)
                .map_err(|err| format!("Could not set the audio copy type: {err}"))?;
        }
        writer
            .BeginWriting()
            .map_err(|err| format!("Could not begin writing the clip: {err}"))?;
        Ok(writer)
    }
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
) -> Result<(), String> {
    let mut previous_ts: Option<i64> = None;
    loop {
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
