use std::path::Path;

use windows::core::PCWSTR;
use windows::Win32::Media::MediaFoundation::{
    IMFMediaType, IMFSample, IMFSourceReader, MFCreateAttributes, MFCreateMediaType, MFCreateSourceReaderFromURL,
    MFStartup, MFMediaType_Video, MFVideoFormat_RGB32, MFVideoInterlace_Progressive, MF_MT_FRAME_SIZE,
    MF_MT_INTERLACE_MODE, MF_MT_MAJOR_TYPE, MF_MT_SUBTYPE, MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS,
    MF_SOURCE_READERF_ENDOFSTREAM, MF_SOURCE_READER_FIRST_VIDEO_STREAM, MFSTARTUP_FULL, MF_VERSION,
};

use crate::still::{scale_bgra, write_bgra_bmp, StillFrame};

fn wide_path(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
}

pub fn from_video(source: &Path, dest: &Path) -> Result<(), String> {
    unsafe {
        MFStartup(MF_VERSION, MFSTARTUP_FULL).map_err(|err| err.to_string())?;
    }
    let reader = open_reader(source)?;
    let rgb = rgb32_type()?;
    unsafe {
        reader
            .SetStreamSelection(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32, true)
            .map_err(|err| err.to_string())?;
        reader
            .SetCurrentMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32, None, &rgb)
            .map_err(|err| format!("Could not decode a thumbnail frame: {err}"))?;
    }
    let mut frame = None;
    for _ in 0..24 {
        if let Some(next) = read_frame(&reader)? {
            frame = Some(next);
        } else {
            break;
        }
    }
    let frame = frame.ok_or_else(|| "Could not decode a thumbnail frame.".to_string())?;
    let thumb = scale_bgra(&frame, 480);
    write_bgra_bmp(dest, &thumb)
}

fn open_reader(path: &Path) -> Result<IMFSourceReader, String> {
    let wide = wide_path(path);
    unsafe {
        let mut attrs = None;
        MFCreateAttributes(&mut attrs, 1).map_err(|err| err.to_string())?;
        if let Some(attrs) = attrs.as_ref() {
            let _ = attrs.SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1);
        }
        MFCreateSourceReaderFromURL(PCWSTR(wide.as_ptr()), attrs.as_ref())
            .map_err(|err| format!("Could not open {}: {err}", path.display()))
    }
}

fn rgb32_type() -> Result<IMFMediaType, String> {
    unsafe {
        let media_type = MFCreateMediaType().map_err(|err| err.to_string())?;
        media_type
            .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
            .map_err(|err| err.to_string())?;
        media_type
            .SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_RGB32)
            .map_err(|err| err.to_string())?;
        media_type
            .SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)
            .map_err(|err| err.to_string())?;
        Ok(media_type)
    }
}

fn read_frame(reader: &IMFSourceReader) -> Result<Option<StillFrame>, String> {
    let mut flags = 0_u32;
    let mut sample: Option<IMFSample> = None;
    unsafe {
        reader
            .ReadSample(
                MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32,
                0,
                None,
                Some(&mut flags),
                None,
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
    Ok(Some(StillFrame {
        bgra: bytes,
        width,
        height,
        pitch,
    }))
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
