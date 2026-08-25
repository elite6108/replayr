use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use windows::core::{GUID, PCWSTR};
use windows::Win32::Media::MediaFoundation::{
    IMFMediaType, IMFSample, IMFSourceReader, MFCreateAttributes, MFCreateMediaType, MFCreateSourceReaderFromURL,
    MFStartup, MFMediaType_Video, MFVideoFormat_ARGB32, MFVideoFormat_NV12, MFVideoFormat_RGB32,
    MFVideoInterlace_Progressive,
    MF_MT_FRAME_SIZE, MF_MT_INTERLACE_MODE, MF_MT_MAJOR_TYPE, MF_MT_SUBTYPE,
    MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, MF_SOURCE_READERF_ENDOFSTREAM,
    MF_SOURCE_READER_ENABLE_ADVANCED_VIDEO_PROCESSING, MF_SOURCE_READER_FIRST_VIDEO_STREAM, MFSTARTUP_FULL,
    MF_VERSION,
};
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;

use crate::still::{scale_bgra, write_bgra_bmp, StillFrame};

fn wide_path(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
}

pub fn from_video(source: &Path, dest: &Path) -> Result<(), String> {
    unsafe {
        MFStartup(MF_VERSION, MFSTARTUP_FULL).map_err(|err| err.to_string())?;
    }
    let reader = open_decode_reader(source)?;
    let mut frame = None;
    for _ in 0..24 {
        if let Some((next, _, _)) = read_rgb_sample(&reader)? {
            frame = Some(next);
        } else {
            break;
        }
    }
    let frame = frame.ok_or_else(|| "Could not decode a thumbnail frame.".to_string())?;
    let thumb = scale_bgra(&frame, 480);
    write_bgra_bmp(dest, &thumb)
}

pub fn frame_at(source: &Path, at_ms: u64) -> Result<StillFrame, String> {
    unsafe {
        MFStartup(MF_VERSION, MFSTARTUP_FULL).map_err(|err| err.to_string())?;
    }
    let reader = open_decode_reader(source)?;
    if at_ms > 0 {
        seek_reader(&reader, (at_ms as i64).saturating_mul(10_000))?;
    }
    read_next_frame(&reader)?.ok_or_else(|| "Could not decode a thumbnail frame.".to_string())
}

pub fn filmstrip(source: &Path, dest_dir: &Path, count: u32, duration_ms: u64) -> Result<Vec<(PathBuf, u64)>, String> {
    let count = count.clamp(8, 16);
    let mtime = source
        .metadata()
        .ok()
        .and_then(|meta| meta.modified().ok())
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|time| time.as_secs())
        .unwrap_or(0);
    if let Some(cached) = cached_filmstrip(dest_dir, count, mtime, duration_ms) {
        return Ok(cached);
    }
    std::fs::create_dir_all(dest_dir).map_err(|err| err.to_string())?;
    unsafe {
        MFStartup(MF_VERSION, MFSTARTUP_FULL).map_err(|err| err.to_string())?;
    }
    let reader = open_decode_reader(source)?;
    let mut frames = Vec::new();
    for index in 0..count {
        let at_ms = if duration_ms == 0 {
            0
        } else {
            duration_ms.saturating_mul(index as u64) / count.max(1) as u64
        };
        if let Err(err) = seek_reader(&reader, (at_ms as i64).saturating_mul(10_000)) {
            tracing::warn!("filmstrip seek {index} at {at_ms} ms failed: {err}");
            continue;
        }
        match read_next_frame(&reader) {
            Ok(Some(frame)) => {
                let dest = dest_dir.join(format!("{index:02}.bmp"));
                write_bgra_bmp(&dest, &scale_bgra(&frame, 160))?;
                frames.push((dest, at_ms));
            }
            Ok(None) => tracing::warn!("filmstrip frame {index} at {at_ms} ms was empty"),
            Err(err) => tracing::warn!("filmstrip frame {index} at {at_ms} ms failed: {err}"),
        }
    }
    if frames.is_empty() {
        return Err("Could not build a timeline preview.".into());
    }
    let _ = std::fs::write(dest_dir.join(".meta"), format!("{mtime}:{count}:{duration_ms}:a8"));
    Ok(frames)
}

fn cached_filmstrip(dest_dir: &Path, count: u32, mtime: u64, duration_ms: u64) -> Option<Vec<(PathBuf, u64)>> {
    let meta = std::fs::read_to_string(dest_dir.join(".meta")).ok()?;
    if meta.trim() != format!("{mtime}:{count}:{duration_ms}:a8") {
        return None;
    }
    let mut frames = Vec::new();
    for index in 0..count {
        let dest = dest_dir.join(format!("{index:02}.bmp"));
        if !dest.exists() {
            return None;
        }
        let at_ms = if duration_ms == 0 {
            0
        } else {
            duration_ms.saturating_mul(index as u64) / count.max(1) as u64
        };
        frames.push((dest, at_ms));
    }
    Some(frames)
}

/// Opens a reader that hands back uncompressed BGRA frames.
///
/// The decoder emits NV12, so the reader has to insert the video processor to
/// reach RGB32. That only happens with advanced video processing turned on;
/// without it `SetCurrentMediaType` fails with MF_E_INVALIDMEDIATYPE. Some GPU
/// decoders still refuse the conversion, so fall back to software transforms
/// and then to ARGB32 before giving up.
fn open_decode_reader(path: &Path) -> Result<IMFSourceReader, String> {
    let mut last = String::new();
    for hardware in [true, false] {
        for subtype in [MFVideoFormat_RGB32, MFVideoFormat_ARGB32] {
            let reader = match open_reader(path, hardware) {
                Ok(reader) => reader,
                Err(err) => {
                    last = err;
                    continue;
                }
            };
            let output = uncompressed_type(subtype)?;
            let applied = unsafe {
                reader
                    .SetStreamSelection(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32, true)
                    .and_then(|()| {
                        reader.SetCurrentMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32, None, &output)
                    })
            };
            match applied {
                Ok(()) => return Ok(reader),
                Err(err) => {
                    last = format!(
                        "hardware={hardware} subtype={} rejected: {err}",
                        if subtype == MFVideoFormat_RGB32 { "RGB32" } else { "ARGB32" }
                    );
                }
            }
        }
    }
    Err(format!("Could not decode frames from {}: {last}", path.display()))
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

fn open_reader(path: &Path, hardware: bool) -> Result<IMFSourceReader, String> {
    open_reader_with(path, hardware, true)
}

fn open_reader_with(path: &Path, hardware: bool, video_processing: bool) -> Result<IMFSourceReader, String> {
    let wide = wide_path(path);
    unsafe {
        let mut attrs = None;
        MFCreateAttributes(&mut attrs, 2).map_err(|err| err.to_string())?;
        if let Some(attrs) = attrs.as_ref() {
            if video_processing {
                let _ = attrs.SetUINT32(&MF_SOURCE_READER_ENABLE_ADVANCED_VIDEO_PROCESSING, 1);
            }
            if hardware {
                let _ = attrs.SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1);
            }
        }
        MFCreateSourceReaderFromURL(PCWSTR(wide.as_ptr()), attrs.as_ref())
            .map_err(|err| format!("Could not open {}: {err}", path.display()))
    }
}

fn read_next_frame(reader: &IMFSourceReader) -> Result<Option<StillFrame>, String> {
    for _ in 0..12 {
        if let Some((frame, _, _)) = read_rgb_sample(reader)? {
            return Ok(Some(frame));
        }
    }
    Ok(None)
}

pub(crate) fn open_rgb_reader(path: &Path) -> Result<IMFSourceReader, String> {
    open_decode_reader(path)
}

pub(crate) fn seek_hns(reader: &IMFSourceReader, position_hns: i64) -> Result<(), String> {
    seek_reader(reader, position_hns)
}

/// Opens a reader that hands back NV12 frames straight from the decoder.
///
/// H.264 decodes to NV12 natively, so leaving advanced video processing off
/// keeps Media Foundation from inserting a video processor. That skips a
/// full-frame colour conversion per frame and hands back 1.5 bytes per pixel
/// instead of 4. Callers fall back to `open_rgb_reader` if this is rejected.
pub(crate) fn open_nv12_reader(path: &Path) -> Result<IMFSourceReader, String> {
    let mut last = String::new();
    // Prefer no video processing so no converter can slip in, but fall back to
    // allowing it: decoders that only advertise NV12 through the processor
    // still hand back NV12, which is what we care about.
    for video_processing in [false, true] {
        for hardware in [true, false] {
            let reader = match open_reader_with(path, hardware, video_processing) {
                Ok(reader) => reader,
                Err(err) => {
                    last = err;
                    continue;
                }
            };
            let output = nv12_type()?;
            let applied = unsafe {
                reader
                    .SetStreamSelection(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32, true)
                    .and_then(|()| {
                        reader.SetCurrentMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32, None, &output)
                    })
            };
            match applied {
                Ok(()) => return Ok(reader),
                Err(err) => {
                    last = format!("processing={video_processing} hardware={hardware} NV12 rejected: {err}")
                }
            }
        }
    }
    Err(format!("Could not decode NV12 from {}: {last}", path.display()))
}

/// Deliberately minimal: a partial type with extra attributes set is easy for
/// the decoder to reject outright.
fn nv12_type() -> Result<IMFMediaType, String> {
    unsafe {
        let media_type = MFCreateMediaType().map_err(|err| err.to_string())?;
        media_type
            .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
            .map_err(|err| err.to_string())?;
        media_type
            .SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12)
            .map_err(|err| err.to_string())?;
        Ok(media_type)
    }
}

/// Next decoded NV12 frame, reusing `into` as the destination so a long clip
/// does not allocate a fresh multi-megabyte buffer per frame. Returns the frame
/// size, its row pitch, and the sample duration in 100ns units.
pub(crate) fn read_nv12_sample(
    reader: &IMFSourceReader,
    into: &mut Vec<u8>,
) -> Result<Option<Nv12Info>, String> {
    let mut flags = 0_u32;
    let mut timestamp = 0_i64;
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
            .map_err(|err| err.to_string())?;
    }
    if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
        return Ok(None);
    }
    let Some(sample) = sample else {
        return Ok(None);
    };
    let duration = unsafe { sample.GetSampleDuration().unwrap_or(0) }.max(10_000);
    let (width, height) = frame_size(reader)?;
    let buffer = unsafe { sample.ConvertToContiguousBuffer().map_err(|err| err.to_string())? };
    let mut data = std::ptr::null_mut();
    let mut length = 0_u32;
    unsafe {
        buffer.Lock(&mut data, None, Some(&mut length)).map_err(|err| err.to_string())?;
    }
    if data.is_null() || length == 0 {
        let _ = unsafe { buffer.Unlock() };
        return Ok(None);
    }
    // A contiguous NV12 buffer is luma followed by half-height chroma, so the
    // row pitch falls out of the total length.
    let pitch = ((u64::from(length) * 2) / (u64::from(height.max(1)) * 3)) as u32;
    let pitch = pitch.max(width);
    if (pitch as usize) * (height as usize) * 3 / 2 > length as usize {
        let _ = unsafe { buffer.Unlock() };
        return Err("Decoded NV12 frame was smaller than its frame size.".into());
    }
    into.clear();
    into.extend_from_slice(unsafe { std::slice::from_raw_parts(data, length as usize) });
    unsafe {
        buffer.Unlock().map_err(|err| err.to_string())?;
    }
    Ok(Some(Nv12Info {
        width,
        height,
        pitch,
        duration,
    }))
}

#[derive(Clone, Copy)]
pub(crate) struct Nv12Info {
    pub width: u32,
    pub height: u32,
    pub pitch: u32,
    pub duration: i64,
}

/// Next decoded RGB32 frame plus its source timestamp and duration, in 100ns units.
pub(crate) fn read_rgb_sample(reader: &IMFSourceReader) -> Result<Option<(StillFrame, i64, i64)>, String> {
    let mut flags = 0_u32;
    let mut timestamp = 0_i64;
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
            .map_err(|err| err.to_string())?;
    }
    if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
        return Ok(None);
    }
    let Some(sample) = sample else {
        return Ok(None);
    };
    let duration = unsafe { sample.GetSampleDuration().unwrap_or(0) }.max(10_000);
    let (width, height) = frame_size(reader)?;
    let buffer = unsafe { sample.ConvertToContiguousBuffer().map_err(|err| err.to_string())? };
    let mut data = std::ptr::null_mut();
    let mut length = 0_u32;
    unsafe {
        buffer.Lock(&mut data, None, Some(&mut length)).map_err(|err| err.to_string())?;
    }
    if data.is_null() || length == 0 {
        let _ = unsafe { buffer.Unlock() };
        return Ok(None);
    }
    let pitch = (length / height.max(1)).max(width * 4);
    let bytes = unsafe { std::slice::from_raw_parts(data, length as usize) }.to_vec();
    unsafe {
        buffer.Unlock().map_err(|err| err.to_string())?;
    }
    Ok(Some((
        StillFrame {
            bgra: bytes,
            width,
            height,
            pitch,
        },
        timestamp,
        duration,
    )))
}

fn uncompressed_type(subtype: GUID) -> Result<IMFMediaType, String> {
    unsafe {
        let media_type = MFCreateMediaType().map_err(|err| err.to_string())?;
        media_type
            .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
            .map_err(|err| err.to_string())?;
        media_type
            .SetGUID(&MF_MT_SUBTYPE, &subtype)
            .map_err(|err| err.to_string())?;
        media_type
            .SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)
            .map_err(|err| err.to_string())?;
        Ok(media_type)
    }
}

fn frame_size(reader: &IMFSourceReader) -> Result<(u32, u32), String> {
    unsafe {
        let media_type = reader
            .GetCurrentMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32)
            .map_err(|err| err.to_string())?;
        let packed = media_type.GetUINT64(&MF_MT_FRAME_SIZE).map_err(|err| err.to_string())?;
        Ok(((packed >> 32) as u32, packed as u32))
    }
}
