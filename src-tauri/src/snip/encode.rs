//! Encoding a cropped screenshot.

use std::io::Cursor;

use crate::still::StillFrame;

/// Longest edge of the library thumbnail.
const THUMB_MAX_WIDTH: u32 = 480;
const THUMB_JPEG_QUALITY: u8 = 82;

/// Lossless PNG of a tightly packed BGRA frame.
///
/// Uses the balanced compression level rather than the preview path's `Fast`: a screenshot is
/// encoded once and then uploaded, and a noticeably smaller file gets the share link onto the
/// clipboard sooner than the extra tens of milliseconds of encoding cost.
pub fn png(frame: &StillFrame) -> Result<Vec<u8>, String> {
    let (width, height) = (frame.width, frame.height);
    let pixels = width as usize * height as usize;
    if width == 0 || height == 0 || frame.pitch != width * 4 || frame.bgra.len() < pixels * 4 {
        return Err("The screenshot frame was incomplete.".into());
    }
    let mut rgb = vec![0u8; pixels * 3];
    for (src, dst) in frame.bgra.chunks_exact(4).zip(rgb.chunks_exact_mut(3)) {
        dst[0] = src[2];
        dst[1] = src[1];
        dst[2] = src[0];
    }
    let mut encoded = Vec::new();
    {
        let mut encoder = png::Encoder::new(Cursor::new(&mut encoded), width, height);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Default);
        let mut writer = encoder.write_header().map_err(|err| err.to_string())?;
        writer.write_image_data(&rgb).map_err(|err| err.to_string())?;
    }
    Ok(encoded)
}

/// Largest screenshot the Library will decode for "copy image". Well above any real monitor, and
/// a hard stop against a corrupted or swapped file claiming absurd dimensions.
const MAX_DECODE_PIXELS: u64 = 16384 * 16384;

/// Decode a saved screenshot back into a tightly packed BGRA frame, for copying it again later.
pub fn decode_png(bytes: &[u8]) -> Result<StillFrame, String> {
    let mut decoder = png::Decoder::new(Cursor::new(bytes));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info().map_err(|err| format!("Could not read the screenshot: {err}"))?;
    let (width, height) = {
        let info = reader.info();
        (info.width, info.height)
    };
    if width == 0 || height == 0 || width as u64 * height as u64 > MAX_DECODE_PIXELS {
        return Err("The screenshot has unsupported dimensions.".into());
    }
    let mut buf = vec![0u8; reader.output_buffer_size()];
    let output = reader.next_frame(&mut buf).map_err(|err| format!("Could not read the screenshot: {err}"))?;
    let channels = match output.color_type {
        png::ColorType::Rgb => 3,
        png::ColorType::Rgba => 4,
        png::ColorType::Grayscale => 1,
        png::ColorType::GrayscaleAlpha => 2,
        png::ColorType::Indexed => return Err("Indexed screenshots are not supported.".into()),
    };
    let pixels = width as usize * height as usize;
    let mut bgra = Vec::with_capacity(pixels * 4);
    for px in buf[..pixels * channels].chunks_exact(channels) {
        let (r, g, b) = match channels {
            1 | 2 => (px[0], px[0], px[0]),
            _ => (px[0], px[1], px[2]),
        };
        bgra.extend_from_slice(&[b, g, r, 0xFF]);
    }
    Ok(StillFrame { bgra, width, height, pitch: width * 4 })
}

/// Small JPEG for the Library grid.
pub fn thumbnail(frame: &StillFrame) -> Result<Vec<u8>, String> {
    let scaled = if frame.width > THUMB_MAX_WIDTH {
        crate::still::scale_bgra(frame, THUMB_MAX_WIDTH)
    } else {
        frame.clone()
    };
    crate::camera::color::encode_jpeg_bgra_quality(
        &scaled.bgra,
        scaled.width,
        scaled.height,
        THUMB_JPEG_QUALITY,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(width: u32, height: u32, bgra: [u8; 4]) -> StillFrame {
        StillFrame {
            bgra: bgra.repeat((width * height) as usize),
            width,
            height,
            pitch: width * 4,
        }
    }

    #[test]
    fn png_round_trips_dimensions_and_colour() {
        let frame = solid(7, 5, [10, 20, 30, 255]);
        let bytes = png(&frame).unwrap();
        let decoder = png::Decoder::new(Cursor::new(bytes));
        let mut reader = decoder.read_info().unwrap();
        let info = reader.info();
        assert_eq!((info.width, info.height), (7, 5));
        let mut buf = vec![0; reader.output_buffer_size()];
        reader.next_frame(&mut buf).unwrap();
        // BGRA [10, 20, 30] is RGB [30, 20, 10].
        assert_eq!(&buf[0..3], &[30, 20, 10]);
    }

    #[test]
    fn decode_png_round_trips_an_encoded_screenshot() {
        let frame = solid(9, 4, [40, 50, 60, 255]);
        let decoded = decode_png(&png(&frame).unwrap()).unwrap();
        assert_eq!((decoded.width, decoded.height, decoded.pitch), (9, 4, 36));
        assert_eq!(&decoded.bgra[0..4], &[40, 50, 60, 255]);
    }

    #[test]
    fn decode_png_rejects_garbage() {
        assert!(decode_png(b"not a png at all").is_err());
    }

    #[test]
    fn png_rejects_padded_or_short_frames() {
        let mut padded = solid(4, 4, [0, 0, 0, 255]);
        padded.pitch = 20;
        assert!(png(&padded).is_err(), "crop output is always tightly packed");
        let mut short = solid(4, 4, [0, 0, 0, 255]);
        short.bgra.truncate(8);
        assert!(png(&short).is_err());
    }
}
