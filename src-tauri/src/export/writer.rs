use std::path::Path;

use windows::core::{GUID, PCWSTR};
use windows::Win32::Media::MediaFoundation::{
    IMFMediaType, IMFSinkWriter, MFAudioFormat_AAC, MFAudioFormat_PCM, MFCreateAttributes,
    MFCreateMediaType, MFCreateSinkWriterFromURL, MFMediaType_Audio,
    MF_MT_AAC_AUDIO_PROFILE_LEVEL_INDICATION, MF_MT_AAC_PAYLOAD_TYPE,
    MF_MT_AUDIO_AVG_BYTES_PER_SECOND, MF_MT_AUDIO_BITS_PER_SAMPLE, MF_MT_AUDIO_BLOCK_ALIGNMENT,
    MF_MT_AUDIO_NUM_CHANNELS, MF_MT_AUDIO_SAMPLES_PER_SECOND, MF_MT_AVG_BITRATE, MF_MT_MAJOR_TYPE,
    MF_MT_SUBTYPE, MF_SINK_WRITER_DISABLE_THROTTLING,
};

const PCM_RATE: u32 = 48_000;
const PCM_CHANNELS: u32 = 2;
const PCM_ALIGN: usize = 4;
const PCM_BYTES_PER_SEC: u32 = PCM_RATE * PCM_ALIGN as u32;

/// Pass encoded samples through. Video remux stays converter-free. Audio joins are decoded to PCM.
pub(super) const MF_READWRITE_DISABLE_CONVERTERS: GUID =
    GUID::from_u128(0x98d5b065_1374_4847_8d5d_31520fee7156);

pub(super) fn wide_path(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

pub(super) enum WriterAudio {
    None,
    Copy(IMFMediaType),
    StitchedAac,
}

pub(super) fn open_writer(
    path: &Path,
    video_type: &IMFMediaType,
    audio: WriterAudio,
) -> Result<IMFSinkWriter, String> {
    let wide = wide_path(path);
    unsafe {
        let mut attrs = None;
        MFCreateAttributes(&mut attrs, 4).map_err(|err| err.to_string())?;
        let attrs = attrs.ok_or_else(|| "Could not create writer attributes.".to_string())?;
        // Pure compressed copy (webcam sidecar / Copy audio) needs converters
        // off so H.264 can be both the output and input type. Do not also set
        // MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS — that combo makes
        // MFCreateSinkWriterFromURL return E_INVALIDARG (0x80070057) on some
        // machines, which is why F10 gameplay remux worked while the webcam
        // sidecar always failed.
        if !matches!(audio, WriterAudio::StitchedAac) {
            let _ = attrs.SetUINT32(&MF_READWRITE_DISABLE_CONVERTERS, 1);
        }
        let _ = attrs.SetUINT32(&MF_SINK_WRITER_DISABLE_THROTTLING, 1);
        let writer = match MFCreateSinkWriterFromURL(PCWSTR(wide.as_ptr()), None, Some(&attrs)) {
            Ok(writer) => writer,
            Err(err) => {
                // Last-chance fallback: bare writer attributes. Still try to
                // attach the compressed type below.
                tracing::warn!(
                    path = %path.display(),
                    %err,
                    "clip writer create failed with remux attrs; retrying without DISABLE_CONVERTERS"
                );
                let mut plain = None;
                MFCreateAttributes(&mut plain, 2).map_err(|e| e.to_string())?;
                let plain =
                    plain.ok_or_else(|| "Could not create writer attributes.".to_string())?;
                let _ = plain.SetUINT32(&MF_SINK_WRITER_DISABLE_THROTTLING, 1);
                MFCreateSinkWriterFromURL(PCWSTR(wide.as_ptr()), None, Some(&plain)).map_err(
                    |retry| {
                        format!(
                            "Could not create the clip writer for {}: {err} (retry: {retry})",
                            path.display()
                        )
                    },
                )?
            }
        };
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

pub(super) fn pcm_input_type() -> Result<IMFMediaType, String> {
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

pub(super) fn open_compose_writer(
    dest: &Path,
    width: u32,
    height: u32,
    fps: u32,
    bitrate: u32,
    has_audio: bool,
) -> Result<crate::encode::MfWriter, String> {
    match crate::encode::MfWriter::create(
        dest,
        width,
        height,
        fps,
        bitrate,
        has_audio,
        None,
        false,
        crate::encode::VideoInput::Bgra,
        true,
    ) {
        Ok(writer) => Ok(writer),
        Err(hw_err) => {
            tracing::warn!(%hw_err, "hardware compose encoder failed; trying software H.264");
            let _ = std::fs::remove_file(dest);
            crate::encode::MfWriter::create(
                dest,
                width,
                height,
                fps,
                bitrate,
                has_audio,
                None,
                false,
                crate::encode::VideoInput::Bgra,
                false,
            )
            .map_err(|sw_err| {
                format!("Compose encoder failed (hardware: {hw_err}; software: {sw_err})")
            })
        }
    }
}

pub(super) fn open_compose_writer_nv12(
    dest: &Path,
    width: u32,
    height: u32,
    fps: u32,
    bitrate: u32,
    audio: crate::encode::WriterAudio,
) -> Result<crate::encode::MfWriter, String> {
    match crate::encode::MfWriter::create_ex(
        dest,
        width,
        height,
        fps,
        bitrate,
        audio.clone(),
        None,
        false,
        crate::encode::VideoInput::Nv12,
        true,
        None,
    ) {
        Ok(writer) => {
            let transform = writer.h264_transform_name();
            tracing::info!(
                width,
                height,
                bitrate,
                transform = ?transform,
                "nv12 compose encoder opened (hardware transforms requested)"
            );
            Ok(writer)
        }
        Err(hw_err) => {
            tracing::warn!(%hw_err, "hardware NV12 compose encoder failed; trying software H.264");
            let _ = std::fs::remove_file(dest);
            crate::encode::MfWriter::create_ex(
                dest,
                width,
                height,
                fps,
                bitrate,
                audio,
                None,
                false,
                crate::encode::VideoInput::Nv12,
                false,
                None,
            )
            .map_err(|sw_err| {
                format!("Compose encoder failed (hardware: {hw_err}; software: {sw_err})")
            })
        }
    }
}
