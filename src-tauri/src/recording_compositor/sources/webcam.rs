//! Recording-only webcam reader. Does not start IR rolling or write a sidecar.

#![cfg(windows)]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use windows::Win32::Media::MediaFoundation::{
    IMFMediaType, IMFSample, IMFSourceReader, MFCreateAttributes, MFCreateMediaType,
    MFCreateSourceReaderFromMediaSource, MFMediaType_Video, MF_MT_DEFAULT_STRIDE, MF_MT_FRAME_SIZE,
    MF_MT_MAJOR_TYPE, MF_MT_SUBTYPE, MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS,
    MF_SOURCE_READERF_ENDOFSTREAM, MF_SOURCE_READERF_ERROR,
    MF_SOURCE_READER_ENABLE_ADVANCED_VIDEO_PROCESSING, MF_SOURCE_READER_FIRST_VIDEO_STREAM,
};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

use crate::camera::color::{flip_bgra_horizontal, nv12_to_bgra, rgb32_to_bgra, yuy2_to_bgra};
use crate::camera::device::{
    activate_source, ensure_mf, guid_from_subtype, list_modes, mf_error, permission_message,
};
use crate::camera::{pick_camera_mode, CameraSubtype, RequestedMode};
use crate::still::StillFrame;

use super::super::scene::ValidatedWebcam;

pub struct ComposedWebcam {
    stop: Arc<AtomicBool>,
    latest: Arc<Mutex<Option<StillFrame>>>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

impl ComposedWebcam {
    pub fn start(spec: &ValidatedWebcam) -> Result<Self, String> {
        let stop = Arc::new(AtomicBool::new(false));
        let latest = Arc::new(Mutex::new(None));
        let thread_stop = Arc::clone(&stop);
        let thread_latest = Arc::clone(&latest);
        let device_id = spec.device_id.clone();
        let width = spec.width;
        let height = spec.height;
        let fps = spec.fps;
        let mirror = spec.mirror;
        let handle = std::thread::Builder::new()
            .name("composed-webcam".into())
            .spawn(move || {
                if let Err(err) = run_webcam(
                    device_id,
                    width,
                    height,
                    fps,
                    mirror,
                    thread_stop,
                    thread_latest,
                ) {
                    tracing::warn!("composed webcam stopped: {err}");
                }
            })
            .map_err(|err| err.to_string())?;
        Ok(Self {
            stop,
            latest,
            thread: Mutex::new(Some(handle)),
        })
    }

    pub fn latest(&self) -> Option<StillFrame> {
        self.latest.lock().ok().and_then(|slot| slot.clone())
    }

    pub fn stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Ok(mut thread) = self.thread.lock() {
            if let Some(handle) = thread.take() {
                let _ = handle.join();
            }
        }
    }
}

impl Drop for ComposedWebcam {
    fn drop(&mut self) {
        self.stop();
    }
}

fn run_webcam(
    device_id: String,
    width: u32,
    height: u32,
    fps: u32,
    mirror: bool,
    stop: Arc<AtomicBool>,
    latest: Arc<Mutex<Option<StillFrame>>>,
) -> Result<(), String> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    ensure_mf()?;
    let modes = list_modes(&device_id)?;
    let selected = pick_camera_mode(
        &modes,
        RequestedMode {
            width,
            height,
            fps,
        },
    )
    .ok_or_else(|| "That camera did not report a usable video mode.".to_string())?;
    let source = unsafe { activate_source(&device_id)? };
    let (reader, subtype) = open_reader(&source, selected.width, selected.height)?;
    let mut scratch = Vec::new();
    while !stop.load(Ordering::SeqCst) {
        let sample = match read_sample(&reader, subtype, selected.width, selected.height, &mut scratch)
        {
            Ok(Some(sample)) => sample,
            Ok(None) => continue,
            Err(err) => {
                if stop.load(Ordering::SeqCst) {
                    break;
                }
                return Err(err);
            }
        };
        let mut bgra = sample.bgra;
        if mirror {
            flip_bgra_horizontal(&mut bgra, sample.width, sample.height);
        }
        if let Ok(mut slot) = latest.lock() {
            *slot = Some(StillFrame {
                bgra,
                width: sample.width,
                height: sample.height,
                pitch: sample.width * 4,
            });
        }
    }
    Ok(())
}

struct CamSample {
    bgra: Vec<u8>,
    width: u32,
    height: u32,
}

fn open_reader(
    source: &windows::Win32::Media::MediaFoundation::IMFMediaSource,
    width: u32,
    height: u32,
) -> Result<(IMFSourceReader, CameraSubtype), String> {
    unsafe {
        let mut attrs = None;
        MFCreateAttributes(&mut attrs, 2).map_err(mf_error)?;
        let attrs = attrs.ok_or_else(|| "Could not create Media Foundation attributes.".to_string())?;
        let _ = attrs.SetUINT32(&MF_SOURCE_READER_ENABLE_ADVANCED_VIDEO_PROCESSING, 1);
        let _ = attrs.SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1);
        let reader = MFCreateSourceReaderFromMediaSource(source, Some(&attrs))
            .map_err(|err| permission_message(&err.to_string()))?;
        reader
            .SetStreamSelection(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32, true)
            .map_err(|err| permission_message(&err.to_string()))?;
        for subtype in [CameraSubtype::Nv12, CameraSubtype::Yuy2, CameraSubtype::Rgb32] {
            if set_type(&reader, width, height, subtype).is_ok() {
                return Ok((reader, subtype));
            }
        }
        Err("Could not negotiate a camera format for composed recording.".into())
    }
}

fn set_type(
    reader: &IMFSourceReader,
    width: u32,
    height: u32,
    subtype: CameraSubtype,
) -> Result<(), String> {
    let guid = guid_from_subtype(subtype).ok_or_else(|| "Unsupported camera subtype.".to_string())?;
    unsafe {
        let media_type: IMFMediaType = MFCreateMediaType().map_err(mf_error)?;
        media_type
            .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
            .map_err(mf_error)?;
        media_type.SetGUID(&MF_MT_SUBTYPE, &guid).map_err(mf_error)?;
        media_type
            .SetUINT64(&MF_MT_FRAME_SIZE, (u64::from(width) << 32) | u64::from(height))
            .map_err(mf_error)?;
        reader
            .SetCurrentMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32, None, &media_type)
            .map_err(mf_error)
    }
}

fn read_sample(
    reader: &IMFSourceReader,
    subtype: CameraSubtype,
    fallback_width: u32,
    fallback_height: u32,
    nv12_scratch: &mut Vec<u8>,
) -> Result<Option<CamSample>, String> {
    let mut flags = 0u32;
    let mut timestamp = 0i64;
    let mut sample: Option<IMFSample> = None;
    unsafe {
        reader
            .ReadSample(
                MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32,
                0,
                None,
                Some(&mut flags),
                Some(&mut timestamp),
                Some(&mut sample),
            )
            .map_err(|err| permission_message(&err.to_string()))?;
    }
    if flags & MF_SOURCE_READERF_ERROR.0 as u32 != 0 {
        return Err("The camera disconnected.".into());
    }
    if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
        return Ok(None);
    }
    let Some(sample) = sample else {
        return Ok(None);
    };
    let (width, height) = reader_frame_size(reader).unwrap_or((fallback_width, fallback_height));
    let buffer = unsafe { sample.ConvertToContiguousBuffer().map_err(mf_error)? };
    let mut data = std::ptr::null_mut();
    let mut length = 0u32;
    let mut max_length = 0u32;
    unsafe {
        buffer
            .Lock(&mut data, Some(&mut max_length), Some(&mut length))
            .map_err(mf_error)?;
    }
    if data.is_null() || length == 0 {
        let _ = unsafe { buffer.Unlock() };
        return Ok(None);
    }
    let bytes = unsafe { std::slice::from_raw_parts(data, length as usize) };
    let stride = reader_stride(reader, width, subtype);
    let bgra = match subtype {
        CameraSubtype::Nv12 => {
            nv12_scratch.clear();
            nv12_scratch.extend_from_slice(bytes);
            let _ = unsafe { buffer.Unlock() };
            nv12_to_bgra(nv12_scratch, width, height, stride as usize)
        }
        CameraSubtype::Yuy2 => {
            let converted = yuy2_to_bgra(bytes, width, height, stride as usize);
            let _ = unsafe { buffer.Unlock() };
            converted
        }
        CameraSubtype::Rgb32 => {
            let converted = rgb32_to_bgra(bytes, width, height, stride as usize);
            let _ = unsafe { buffer.Unlock() };
            converted
        }
        _ => {
            let _ = unsafe { buffer.Unlock() };
            None
        }
    };
    Ok(bgra.map(|bgra| CamSample { bgra, width, height }))
}

fn reader_frame_size(reader: &IMFSourceReader) -> Option<(u32, u32)> {
    unsafe {
        let media_type = reader
            .GetCurrentMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32)
            .ok()?;
        let packed = media_type.GetUINT64(&MF_MT_FRAME_SIZE).ok()?;
        Some(((packed >> 32) as u32, packed as u32))
    }
}

fn reader_stride(reader: &IMFSourceReader, width: u32, subtype: CameraSubtype) -> u32 {
    unsafe {
        if let Ok(media_type) = reader.GetCurrentMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32) {
            if let Ok(stride) = media_type.GetUINT32(&MF_MT_DEFAULT_STRIDE) {
                if stride > 0 {
                    return stride;
                }
            }
        }
    }
    match subtype {
        CameraSubtype::Nv12 => width,
        CameraSubtype::Yuy2 => width.saturating_mul(2),
        CameraSubtype::Rgb32 => width.saturating_mul(4),
        _ => width,
    }
}
