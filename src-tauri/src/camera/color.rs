//! Bounded preview color conversion. Recording later prefers NV12/YUY2 and
//! only converts when the preview or a fallback encoder needs RGB.

use std::io::Cursor;

pub fn nv12_to_bgra(src: &[u8], width: u32, height: u32, stride: usize) -> Option<Vec<u8>> {
    let width = width as usize;
    let height = height as usize;
    if width == 0 || height == 0 || height % 2 == 1 {
        return None;
    }
    let y_size = stride.checked_mul(height)?;
    let uv_stride = stride;
    let uv_size = uv_stride.checked_mul(height / 2)?;
    if src.len() < y_size + uv_size {
        return None;
    }
    let y_plane = &src[..y_size];
    let uv_plane = &src[y_size..y_size + uv_size];
    let mut out = vec![0u8; width * height * 4];
    for y in 0..height {
        let y_row = y * stride;
        let uv_row = (y / 2) * uv_stride;
        for x in 0..width {
            let y_val = y_plane[y_row + x] as i32;
            let uv_index = uv_row + (x & !1);
            let u = uv_plane[uv_index] as i32 - 128;
            let v = uv_plane[uv_index + 1] as i32 - 128;
            let (r, g, b) = yuv_to_rgb(y_val, u, v);
            let dst = (y * width + x) * 4;
            out[dst] = b;
            out[dst + 1] = g;
            out[dst + 2] = r;
            out[dst + 3] = 255;
        }
    }
    Some(out)
}

pub fn yuy2_to_bgra(src: &[u8], width: u32, height: u32, stride: usize) -> Option<Vec<u8>> {
    let width = width as usize;
    let height = height as usize;
    if width == 0 || height == 0 {
        return None;
    }
    let row_bytes = stride.max(width * 2);
    if src.len() < row_bytes.saturating_mul(height) {
        return None;
    }
    let mut out = vec![0u8; width * height * 4];
    for y in 0..height {
        let row = y * row_bytes;
        for x in (0..width).step_by(2) {
            let base = row + x * 2;
            if base + 3 >= src.len() {
                break;
            }
            let y0 = src[base] as i32;
            let u = src[base + 1] as i32 - 128;
            let y1 = src[base + 2] as i32;
            let v = src[base + 3] as i32 - 128;
            write_bgra(&mut out, width, x, y, yuv_to_rgb(y0, u, v));
            if x + 1 < width {
                write_bgra(&mut out, width, x + 1, y, yuv_to_rgb(y1, u, v));
            }
        }
    }
    Some(out)
}

pub fn rgb32_to_bgra(src: &[u8], width: u32, height: u32, stride: usize) -> Option<Vec<u8>> {
    let width = width as usize;
    let height = height as usize;
    if width == 0 || height == 0 {
        return None;
    }
    let row_bytes = stride.max(width * 4);
    if src.len() < row_bytes.saturating_mul(height) {
        return None;
    }
    let mut out = vec![0u8; width * height * 4];
    for y in 0..height {
        let src_row = &src[y * row_bytes..y * row_bytes + width * 4];
        let dst_row = &mut out[y * width * 4..(y + 1) * width * 4];
        dst_row.copy_from_slice(src_row);
    }
    Some(out)
}

pub fn flip_bgra_horizontal(pixels: &mut [u8], width: u32, height: u32) {
    let width = width as usize;
    let height = height as usize;
    if width == 0 {
        return;
    }
    for y in 0..height {
        let row = y * width * 4;
        for x in 0..width / 2 {
            let left = row + x * 4;
            let right = row + (width - 1 - x) * 4;
            for channel in 0..4 {
                pixels.swap(left + channel, right + channel);
            }
        }
    }
}

pub fn encode_png_bgra(pixels: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    let width_us = width as usize;
    let expected = width_us.saturating_mul(height as usize).saturating_mul(4);
    if pixels.len() < expected || width == 0 || height == 0 {
        return Err("Preview frame was incomplete.".into());
    }
    let mut rgb = vec![0u8; width_us * height as usize * 3];
    for (src, dst) in pixels.chunks_exact(4).zip(rgb.chunks_exact_mut(3)) {
        dst[0] = src[2];
        dst[1] = src[1];
        dst[2] = src[0];
    }
    let mut encoded = Vec::new();
    {
        let mut encoder = png::Encoder::new(Cursor::new(&mut encoded), width, height);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Fast);
        let mut writer = encoder.write_header().map_err(|err| err.to_string())?;
        writer.write_image_data(&rgb).map_err(|err| err.to_string())?;
    }
    Ok(encoded)
}

pub fn base64_encode(data: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((triple >> 18) & 63) as usize] as char);
        out.push(TABLE[((triple >> 12) & 63) as usize] as char);
        if chunk.len() > 1 {
            out.push(TABLE[((triple >> 6) & 63) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(TABLE[(triple & 63) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

fn yuv_to_rgb(y: i32, u: i32, v: i32) -> (u8, u8, u8) {
    let r = y + (359 * v) / 256;
    let g = y - (88 * u) / 256 - (183 * v) / 256;
    let b = y + (454 * u) / 256;
    (clamp_u8(r), clamp_u8(g), clamp_u8(b))
}

fn write_bgra(out: &mut [u8], width: usize, x: usize, y: usize, rgb: (u8, u8, u8)) {
    let dst = (y * width + x) * 4;
    out[dst] = rgb.2;
    out[dst + 1] = rgb.1;
    out[dst + 2] = rgb.0;
    out[dst + 3] = 255;
}

fn clamp_u8(value: i32) -> u8 {
    value.clamp(0, 255) as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nv12_gray_becomes_opaque_bgra() {
        let width = 2u32;
        let height = 2u32;
        let mut src = vec![16u8; 6];
        src[0] = 128;
        src[1] = 128;
        src[2] = 128;
        src[3] = 128;
        src[4] = 128;
        src[5] = 128;
        let bgra = nv12_to_bgra(&src, width, height, 2).unwrap();
        assert_eq!(bgra.len(), 16);
        assert_eq!(bgra[3], 255);
    }

    #[test]
    fn horizontal_flip_swaps_pixels() {
        let mut pixels = vec![
            1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255,
        ];
        flip_bgra_horizontal(&mut pixels, 2, 2);
        assert_eq!(&pixels[0..4], &[4, 5, 6, 255]);
        assert_eq!(&pixels[4..8], &[1, 2, 3, 255]);
    }

    #[test]
    fn yuy2_and_rgb32_convert_to_opaque_bgra() {
        let yuy2 = vec![128, 128, 128, 128, 128, 128, 128, 128];
        let bgra = yuy2_to_bgra(&yuy2, 2, 2, 4).unwrap();
        assert_eq!(bgra.len(), 16);
        assert_eq!(bgra[3], 255);
        let rgb = vec![1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255];
        let copied = rgb32_to_bgra(&rgb, 2, 2, 8).unwrap();
        assert_eq!(&copied[0..4], &[1, 2, 3, 255]);
    }

    #[test]
    fn png_and_base64_round_trip_length() {
        let pixels = vec![0u8, 0, 255, 255, 0, 255, 0, 255, 255, 0, 0, 255, 255, 255, 255, 255];
        let png = encode_png_bgra(&pixels, 2, 2).unwrap();
        assert!(png.starts_with(&[137, 80, 78, 71]));
        let encoded = base64_encode(&png);
        assert_eq!(encoded.len() % 4, 0);
        assert!(!encoded.is_empty());
    }
}
