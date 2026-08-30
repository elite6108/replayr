//! Mux already-encoded H.264 samples into an MP4. Does not encode.

use std::path::Path;

use windows::core::PCWSTR;
use windows::Win32::Media::MediaFoundation::{
    IMFMediaType, IMFSample, IMFSinkWriter, MFCreateAttributes, MFCreateSinkWriterFromURL,
    MF_SINK_WRITER_DISABLE_THROTTLING,
};

use super::super::writer::{wide_path, WriterAudio, MF_READWRITE_DISABLE_CONVERTERS};

pub(crate) struct H264Mp4Mux {
    writer: IMFSinkWriter,
    video_stream: u32,
    audio_stream: Option<u32>,
    audio_time: i64,
}

impl H264Mp4Mux {
    /// `video_type` must be the encoder's negotiated compressed output type.
    pub(crate) fn create(
        path: &Path,
        video_type: &IMFMediaType,
        audio_type: Option<&IMFMediaType>,
    ) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
        }
        let wide = wide_path(path);
        let audio = match audio_type {
            Some(media) => WriterAudio::Copy(media.clone()),
            None => WriterAudio::None,
        };
        unsafe {
            let mut attrs = None;
            MFCreateAttributes(&mut attrs, 4).map_err(|err| err.to_string())?;
            let attrs = attrs.ok_or_else(|| "Could not create mux attributes.".to_string())?;
            // Same remux attrs as F10 copy: converters off, no hardware-transform flag.
            let _ = attrs.SetUINT32(&MF_READWRITE_DISABLE_CONVERTERS, 1);
            let _ = attrs.SetUINT32(&MF_SINK_WRITER_DISABLE_THROTTLING, 1);
            let writer = match MFCreateSinkWriterFromURL(PCWSTR(wide.as_ptr()), None, Some(&attrs))
            {
                Ok(writer) => writer,
                Err(err) => {
                    tracing::warn!(
                        path = %path.display(),
                        %err,
                        "H.264 mux create failed with remux attrs; retrying without DISABLE_CONVERTERS"
                    );
                    let mut plain = None;
                    MFCreateAttributes(&mut plain, 2).map_err(|e| e.to_string())?;
                    let plain =
                        plain.ok_or_else(|| "Could not create mux attributes.".to_string())?;
                    let _ = plain.SetUINT32(&MF_SINK_WRITER_DISABLE_THROTTLING, 1);
                    MFCreateSinkWriterFromURL(PCWSTR(wide.as_ptr()), None, Some(&plain)).map_err(
                        |retry| {
                            format!(
                                "Could not create the H.264 mux for {}: {err} (retry: {retry})",
                                path.display()
                            )
                        },
                    )?
                }
            };
            let video_stream = writer.AddStream(video_type).map_err(|err| {
                format!(
                    "mux AddStream hr={:#x} {err}",
                    err.code().0 as u32
                )
            })?;
            if let Err(err) = writer.SetInputMediaType(video_stream, video_type, None) {
                return Err(format!(
                    "mux SetInputMediaType hr={:#x} {err}",
                    err.code().0 as u32
                ));
            }
            tracing::info!(
                stream = video_stream,
                set_input_media_type_hr = "0x0",
                "H.264 mux SetInputMediaType succeeded"
            );
            let audio_stream = match audio {
                WriterAudio::Copy(media_type) => {
                    let audio_stream = writer
                        .AddStream(&media_type)
                        .map_err(|err| format!("Could not add mux audio: {err}"))?;
                    writer
                        .SetInputMediaType(audio_stream, &media_type, None)
                        .map_err(|err| format!("Could not set mux audio type: {err}"))?;
                    Some(audio_stream)
                }
                WriterAudio::None | WriterAudio::StitchedAac => None,
            };
            writer.BeginWriting().map_err(|err| {
                format!(
                    "mux BeginWriting hr={:#x} {err}",
                    err.code().0 as u32
                )
            })?;
            Ok(Self {
                writer,
                video_stream,
                audio_stream,
                audio_time: 0,
            })
        }
    }

    /// How far the audio stream has been fed, in HNS. The MP4 sink can only flush up to
    /// the minimum of its stream clocks, so this must track the video clock closely.
    pub(crate) fn audio_time_hns(&self) -> i64 {
        self.audio_time
    }

    pub(crate) fn has_audio(&self) -> bool {
        self.audio_stream.is_some()
    }

    pub(crate) fn write_video(&self, sample: &IMFSample) -> Result<(), String> {
        unsafe {
            self.writer
                .WriteSample(self.video_stream, sample)
                .map_err(|err| format!("mux WriteSample hr={:#x} {err}", err.code().0 as u32))
        }
    }

    pub(crate) fn write_audio(&mut self, sample: &IMFSample, duration_hns: i64) -> Result<(), String> {
        let Some(audio_stream) = self.audio_stream else {
            return Ok(());
        };
        let duration = duration_hns.max(10_000);
        unsafe {
            sample
                .SetSampleTime(self.audio_time)
                .map_err(|err| err.to_string())?;
            sample
                .SetSampleDuration(duration)
                .map_err(|err| err.to_string())?;
            self.writer
                .WriteSample(audio_stream, sample)
                .map_err(|err| format!("mux audio WriteSample hr={:#x} {err}", err.code().0 as u32))?;
        }
        self.audio_time += duration;
        Ok(())
    }

    pub(crate) fn finish(self) -> Result<(), String> {
        unsafe {
            self.writer.Finalize().map_err(|err| {
                format!("mux Finalize hr={:#x} {err}", err.code().0 as u32)
            })
        }
    }
}
