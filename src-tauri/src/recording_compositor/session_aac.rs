//! Session-only PCM → AAC encoder for composed mux. Clips never call this.

#![cfg(windows)]

use std::mem::ManuallyDrop;

use windows::Win32::Media::MediaFoundation::{
    IMFActivate, IMFMediaType, IMFSample, IMFTransform, MFAudioFormat_AAC, MFAudioFormat_PCM,
    MFCreateMediaType, MFCreateMemoryBuffer, MFCreateSample,     MFTEnumEx, MFT_CATEGORY_AUDIO_ENCODER, MFT_ENUM_FLAG_ALL,
    MFT_MESSAGE_COMMAND_DRAIN, MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, MFT_MESSAGE_NOTIFY_END_OF_STREAM,
    MFT_MESSAGE_NOTIFY_END_STREAMING, MFT_MESSAGE_NOTIFY_START_OF_STREAM, MFT_OUTPUT_DATA_BUFFER,
    MFT_OUTPUT_STREAM_PROVIDES_SAMPLES, MFT_REGISTER_TYPE_INFO, MFMediaType_Audio,
    MF_MT_AAC_AUDIO_PROFILE_LEVEL_INDICATION, MF_MT_AAC_PAYLOAD_TYPE,
    MF_MT_AUDIO_AVG_BYTES_PER_SECOND, MF_MT_AUDIO_BITS_PER_SAMPLE, MF_MT_AUDIO_BLOCK_ALIGNMENT,
    MF_MT_AUDIO_NUM_CHANNELS, MF_MT_AUDIO_SAMPLES_PER_SECOND, MF_MT_AVG_BITRATE, MF_MT_MAJOR_TYPE,
    MF_MT_SUBTYPE,
};
use windows::Win32::System::Com::CoTaskMemFree;

use crate::audio_timeline::{FRAME_BYTES, MIX_CHANNELS, MIX_RATE};

const AAC_FRAME_SAMPLES: u64 = 1024;
const AAC_FRAME_BYTES: usize = AAC_FRAME_SAMPLES as usize * FRAME_BYTES;
const HNS_PER_SECOND: i64 = 10_000_000;
const MF_E_TRANSFORM_NEED_MORE_INPUT: u32 = 0xC00D6D72;
const MF_E_NOTACCEPTING: u32 = 0xC00D36B5;

pub struct SessionAacEncoder {
    transform: IMFTransform,
    output_type: IMFMediaType,
    pending: Vec<u8>,
    samples_submitted: u64,
}

impl SessionAacEncoder {
    pub fn open() -> Result<Self, String> {
        let transform = activate_aac_encoder()?;
        let input = pcm_type()?;
        let output = aac_type()?;
        unsafe {
            transform
                .SetOutputType(0, &output, 0)
                .map_err(|err| format!("Could not set AAC output type: {err}"))?;
            transform
                .SetInputType(0, &input, 0)
                .map_err(|err| format!("Could not set AAC input type: {err}"))?;
            let _ = transform.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0);
            let _ = transform.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0);
        }
        let output_type = unsafe { transform.GetOutputCurrentType(0) }.unwrap_or(output);
        Ok(Self {
            transform,
            output_type,
            pending: Vec::new(),
            samples_submitted: 0,
        })
    }

    pub fn output_type(&self) -> IMFMediaType {
        self.output_type.clone()
    }

    pub fn encode(&mut self, pcm: &[u8], closing: bool) -> Result<Vec<(IMFSample, i64)>, String> {
        let aligned = pcm.len() - (pcm.len() % FRAME_BYTES);
        if aligned > 0 {
            self.pending.extend_from_slice(&pcm[..aligned]);
        }
        let mut packets = Vec::new();
        loop {
            let available = self.pending.len();
            let len = if available >= AAC_FRAME_BYTES {
                AAC_FRAME_BYTES
            } else if closing && available > 0 {
                available
            } else {
                break;
            };
            let mut chunk: Vec<u8> = self.pending.drain(..len).collect();
            if closing && self.pending.is_empty() && chunk.len() < AAC_FRAME_BYTES {
                chunk.resize(AAC_FRAME_BYTES, 0);
            }
            let frames = (chunk.len() / FRAME_BYTES) as u64;
            let time = samples_to_hns(self.samples_submitted);
            self.samples_submitted = self.samples_submitted.saturating_add(frames);
            let duration = samples_to_hns(self.samples_submitted).saturating_sub(time).max(10_000);
            let sample = pcm_sample(&chunk, time, duration)?;
            packets.extend(push_input(&self.transform, &sample, duration)?);
        }
        if closing {
            unsafe {
                let _ = self.transform.ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
                let _ = self.transform.ProcessMessage(MFT_MESSAGE_COMMAND_DRAIN, 0);
            }
            packets.extend(take_output(&self.transform, bytes_to_hns(AAC_FRAME_BYTES))?);
            unsafe {
                let _ = self.transform.ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
            }
        }
        Ok(packets)
    }
}

fn activate_aac_encoder() -> Result<IMFTransform, String> {
    unsafe {
        let info = MFT_REGISTER_TYPE_INFO {
            guidMajorType: MFMediaType_Audio,
            guidSubtype: MFAudioFormat_AAC,
        };
        let mut activates: *mut Option<IMFActivate> = std::ptr::null_mut();
        let mut count = 0u32;
        MFTEnumEx(
            MFT_CATEGORY_AUDIO_ENCODER,
            MFT_ENUM_FLAG_ALL,
            None,
            Some(&info),
            &mut activates,
            &mut count,
        )
        .map_err(|err| format!("Could not enumerate AAC encoders: {err}"))?;
        if activates.is_null() || count == 0 {
            if !activates.is_null() {
                CoTaskMemFree(Some(activates as *const std::ffi::c_void));
            }
            return Err("No AAC encoder is available. Use Legacy recording.".into());
        }
        let slice = std::slice::from_raw_parts(activates, count as usize);
        let mut chosen = None;
        for item in slice {
            if let Some(activate) = item {
                if let Ok(transform) = activate.ActivateObject::<IMFTransform>() {
                    chosen = Some(transform);
                    break;
                }
            }
        }
        CoTaskMemFree(Some(activates as *const std::ffi::c_void));
        chosen.ok_or_else(|| "Could not start the AAC encoder. Use Legacy recording.".into())
    }
}

fn pcm_type() -> Result<IMFMediaType, String> {
    unsafe {
        let media = MFCreateMediaType().map_err(|err| err.to_string())?;
        media
            .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)
            .map_err(|err| err.to_string())?;
        media
            .SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_PCM)
            .map_err(|err| err.to_string())?;
        media
            .SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)
            .map_err(|err| err.to_string())?;
        media
            .SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, MIX_RATE)
            .map_err(|err| err.to_string())?;
        media
            .SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, MIX_CHANNELS as u32)
            .map_err(|err| err.to_string())?;
        media
            .SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, FRAME_BYTES as u32)
            .map_err(|err| err.to_string())?;
        media
            .SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, MIX_RATE * FRAME_BYTES as u32)
            .map_err(|err| err.to_string())?;
        Ok(media)
    }
}

fn aac_type() -> Result<IMFMediaType, String> {
    unsafe {
        let media = MFCreateMediaType().map_err(|err| err.to_string())?;
        media
            .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)
            .map_err(|err| err.to_string())?;
        media
            .SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_AAC)
            .map_err(|err| err.to_string())?;
        media
            .SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)
            .map_err(|err| err.to_string())?;
        media
            .SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, MIX_RATE)
            .map_err(|err| err.to_string())?;
        media
            .SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, MIX_CHANNELS as u32)
            .map_err(|err| err.to_string())?;
        media
            .SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, 1)
            .map_err(|err| err.to_string())?;
        media
            .SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, 24_000)
            .map_err(|err| err.to_string())?;
        media
            .SetUINT32(&MF_MT_AVG_BITRATE, 192_000)
            .map_err(|err| err.to_string())?;
        media
            .SetUINT32(&MF_MT_AAC_PAYLOAD_TYPE, 0)
            .map_err(|err| err.to_string())?;
        media
            .SetUINT32(&MF_MT_AAC_AUDIO_PROFILE_LEVEL_INDICATION, 0x29)
            .map_err(|err| err.to_string())?;
        Ok(media)
    }
}

fn pcm_sample(pcm: &[u8], time_hns: i64, duration_hns: i64) -> Result<IMFSample, String> {
    unsafe {
        let buffer = MFCreateMemoryBuffer(pcm.len() as u32).map_err(|err| err.to_string())?;
        let mut data = std::ptr::null_mut();
        buffer
            .Lock(&mut data, None, None)
            .map_err(|err| err.to_string())?;
        if !data.is_null() {
            std::ptr::copy_nonoverlapping(pcm.as_ptr(), data, pcm.len());
        }
        buffer.Unlock().map_err(|err| err.to_string())?;
        buffer
            .SetCurrentLength(pcm.len() as u32)
            .map_err(|err| err.to_string())?;
        let sample = MFCreateSample().map_err(|err| err.to_string())?;
        sample.AddBuffer(&buffer).map_err(|err| err.to_string())?;
        sample
            .SetSampleTime(time_hns.max(0))
            .map_err(|err| err.to_string())?;
        sample
            .SetSampleDuration(duration_hns.max(10_000))
            .map_err(|err| err.to_string())?;
        Ok(sample)
    }
}

fn push_input(
    transform: &IMFTransform,
    sample: &IMFSample,
    fallback_duration: i64,
) -> Result<Vec<(IMFSample, i64)>, String> {
    unsafe {
        match transform.ProcessInput(0, sample, 0) {
            Ok(()) => take_output(transform, fallback_duration),
            Err(err) if err.code().0 as u32 == MF_E_NOTACCEPTING => {
                let mut packets = take_output(transform, fallback_duration)?;
                transform
                    .ProcessInput(0, sample, 0)
                    .map_err(|retry| format!("AAC ProcessInput failed: {retry}"))?;
                packets.extend(take_output(transform, fallback_duration)?);
                Ok(packets)
            }
            Err(err) => Err(format!("AAC ProcessInput failed: {err}")),
        }
    }
}

fn take_output(transform: &IMFTransform, fallback_duration: i64) -> Result<Vec<(IMFSample, i64)>, String> {
    let mut packets = Vec::new();
    loop {
        match take_one(transform, fallback_duration) {
            Ok(Some(packet)) => packets.push(packet),
            Ok(None) => break,
            Err(err) => return Err(err),
        }
    }
    Ok(packets)
}

fn take_one(transform: &IMFTransform, fallback_duration: i64) -> Result<Option<(IMFSample, i64)>, String> {
    unsafe {
        let info = transform
            .GetOutputStreamInfo(0)
            .map_err(|err| format!("AAC GetOutputStreamInfo: {err}"))?;
        let provides = info.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32 != 0;
        let sample = if provides {
            None
        } else {
            let sample = MFCreateSample().map_err(|err| err.to_string())?;
            let size = info.cbSize.max(2048);
            let buffer = MFCreateMemoryBuffer(size).map_err(|err| err.to_string())?;
            sample.AddBuffer(&buffer).map_err(|err| err.to_string())?;
            Some(sample)
        };
        let mut buffers = [MFT_OUTPUT_DATA_BUFFER {
            dwStreamID: 0,
            pSample: ManuallyDrop::new(sample),
            dwStatus: 0,
            pEvents: ManuallyDrop::new(None),
        }];
        let mut status = 0u32;
        let result = transform.ProcessOutput(0, &mut buffers, &mut status);
        let out = ManuallyDrop::take(&mut buffers[0].pSample);
        let _ = ManuallyDrop::take(&mut buffers[0].pEvents);
        if let Err(err) = result {
            if err.code().0 as u32 == MF_E_TRANSFORM_NEED_MORE_INPUT {
                return Ok(None);
            }
            return Err(format!("AAC ProcessOutput failed: {err}"));
        }
        let Some(sample) = out else {
            return Ok(None);
        };
        let duration = sample.GetSampleDuration().unwrap_or(fallback_duration).max(10_000);
        Ok(Some((sample, duration)))
    }
}

fn bytes_to_hns(bytes: usize) -> i64 {
    samples_to_hns((bytes / FRAME_BYTES) as u64)
}

fn samples_to_hns(samples: u64) -> i64 {
    i64::try_from(samples.saturating_mul(HNS_PER_SECOND as u64) / u64::from(MIX_RATE)).unwrap_or(i64::MAX)
}
