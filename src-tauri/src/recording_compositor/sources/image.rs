//! Session-cached image decode. Path is untrusted IPC input.
//! Output is straight BGRA. See `sources/mod.rs`.

#![cfg(windows)]

use std::fs;
use std::io::Cursor;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};

use super::super::scene::ValidatedImage;

const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_DIM: u32 = 4096;
const MAX_PIXELS: u32 = 8_294_400;

pub struct DecodedImage {
    pub id: String,
    pub bgra: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

pub fn load_image(spec: &ValidatedImage) -> Result<DecodedImage, String> {
    let path = validate_local_image_path(&spec.path, &spec.name)?;
    let meta = fs::metadata(&path).map_err(|_| format!("Could not load image source '{}'.", spec.name))?;
    if !meta.is_file() {
        return Err(format!("Could not load image source '{}'.", spec.name));
    }
    if meta.len() == 0 || meta.len() > MAX_FILE_BYTES {
        return Err(format!("Could not load image source '{}'.", spec.name));
    }
    let bytes = fs::read(&path).map_err(|_| format!("Could not load image source '{}'.", spec.name))?;
    let kind = image_kind(&path, &bytes).ok_or_else(|| {
        format!("Could not load image source '{}'. Use a PNG or JPEG.", spec.name)
    })?;
    let decoded = match kind {
        ImageKind::Png => decode_png(&bytes, &spec.name)?,
        ImageKind::Jpeg => decode_jpeg(&bytes, &spec.name)?,
    };
    Ok(DecodedImage {
        id: spec.id.clone(),
        bgra: decoded.0,
        width: decoded.1,
        height: decoded.2,
    })
}

enum ImageKind {
    Png,
    Jpeg,
}

fn image_kind(path: &Path, bytes: &[u8]) -> Option<ImageKind> {
    let ext = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" if bytes.starts_with(&[0x89, b'P', b'N', b'G']) => Some(ImageKind::Png),
        "jpg" | "jpeg" if bytes.len() > 2 && bytes[0] == 0xFF && bytes[1] == 0xD8 => Some(ImageKind::Jpeg),
        _ => None,
    }
}

fn validate_local_image_path(raw: &str, name: &str) -> Result<PathBuf, String> {
    let fail = || format!("Could not load image source '{name}'.");
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        return Err(fail());
    }
    let canon = path.canonicalize().map_err(|_| fail())?;
    if !is_safe_local_file(&canon) {
        return Err(fail());
    }
    Ok(canon)
}

fn is_safe_local_file(path: &Path) -> bool {
    let raw = path.to_string_lossy();
    let stripped = raw
        .strip_prefix(r"\\?\")
        .unwrap_or(raw.as_ref());
    if stripped.starts_with(r"UNC\") || stripped.starts_with(r"\\") {
        return false;
    }
    if stripped.starts_with(r"\\.\") || stripped.contains(r"\\.\") {
        return false;
    }
    let stem = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("")
        .to_ascii_uppercase();
    !matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "COM1" | "COM2" | "COM3" | "COM4" | "LPT1" | "LPT2"
    )
}

fn decode_png(bytes: &[u8], name: &str) -> Result<(Vec<u8>, u32, u32), String> {
    let fail = || format!("Could not load image source '{name}'.");
    catch_unwind(AssertUnwindSafe(|| decode_png_inner(bytes, name))).unwrap_or_else(|_| Err(fail()))
}

fn decode_png_inner(bytes: &[u8], name: &str) -> Result<(Vec<u8>, u32, u32), String> {
    let fail = || format!("Could not load image source '{name}'.");
    let mut decoder = png::Decoder::new(Cursor::new(bytes));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info().map_err(|_| fail())?;
    let info = reader.info();
    let width = info.width;
    let height = info.height;
    check_dims(width, height, name)?;
    let expected = (width as usize)
        .checked_mul(height as usize)
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(fail)?;
    let buf_len = reader.output_buffer_size();
    if buf_len == 0 || buf_len > expected.max((MAX_PIXELS as usize).saturating_mul(4)) {
        return Err(fail());
    }
    let mut buf = vec![0u8; buf_len];
    let frame = reader.next_frame(&mut buf).map_err(|_| fail())?;
    if frame.buffer_size() > buf_len {
        return Err(fail());
    }
    let src = &buf[..frame.buffer_size()];
    let bgra = match frame.color_type {
        png::ColorType::Rgba => rgba_to_bgra(src),
        png::ColorType::Rgb => rgb_to_bgra(src),
        png::ColorType::Grayscale => gray_to_bgra(src),
        png::ColorType::GrayscaleAlpha => gray_alpha_to_bgra(src),
        png::ColorType::Indexed => return Err(fail()),
    };
    Ok((bgra, width, height))
}

fn decode_jpeg(bytes: &[u8], name: &str) -> Result<(Vec<u8>, u32, u32), String> {
    let fail = || format!("Could not load image source '{name}'.");
    catch_unwind(AssertUnwindSafe(|| decode_jpeg_inner(bytes, name))).unwrap_or_else(|_| Err(fail()))
}

fn decode_jpeg_inner(bytes: &[u8], name: &str) -> Result<(Vec<u8>, u32, u32), String> {
    let fail = || format!("Could not load image source '{name}'.");
    let mut decoder = jpeg_decoder::Decoder::new(Cursor::new(bytes));
    decoder.read_info().map_err(|_| fail())?;
    let info = decoder.info().ok_or_else(fail)?;
    let width = info.width as u32;
    let height = info.height as u32;
    check_dims(width, height, name)?;
    let pixels = decoder.decode().map_err(|_| fail())?;
    let bgra = match info.pixel_format {
        jpeg_decoder::PixelFormat::RGB24 => rgb_to_bgra(&pixels),
        jpeg_decoder::PixelFormat::L8 => gray_to_bgra(&pixels),
        jpeg_decoder::PixelFormat::CMYK32 => return Err(fail()),
        _ => return Err(fail()),
    };
    Ok((bgra, width, height))
}

pub(crate) fn check_dims(width: u32, height: u32, name: &str) -> Result<(), String> {
    if width < 2 || height < 2 || width > MAX_DIM || height > MAX_DIM {
        return Err(format!("Could not load image source '{name}'."));
    }
    let pixels = width
        .checked_mul(height)
        .ok_or_else(|| format!("Could not load image source '{name}'."))?;
    if pixels > MAX_PIXELS {
        return Err(format!("Could not load image source '{name}'."));
    }
    let _bytes = pixels
        .checked_mul(4)
        .ok_or_else(|| format!("Could not load image source '{name}'."))?;
    Ok(())
}

fn rgba_to_bgra(src: &[u8]) -> Vec<u8> {
    src.chunks_exact(4)
        .flat_map(|px| [px[2], px[1], px[0], px[3]])
        .collect()
}

fn rgb_to_bgra(src: &[u8]) -> Vec<u8> {
    src.chunks_exact(3)
        .flat_map(|px| [px[2], px[1], px[0], 255])
        .collect()
}

fn gray_to_bgra(src: &[u8]) -> Vec<u8> {
    src.iter().flat_map(|v| [*v, *v, *v, 255]).collect()
}

fn gray_alpha_to_bgra(src: &[u8]) -> Vec<u8> {
    src.chunks_exact(2)
        .flat_map(|px| [px[0], px[0], px[0], px[1]])
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_huge_claimed_dimensions() {
        assert!(check_dims(100_000, 100_000, "Huge").is_err());
        assert!(check_dims(4097, 2, "Wide").is_err());
        assert!(check_dims(3840, 2160, "UHD").is_ok());
        assert!(check_dims(1, 1, "Tiny").is_err());
    }

    #[test]
    fn truncated_png_is_a_source_error() {
        let err = decode_png(&[0x89, b'P', b'N', b'G', 0x0D], "Logo").unwrap_err();
        assert!(err.contains("Logo"));
        assert!(!err.contains('\\'));
    }

    #[test]
    fn corrupt_jpeg_header_is_a_source_error() {
        let err = decode_jpeg(&[0xFF, 0xD8, 0x00], "Cam").unwrap_err();
        assert!(err.contains("Cam"));
    }

    #[test]
    fn png_ihdr_overflow_is_rejected_before_giant_alloc() {
        // Valid PNG signature + IHDR claiming 65535×65535, no pixel data.
        let mut bytes = vec![
            0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, b'I', b'H',
            b'D', b'R', 0x00, 0x00, 0xFF, 0xFF, 0x00, 0x00, 0xFF, 0xFF, 0x08, 0x06, 0x00, 0x00,
            0x00,
        ];
        bytes.extend_from_slice(&[0, 0, 0, 0]);
        assert!(decode_png(&bytes, "Bomb").is_err());
    }
}
