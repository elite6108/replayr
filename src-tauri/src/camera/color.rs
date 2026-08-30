//! Preview and record color conversion. Encode prefers NV12/YUY2 and only
//! goes through RGB when the reader cannot output a YUV format.

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

/// Pack YUY2 into NV12 without going through RGB. Width must be even.
pub fn yuy2_to_nv12(src: &[u8], width: u32, height: u32, stride: usize) -> Option<Vec<u8>> {
    let width = width as usize;
    let height = height as usize;
    if width == 0 || height == 0 || width % 2 == 1 || height % 2 == 1 {
        return None;
    }
    let row_bytes = stride.max(width * 2);
    if src.len() < row_bytes.saturating_mul(height) {
        return None;
    }
    let y_size = width * height;
    let mut out = vec![0u8; y_size + y_size / 2];
    for y in 0..height {
        let row = y * row_bytes;
        for x in (0..width).step_by(2) {
            let base = row + x * 2;
            if base + 3 >= src.len() {
                break;
            }
            out[y * width + x] = src[base];
            out[y * width + x + 1] = src[base + 2];
        }
    }
    for y in (0..height).step_by(2) {
        let row = y * row_bytes;
        for x in (0..width).step_by(2) {
            let base = row + x * 2;
            if base + 3 >= src.len() {
                break;
            }
            let uv = y_size + (y / 2) * width + x;
            out[uv] = src[base + 1];
            out[uv + 1] = src[base + 3];
        }
    }
    Some(out)
}

/// Nearest-neighbor scale of packed or strided NV12. Width and height must be even.
pub fn scale_nv12(
    src: &[u8],
    src_w: u32,
    src_h: u32,
    src_stride: usize,
    dst_w: u32,
    dst_h: u32,
) -> Option<Vec<u8>> {
    if src_w == 0
        || src_h == 0
        || dst_w == 0
        || dst_h == 0
        || src_w % 2 == 1
        || src_h % 2 == 1
        || dst_w % 2 == 1
        || dst_h % 2 == 1
    {
        return None;
    }
    let compact = compact_nv12(src, src_w, src_h, src_stride)?;
    if src_w == dst_w && src_h == dst_h {
        return Some(compact);
    }
    let src_w = src_w as usize;
    let src_h = src_h as usize;
    let dst_w = dst_w as usize;
    let dst_h = dst_h as usize;
    let mut out = vec![0u8; dst_w * dst_h * 3 / 2];
    for y in 0..dst_h {
        let sy = y * src_h / dst_h;
        let src_row = sy * src_w;
        let dst_row = y * dst_w;
        for x in 0..dst_w {
            out[dst_row + x] = compact[src_row + x * src_w / dst_w];
        }
    }
    let src_uv = src_w * src_h;
    let dst_uv = dst_w * dst_h;
    for y in 0..dst_h / 2 {
        let sy = y * (src_h / 2) / (dst_h / 2);
        for x in 0..dst_w / 2 {
            let sx = x * (src_w / 2) / (dst_w / 2);
            let src_i = src_uv + sy * src_w + sx * 2;
            let dst_i = dst_uv + y * dst_w + x * 2;
            out[dst_i] = compact[src_i];
            out[dst_i + 1] = compact[src_i + 1];
        }
    }
    Some(out)
}

/// Compact a possibly-strided NV12 buffer to width-pitched NV12.
pub fn compact_nv12(src: &[u8], width: u32, height: u32, stride: usize) -> Option<Vec<u8>> {
    let width = width as usize;
    let height = height as usize;
    if width == 0 || height == 0 || height % 2 == 1 {
        return None;
    }
    let pitch = stride.max(width);
    let y_size = pitch.checked_mul(height)?;
    let uv_size = pitch.checked_mul(height / 2)?;
    if src.len() < y_size + uv_size {
        return None;
    }
    if pitch == width {
        return Some(src[..y_size + uv_size].to_vec());
    }
    let mut out = vec![0u8; width * height * 3 / 2];
    for y in 0..height {
        let src_off = y * pitch;
        let dst_off = y * width;
        out[dst_off..dst_off + width].copy_from_slice(&src[src_off..src_off + width]);
    }
    let src_uv = y_size;
    let dst_uv = width * height;
    for y in 0..height / 2 {
        let src_off = src_uv + y * pitch;
        let dst_off = dst_uv + y * width;
        out[dst_off..dst_off + width].copy_from_slice(&src[src_off..src_off + width]);
    }
    Some(out)
}

/// Convert packed BGRA/RGB32 into NV12. Width and height must be even.
pub fn bgra_to_nv12(src: &[u8], width: u32, height: u32, stride: usize) -> Option<Vec<u8>> {
    let width = width as usize;
    let height = height as usize;
    if width == 0 || height == 0 || width % 2 == 1 || height % 2 == 1 {
        return None;
    }
    let row_bytes = stride.max(width * 4);
    if src.len() < row_bytes.saturating_mul(height) {
        return None;
    }
    let y_size = width * height;
    let mut out = vec![0u8; y_size + y_size / 2];
    for y in 0..height {
        for x in 0..width {
            let i = y * row_bytes + x * 4;
            let (yy, _, _) = rgb_to_yuv(src[i + 2], src[i + 1], src[i]);
            out[y * width + x] = yy;
        }
    }
    for y in (0..height).step_by(2) {
        for x in (0..width).step_by(2) {
            let i = y * row_bytes + x * 4;
            let (_, u, v) = rgb_to_yuv(src[i + 2], src[i + 1], src[i]);
            let uv = y_size + (y / 2) * width + x;
            out[uv] = u;
            out[uv + 1] = v;
        }
    }
    Some(out)
}

pub fn flip_nv12_horizontal(planes: &mut [u8], width: u32, height: u32) {
    let width = width as usize;
    let height = height as usize;
    if width < 2 || height < 2 || planes.len() < width * height * 3 / 2 {
        return;
    }
    for y in 0..height {
        let row = y * width;
        for x in 0..width / 2 {
            planes.swap(row + x, row + width - 1 - x);
        }
    }
    let uv = width * height;
    let pairs = width / 2;
    for y in 0..height / 2 {
        let row = uv + y * width;
        for i in 0..pairs / 2 {
            let left = row + i * 2;
            let right = row + (pairs - 1 - i) * 2;
            planes.swap(left, right);
            planes.swap(left + 1, right + 1);
        }
    }
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
        writer
            .write_image_data(&rgb)
            .map_err(|err| err.to_string())?;
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

pub fn rgb_to_yuv(r: u8, g: u8, b: u8) -> (u8, u8, u8) {
    let r = i32::from(r);
    let g = i32::from(g);
    let b = i32::from(b);
    let y = ((66 * r + 129 * g + 25 * b + 128) >> 8) + 16;
    let u = ((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128;
    let v = ((112 * r - 94 * g - 18 * b + 128) >> 8) + 128;
    (clamp_u8(y), clamp_u8(u), clamp_u8(v))
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
        let mut pixels = vec![1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255];
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
    fn yuy2_compacts_to_nv12_with_even_dims() {
        let yuy2 = vec![
            16u8, 128, 32, 128, 16, 128, 32, 128, 16, 128, 32, 128, 16, 128, 32, 128,
        ];
        let nv12 = yuy2_to_nv12(&yuy2, 2, 2, 4).unwrap();
        assert_eq!(nv12.len(), 6);
        assert_eq!(nv12[0], 16);
        assert_eq!(nv12[1], 32);
    }

    #[test]
    fn nv12_flip_swaps_luma() {
        let mut nv12 = vec![1u8, 2, 3, 4, 128, 129];
        flip_nv12_horizontal(&mut nv12, 2, 2);
        assert_eq!(&nv12[0..4], &[2, 1, 4, 3]);
    }

    #[test]
    fn compact_nv12_and_bgra_round_trip_size() {
        let nv12 = vec![16u8, 16, 16, 16, 128, 128];
        let compact = compact_nv12(&nv12, 2, 2, 2).unwrap();
        assert_eq!(compact.len(), 6);
        let bgra = vec![
            0u8, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255,
        ];
        let converted = bgra_to_nv12(&bgra, 2, 2, 8).unwrap();
        assert_eq!(converted.len(), 6);
    }

    #[test]
    fn scale_nv12_keeps_same_size() {
        let src = vec![16u8, 32, 48, 64, 80, 96];
        let out = scale_nv12(&src, 2, 2, 2, 2, 2).unwrap();
        assert_eq!(out, src);
    }

    #[test]
    fn scale_nv12_doubles_even_gray() {
        let src = vec![40u8, 40, 40, 40, 128, 128];
        let out = scale_nv12(&src, 2, 2, 2, 4, 4).unwrap();
        assert_eq!(out.len(), 24);
        assert!(out[..16].iter().all(|value| *value == 40));
        assert!(out[16..].iter().all(|value| *value == 128));
    }

    #[test]
    fn scale_nv12_rejects_odd_dims() {
        assert!(scale_nv12(&[0u8; 6], 2, 2, 2, 3, 2).is_none());
    }

    #[test]
    fn png_and_base64_round_trip_length() {
        let pixels = vec![
            0u8, 0, 255, 255, 0, 255, 0, 255, 255, 0, 0, 255, 255, 255, 255, 255,
        ];
        let png = encode_png_bgra(&pixels, 2, 2).unwrap();
        assert!(png.starts_with(&[137, 80, 78, 71]));
        let encoded = base64_encode(&png);
        assert_eq!(encoded.len() % 4, 0);
        assert!(!encoded.is_empty());
    }
}
