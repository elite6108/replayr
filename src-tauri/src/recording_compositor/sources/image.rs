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
        format!("Could not load image source '{}'. Use a PNG, JPEG, GIF, or WebP.", spec.name)
    })?;
    let decoded = match kind {
        ImageKind::Png => decode_png(&bytes, &spec.name)?,
        ImageKind::Jpeg => decode_jpeg(&bytes, &spec.name)?,
        ImageKind::Gif | ImageKind::Webp => decode_still(&bytes, kind, &spec.name)?,
    };
    Ok(DecodedImage {
        id: spec.id.clone(),
        bgra: decoded.0,
        width: decoded.1,
        height: decoded.2,
    })
}

#[derive(PartialEq, Eq)]
enum ImageKind {
    Png,
    Jpeg,
    Gif,
    Webp,
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
        "gif" if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") => Some(ImageKind::Gif),
        "webp" if is_webp(bytes) => Some(ImageKind::Webp),
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
    if !crate::paths::is_safe_local_file(&canon) {
        return Err(fail());
    }
    Ok(canon)
}

/// Pixel size of a local PNG or JPEG, read from its header without decoding pixels.
/// Applies the same path, size and dimension limits as `load_image`.
pub fn image_dimensions(raw: &str) -> Option<(u32, u32)> {
    validated_image(raw).map(|(_, width, height)| (width, height))
}

/// Canonical path and pixel size of a local PNG or JPEG that `load_image` would accept.
pub fn validated_image(raw: &str) -> Option<(PathBuf, u32, u32)> {
    let path = validate_local_image_path(raw, "image").ok()?;
    let meta = fs::metadata(&path).ok()?;
    if !meta.is_file() || meta.len() == 0 || meta.len() > MAX_FILE_BYTES {
        return None;
    }
    let bytes = fs::read(&path).ok()?;
    let (width, height) = match image_kind(&path, &bytes)? {
        ImageKind::Png => {
            let decoder = png::Decoder::new(Cursor::new(&bytes));
            let reader = catch_unwind(AssertUnwindSafe(|| decoder.read_info())).ok()?.ok()?;
            (reader.info().width, reader.info().height)
        }
        ImageKind::Jpeg => {
            let mut decoder = jpeg_decoder::Decoder::new(Cursor::new(&bytes));
            catch_unwind(AssertUnwindSafe(|| decoder.read_info())).ok()?.ok()?;
            let info = decoder.info()?;
            (u32::from(info.width), u32::from(info.height))
        }
        ImageKind::Gif | ImageKind::Webp => still_dimensions(&bytes).ok()?,
    };
    check_dims(width, height, "image").ok()?;
    Some((path, width, height))
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

fn is_webp(bytes: &[u8]) -> bool {
    bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP"
}

fn decode_still(bytes: &[u8], kind: ImageKind, name: &str) -> Result<(Vec<u8>, u32, u32), String> {
    let fail = || format!("Could not load image source '{name}'.");
    catch_unwind(AssertUnwindSafe(|| decode_still_inner(bytes, kind, name))).unwrap_or_else(|_| Err(fail()))
}

fn decode_still_inner(bytes: &[u8], kind: ImageKind, name: &str) -> Result<(Vec<u8>, u32, u32), String> {
    let fail = || format!("Could not load image source '{name}'.");
    let format = match kind {
        ImageKind::Gif => image::ImageFormat::Gif,
        ImageKind::Webp => image::ImageFormat::WebP,
        ImageKind::Png | ImageKind::Jpeg => return Err(fail()),
    };
    let (width, height, rgba) = decode_limited(bytes, format).map_err(|_| fail())?;
    check_dims(width, height, name)?;
    Ok((rgba_to_bgra(&rgba), width, height))
}

fn still_dimensions(bytes: &[u8]) -> Result<(u32, u32), String> {
    let format = if bytes.starts_with(b"GIF") {
        image::ImageFormat::Gif
    } else if is_webp(bytes) {
        image::ImageFormat::WebP
    } else {
        return Err("image".into());
    };
    let (width, height, _) = decode_limited(bytes, format)?;
    check_dims(width, height, "image")?;
    Ok((width, height))
}

fn decode_limited(bytes: &[u8], format: image::ImageFormat) -> Result<(u32, u32, Vec<u8>), String> {
    let mut reader = image::ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_DIM);
    limits.max_image_height = Some(MAX_DIM);
    limits.max_alloc = Some(32 * 1024 * 1024);
    reader.limits(limits);
    let image = reader.decode().map_err(|_| "image".to_string())?;
    let width = image.width();
    let height = image.height();
    let rgba = image.into_rgba8().into_raw();
    let expected = (width as usize)
        .checked_mul(height as usize)
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| "image".to_string())?;
    if rgba.len() != expected {
        return Err("image".into());
    }
    Ok((width, height, rgba))
}

/// Extra GIF frames for playback. A still, a WebP, or a file that will not
/// decode safely returns nothing and the first frame stays on screen.
pub struct GifFrames {
    pub bgra: Vec<Vec<u8>>,
    pub delays_ms: Vec<u32>,
    pub width: u32,
    pub height: u32,
}

pub fn load_gif_frames(spec: &ValidatedImage) -> Option<GifFrames> {
    let path = validate_local_image_path(&spec.path, &spec.name).ok()?;
    let bytes = fs::read(&path).ok()?;
    if image_kind(&path, &bytes)? != ImageKind::Gif {
        return None;
    }
    catch_unwind(AssertUnwindSafe(|| gif_frames(&bytes))).ok().flatten()
}

fn gif_frames(bytes: &[u8]) -> Option<GifFrames> {
    use image::AnimationDecoder;
    let decoder = image::codecs::gif::GifDecoder::new(Cursor::new(bytes)).ok()?;
    let mut bgra = Vec::new();
    let mut delays_ms = Vec::new();
    let mut size = None;
    let mut total = 0usize;
    for frame in decoder.into_frames().take(24) {
        let frame = frame.ok()?;
        let (numer, denom) = frame.delay().numer_denom_ms();
        let delay = numer.checked_div(denom.max(1)).unwrap_or(100).clamp(20, 2000);
        let buffer = frame.into_buffer();
        let width = buffer.width();
        let height = buffer.height();
        check_dims(width, height, "image").ok()?;
        match size {
            None => size = Some((width, height)),
            Some(existing) if existing != (width, height) => return None,
            _ => {}
        }
        let raw = buffer.into_raw();
        total = total.saturating_add(raw.len());
        if total > 32 * 1024 * 1024 {
            break;
        }
        bgra.push(rgba_to_bgra(&raw));
        delays_ms.push(delay);
    }
    let (width, height) = size?;
    if bgra.len() < 2 {
        return None;
    }
    Some(GifFrames {
        bgra,
        delays_ms,
        width,
        height,
    })
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
    fn straight_rgba_keeps_transparent_pixels() {
        let bgra = rgba_to_bgra(&[10, 20, 30, 0, 40, 50, 60, 128]);
        assert_eq!(&bgra, &[30, 20, 10, 0, 60, 50, 40, 128]);
    }

    #[test]
    fn jpeg_rgb_is_opaque() {
        let bgra = rgb_to_bgra(&[10, 20, 30]);
        assert_eq!(&bgra, &[30, 20, 10, 255]);
    }

    #[test]
    fn gif_and_webp_need_a_real_header() {
        assert!(decode_still(b"GIF89a", ImageKind::Gif, "Anim").is_err());
        assert!(decode_still(b"RIFF....WEBP", ImageKind::Webp, "Still").is_err());
        assert!(!decode_still(b"GIF89a", ImageKind::Gif, "Anim").unwrap_err().contains('\\'));
    }

    #[test]
    fn a_small_gif_decodes_to_straight_bgra() {
        let image = image::RgbaImage::from_pixel(8, 8, image::Rgba([10, 20, 30, 255]));
        let mut bytes = Vec::new();
        image::DynamicImage::ImageRgba8(image)
            .write_to(&mut Cursor::new(&mut bytes), image::ImageFormat::Gif)
            .unwrap();
        let (bgra, width, height) = decode_still(&bytes, ImageKind::Gif, "Anim").unwrap();
        assert_eq!((width, height), (8, 8));
        assert_eq!(&bgra[..4], &[30, 20, 10, 255]);
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
