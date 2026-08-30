use std::collections::HashMap;
use std::fs::File;
use std::io::{Cursor, Write};
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};

#[derive(Debug, Clone)]
pub struct StillFrame {
    pub bgra: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub pitch: u32,
}

pub fn write_bgra_bmp(path: &Path, frame: &StillFrame) -> Result<(), String> {
    let width = frame.width;
    let height = frame.height;
    let row_stride = ((width * 4 + 3) / 4) * 4;
    let pixel_bytes = row_stride * height;
    let file_size = 54 + pixel_bytes;
    let mut bytes = Vec::with_capacity(file_size as usize);
    bytes.extend_from_slice(b"BM");
    bytes.extend_from_slice(&file_size.to_le_bytes());
    bytes.extend_from_slice(&0u16.to_le_bytes());
    bytes.extend_from_slice(&0u16.to_le_bytes());
    bytes.extend_from_slice(&54u32.to_le_bytes());
    bytes.extend_from_slice(&40u32.to_le_bytes());
    bytes.extend_from_slice(&width.to_le_bytes());
    bytes.extend_from_slice(&height.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&32u16.to_le_bytes());
    bytes.extend_from_slice(&0u32.to_le_bytes());
    bytes.extend_from_slice(&pixel_bytes.to_le_bytes());
    bytes.extend_from_slice(&0u32.to_le_bytes());
    bytes.extend_from_slice(&0u32.to_le_bytes());
    bytes.extend_from_slice(&0u32.to_le_bytes());
    bytes.extend_from_slice(&0u32.to_le_bytes());

    let copy_width = (width as usize) * 4;
    let src_pitch = frame.pitch as usize;
    for y in (0..height as usize).rev() {
        let src = y * src_pitch;
        let start = bytes.len();
        if src + copy_width <= frame.bgra.len() {
            bytes.extend_from_slice(&frame.bgra[src..src + copy_width]);
        } else {
            bytes.resize(bytes.len() + copy_width, 0);
        }
        // MF RGB32 often stores 0 in the unused alpha byte. Chromium treats that as
        // fully transparent, so canvas tiles (and some <img> decodes) look black.
        for px in bytes[start..].chunks_exact_mut(4) {
            px[3] = 255;
        }
        bytes.resize(
            bytes.len() + (row_stride as usize).saturating_sub(copy_width),
            0,
        );
    }

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let mut file = File::create(path).map_err(|err| err.to_string())?;
    file.write_all(&bytes).map_err(|err| err.to_string())?;
    Ok(())
}

/// 9:16 crop window inside `width`×`height`. `pan` 0 is left, 1 is right;
/// vertical framing stays centered. Sources already near 9:16 are used whole.
pub fn crop_window_9x16(width: u32, height: u32, pan: f32) -> (u32, u32, u32, u32) {
    let width = width.max(1);
    let height = height.max(1);
    let pan = pan.clamp(0.0, 1.0);
    let src = width as f32 / height as f32;
    let target = 9.0 / 16.0;
    if (src - target).abs() / target < 0.02 {
        return (0, 0, width, height);
    }
    if src > target {
        let crop_w = ((height as f32) * target).round() as u32;
        let crop_w = crop_w.clamp(1, width);
        let max_x = width - crop_w;
        let crop_x = ((max_x as f32) * pan).round() as u32;
        (crop_x.min(max_x), 0, crop_w, height)
    } else {
        let crop_h = ((width as f32) / target).round() as u32;
        let crop_h = crop_h.clamp(1, height);
        let max_y = height - crop_h;
        (0, max_y / 2, width, crop_h)
    }
}

/// Crops a 9:16 window then nearest-neighbor scales to `out_width`×`out_height`.
pub fn crop_and_scale_9x16(
    frame: &StillFrame,
    pan: f32,
    out_width: u32,
    out_height: u32,
) -> StillFrame {
    let out_width = out_width.max(1);
    let out_height = out_height.max(1);
    let (x, y, crop_w, crop_h) = crop_window_9x16(frame.width, frame.height, pan);
    let dst_pitch = out_width * 4;
    let mut bgra = vec![0_u8; (dst_pitch * out_height) as usize];
    let src_pitch = frame.pitch;
    for dest_y in 0..out_height {
        let src_y = y + dest_y * crop_h / out_height;
        for dest_x in 0..out_width {
            let src_x = x + dest_x * crop_w / out_width;
            let src = (src_y * src_pitch + src_x * 4) as usize;
            let dst = (dest_y * dst_pitch + dest_x * 4) as usize;
            if src + 4 <= frame.bgra.len() && dst + 4 <= bgra.len() {
                bgra[dst..dst + 4].copy_from_slice(&frame.bgra[src..src + 4]);
            }
        }
    }
    StillFrame {
        bgra,
        width: out_width,
        height: out_height,
        pitch: dst_pitch,
    }
}

struct WatermarkLogo {
    width: u32,
    height: u32,
    rgba: Vec<u8>,
}

fn watermark_logo() -> Option<&'static WatermarkLogo> {
    static LOGO: OnceLock<Option<WatermarkLogo>> = OnceLock::new();
    LOGO.get_or_init(load_watermark_logo).as_ref()
}

fn load_watermark_logo() -> Option<WatermarkLogo> {
    decode_watermark_png(include_bytes!("../assets/replayr-watermark.png"))
}

fn decode_watermark_png(bytes: &[u8]) -> Option<WatermarkLogo> {
    let mut decoder = png::Decoder::new(Cursor::new(bytes));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info().ok()?;
    let mut buf = vec![0; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).ok()?;
    let src = &buf[..info.buffer_size()];
    let rgba = match info.color_type {
        png::ColorType::Rgba => src.to_vec(),
        png::ColorType::Rgb => src
            .chunks_exact(3)
            .flat_map(|px| [px[0], px[1], px[2], 255])
            .collect(),
        png::ColorType::Grayscale => src.iter().flat_map(|v| [*v, *v, *v, 255]).collect(),
        png::ColorType::GrayscaleAlpha => src
            .chunks_exact(2)
            .flat_map(|px| [px[0], px[0], px[0], px[1]])
            .collect(),
        png::ColorType::Indexed => return None,
    };
    if rgba.len()
        < (info.width as usize)
            .saturating_mul(info.height as usize)
            .saturating_mul(4)
    {
        return None;
    }
    Some(WatermarkLogo {
        width: info.width,
        height: info.height,
        rgba,
    })
}

/// Where the bottom-right logo lands for a frame of this size, as
/// `(origin_x, origin_y, mark_w, mark_h)`.
fn watermark_box(
    width: u32,
    height: u32,
    logo: &WatermarkLogo,
) -> Option<(usize, usize, usize, usize)> {
    if width < 64 || height < 32 || logo.width == 0 || logo.height == 0 {
        return None;
    }
    let short = width.min(height) as usize;
    let margin = (short / 40).max(12);
    let mark_w = (width as usize * 20 / 100).clamp(110, 320);
    let mark_h = (mark_w * logo.height as usize / logo.width as usize).max(1);
    if mark_w + margin >= width as usize || mark_h + margin >= height as usize {
        return None;
    }
    Some((
        width as usize - mark_w - margin,
        height as usize - mark_h - margin,
        mark_w,
        mark_h,
    ))
}

/// Bottom-right Replayr logo. Leaves the source buffer owned.
pub fn composite_watermark(frame: &mut StillFrame) {
    let Some(logo) = watermark_logo() else {
        return;
    };
    let Some((origin_x, origin_y, mark_w, mark_h)) = watermark_box(frame.width, frame.height, logo)
    else {
        return;
    };
    blit_logo(frame, origin_x, origin_y, mark_w, mark_h, logo);
}

fn blit_logo(
    frame: &mut StillFrame,
    origin_x: usize,
    origin_y: usize,
    mark_w: usize,
    mark_h: usize,
    logo: &WatermarkLogo,
) {
    let pitch = frame.pitch as usize;
    let src_w = logo.width as usize;
    let src_h = logo.height as usize;
    for dy in 0..mark_h {
        let sy = dy * src_h / mark_h;
        for dx in 0..mark_w {
            let sx = dx * src_w / mark_w;
            let i = (sy * src_w + sx) * 4;
            if i + 3 >= logo.rgba.len() {
                continue;
            }
            let alpha = logo.rgba[i + 3];
            if alpha < 16 {
                continue;
            }
            let b = logo.rgba[i + 2];
            let g = logo.rgba[i + 1];
            let r = logo.rgba[i];
            if r < 18 && g < 18 && b < 18 {
                continue;
            }
            blend_pixel(frame, pitch, origin_x + dx, origin_y + dy, [b, g, r, alpha]);
        }
    }
}

/// The logo pre-converted to NV12 space at one output size: full-resolution
/// luma plus alpha, and half-resolution chroma with the alpha averaged over
/// each 2x2 block. Rasterising once per size keeps the per-frame work down to
/// two small alpha blends.
struct Nv12Logo {
    mark_w: usize,
    mark_h: usize,
    luma: Vec<u8>,
    luma_alpha: Vec<u8>,
    chroma_u: Vec<u8>,
    chroma_v: Vec<u8>,
    chroma_alpha: Vec<u8>,
}

/// BT.709 limited range, which is what an H.264 clip decodes to.
fn rgb_to_ycbcr(r: u8, g: u8, b: u8) -> (u8, u8, u8) {
    let (r, g, b) = (i32::from(r), i32::from(g), i32::from(b));
    let y = ((47 * r + 157 * g + 16 * b) >> 8) + 16;
    let u = ((-26 * r - 87 * g + 112 * b) >> 8) + 128;
    let v = ((112 * r - 102 * g - 10 * b) >> 8) + 128;
    (
        y.clamp(0, 255) as u8,
        u.clamp(0, 255) as u8,
        v.clamp(0, 255) as u8,
    )
}

fn nv12_logo(mark_w: usize, mark_h: usize, logo: &WatermarkLogo) -> Arc<Nv12Logo> {
    static CACHE: OnceLock<Mutex<HashMap<(usize, usize), Arc<Nv12Logo>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(map) = cache.lock() {
        if let Some(found) = map.get(&(mark_w, mark_h)) {
            return Arc::clone(found);
        }
    }
    let built = Arc::new(rasterize_nv12_logo(mark_w, mark_h, logo));
    if let Ok(mut map) = cache.lock() {
        map.insert((mark_w, mark_h), Arc::clone(&built));
    }
    built
}

fn rasterize_nv12_logo(mark_w: usize, mark_h: usize, logo: &WatermarkLogo) -> Nv12Logo {
    let src_w = logo.width as usize;
    let src_h = logo.height as usize;
    let mut luma = vec![0_u8; mark_w * mark_h];
    let mut luma_alpha = vec![0_u8; mark_w * mark_h];
    let mut u_full = vec![128_u8; mark_w * mark_h];
    let mut v_full = vec![128_u8; mark_w * mark_h];
    for dy in 0..mark_h {
        let sy = dy * src_h / mark_h;
        for dx in 0..mark_w {
            let sx = dx * src_w / mark_w;
            let i = (sy * src_w + sx) * 4;
            if i + 3 >= logo.rgba.len() {
                continue;
            }
            let alpha = logo.rgba[i + 3];
            let (r, g, b) = (logo.rgba[i], logo.rgba[i + 1], logo.rgba[i + 2]);
            // Match the BGRA blit: near-transparent and near-black pixels are
            // treated as background so the mark stays a clean glyph.
            if alpha < 16 || (r < 18 && g < 18 && b < 18) {
                continue;
            }
            let (y, u, v) = rgb_to_ycbcr(r, g, b);
            let at = dy * mark_w + dx;
            luma[at] = y;
            luma_alpha[at] = alpha;
            u_full[at] = u;
            v_full[at] = v;
        }
    }

    let cw = mark_w / 2;
    let ch = mark_h / 2;
    let mut chroma_u = vec![128_u8; cw * ch];
    let mut chroma_v = vec![128_u8; cw * ch];
    let mut chroma_alpha = vec![0_u8; cw * ch];
    for cy in 0..ch {
        for cx in 0..cw {
            let mut sum_u = 0_u32;
            let mut sum_v = 0_u32;
            let mut sum_a = 0_u32;
            for (dy, dx) in [(0, 0), (0, 1), (1, 0), (1, 1)] {
                let at = (cy * 2 + dy) * mark_w + (cx * 2 + dx);
                sum_u += u32::from(u_full[at]);
                sum_v += u32::from(v_full[at]);
                sum_a += u32::from(luma_alpha[at]);
            }
            let at = cy * cw + cx;
            chroma_u[at] = (sum_u / 4) as u8;
            chroma_v[at] = (sum_v / 4) as u8;
            chroma_alpha[at] = (sum_a / 4) as u8;
        }
    }

    Nv12Logo {
        mark_w,
        mark_h,
        luma,
        luma_alpha,
        chroma_u,
        chroma_v,
        chroma_alpha,
    }
}

/// Bottom-right Replayr logo blended straight into an NV12 frame: `planes` is a
/// full-height luma plane followed by a half-height interleaved chroma plane,
/// both `pitch` bytes per row.
pub fn composite_watermark_nv12(planes: &mut [u8], pitch: usize, width: u32, height: u32) {
    let Some(logo) = watermark_logo() else {
        return;
    };
    let Some((origin_x, origin_y, mark_w, mark_h)) = watermark_box(width, height, logo) else {
        return;
    };
    // Chroma is subsampled 2x2, so the mark has to start and end on an even
    // pixel for its chroma grid to line up with the frame's.
    let origin_x = origin_x & !1;
    let origin_y = origin_y & !1;
    let mark_w = mark_w & !1;
    let mark_h = mark_h & !1;
    if mark_w == 0 || mark_h == 0 {
        return;
    }
    let height = height as usize;
    let chroma_base = pitch * height;
    if planes.len() < chroma_base + pitch * (height / 2) {
        return;
    }
    let mark = nv12_logo(mark_w, mark_h, logo);

    for dy in 0..mark.mark_h {
        let row = (origin_y + dy) * pitch;
        for dx in 0..mark.mark_w {
            let at = dy * mark.mark_w + dx;
            let alpha = u32::from(mark.luma_alpha[at]);
            if alpha == 0 {
                continue;
            }
            let target = row + origin_x + dx;
            let under = u32::from(planes[target]);
            planes[target] =
                ((u32::from(mark.luma[at]) * alpha + under * (255 - alpha)) / 255) as u8;
        }
    }

    let cw = mark.mark_w / 2;
    for cy in 0..mark.mark_h / 2 {
        let row = chroma_base + (origin_y / 2 + cy) * pitch;
        for cx in 0..cw {
            let at = cy * cw + cx;
            let alpha = u32::from(mark.chroma_alpha[at]);
            if alpha == 0 {
                continue;
            }
            let target = row + (origin_x / 2 + cx) * 2;
            let under_u = u32::from(planes[target]);
            let under_v = u32::from(planes[target + 1]);
            planes[target] =
                ((u32::from(mark.chroma_u[at]) * alpha + under_u * (255 - alpha)) / 255) as u8;
            planes[target + 1] =
                ((u32::from(mark.chroma_v[at]) * alpha + under_v * (255 - alpha)) / 255) as u8;
        }
    }
}

fn blend_pixel(frame: &mut StillFrame, pitch: usize, x: usize, y: usize, color: [u8; 4]) {
    if x >= frame.width as usize || y >= frame.height as usize {
        return;
    }
    let i = y * pitch + x * 4;
    if i + 3 >= frame.bgra.len() {
        return;
    }
    let alpha = u16::from(color[3]);
    let inv = 255 - alpha;
    frame.bgra[i] = ((u16::from(color[0]) * alpha + u16::from(frame.bgra[i]) * inv) / 255) as u8;
    frame.bgra[i + 1] =
        ((u16::from(color[1]) * alpha + u16::from(frame.bgra[i + 1]) * inv) / 255) as u8;
    frame.bgra[i + 2] =
        ((u16::from(color[2]) * alpha + u16::from(frame.bgra[i + 2]) * inv) / 255) as u8;
    frame.bgra[i + 3] = 255;
}

pub fn scale_bgra(frame: &StillFrame, max_width: u32) -> StillFrame {
    if frame.width == 0 || frame.height == 0 || frame.width <= max_width {
        return frame.clone();
    }
    let width = max_width.max(1);
    let height =
        ((u64::from(frame.height) * u64::from(width)) / u64::from(frame.width)).max(1) as u32;
    let dst_pitch = width * 4;
    let mut bgra = vec![0_u8; (dst_pitch * height) as usize];
    for y in 0..height {
        let src_y = y * frame.height / height;
        for x in 0..width {
            let src_x = x * frame.width / width;
            let src = (src_y * frame.pitch + src_x * 4) as usize;
            let dst = (y * dst_pitch + x * 4) as usize;
            if src + 4 <= frame.bgra.len() && dst + 4 <= bgra.len() {
                bgra[dst..dst + 4].copy_from_slice(&frame.bgra[src..src + 4]);
            }
        }
    }
    StillFrame {
        bgra,
        width,
        height,
        pitch: dst_pitch,
    }
}

/// Nearest-neighbor scale to an exact size. Returns `frame` unchanged when it already matches.
pub fn scale_bgra_to(frame: StillFrame, width: u32, height: u32) -> StillFrame {
    let width = width.max(1);
    let height = height.max(1);
    if frame.width == width && frame.height == height {
        return frame;
    }
    if frame.width == 0 || frame.height == 0 {
        return StillFrame {
            bgra: vec![0_u8; (width * height * 4) as usize],
            width,
            height,
            pitch: width * 4,
        };
    }
    let dst_pitch = width * 4;
    let mut bgra = vec![0_u8; (dst_pitch * height) as usize];
    let x_step = if frame.width % width == 0 {
        frame.width / width
    } else {
        0
    };
    let y_step = if frame.height % height == 0 {
        frame.height / height
    } else {
        0
    };
    if x_step >= 1 && y_step >= 1 {
        for y in 0..height {
            let src_row = (y * y_step * frame.pitch) as usize;
            let dst_row = (y * dst_pitch) as usize;
            for x in 0..width {
                let src = src_row + (x * x_step * 4) as usize;
                let dst = dst_row + (x * 4) as usize;
                if src + 4 <= frame.bgra.len() && dst + 4 <= bgra.len() {
                    bgra[dst..dst + 4].copy_from_slice(&frame.bgra[src..src + 4]);
                }
            }
        }
    } else {
        let xs: Vec<u32> = (0..width).map(|x| x * frame.width / width).collect();
        for y in 0..height {
            let src_y = y * frame.height / height;
            let src_row = (src_y * frame.pitch) as usize;
            let dst_row = (y * dst_pitch) as usize;
            for (x, src_x) in xs.iter().enumerate() {
                let src = src_row + (*src_x * 4) as usize;
                let dst = dst_row + x * 4;
                if src + 4 <= frame.bgra.len() && dst + 4 <= bgra.len() {
                    bgra[dst..dst + 4].copy_from_slice(&frame.bgra[src..src + 4]);
                }
            }
        }
    }
    StillFrame {
        bgra,
        width,
        height,
        pitch: dst_pitch,
    }
}

/// Scale `frame` into `out_width`×`out_height` with letterbox/pillarbox so 4:3,
/// 16:9, and 16:10 sources keep their shape instead of being stretched or cropped.
pub fn fit_bgra_contain(frame: StillFrame, out_width: u32, out_height: u32) -> StillFrame {
    let out_width = out_width.max(1);
    let out_height = out_height.max(1);
    if frame.width == out_width && frame.height == out_height {
        return frame;
    }
    if frame.width == 0 || frame.height == 0 {
        return StillFrame {
            bgra: vec![0_u8; (out_width * out_height * 4) as usize],
            width: out_width,
            height: out_height,
            pitch: out_width * 4,
        };
    }
    let scale =
        (out_width as f64 / frame.width as f64).min(out_height as f64 / frame.height as f64);
    let fit_w = ((frame.width as f64) * scale).round().max(1.0) as u32;
    let fit_h = ((frame.height as f64) * scale).round().max(1.0) as u32;
    let scaled = scale_bgra_to(frame, fit_w, fit_h);
    if fit_w == out_width && fit_h == out_height {
        return scaled;
    }
    let dst_pitch = out_width * 4;
    let mut bgra = vec![0_u8; (dst_pitch * out_height) as usize];
    let origin_x = (out_width.saturating_sub(fit_w)) / 2;
    let origin_y = (out_height.saturating_sub(fit_h)) / 2;
    for y in 0..fit_h {
        let src_row = (y * scaled.pitch) as usize;
        let dst_row = ((origin_y + y) * dst_pitch + origin_x * 4) as usize;
        let bytes = (fit_w * 4) as usize;
        if src_row + bytes <= scaled.bgra.len() && dst_row + bytes <= bgra.len() {
            bgra[dst_row..dst_row + bytes].copy_from_slice(&scaled.bgra[src_row..src_row + bytes]);
        }
    }
    StillFrame {
        bgra,
        width: out_width,
        height: out_height,
        pitch: dst_pitch,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn writes_readable_bitmap_header() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("frame.bmp");
        let frame = StillFrame {
            bgra: vec![
                0, 0, 255, 255, 0, 255, 0, 255, 255, 0, 0, 255, 255, 255, 255, 255,
            ],
            width: 2,
            height: 2,
            pitch: 8,
        };
        write_bgra_bmp(&path, &frame).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(&bytes[0..2], b"BM");
        assert!(path.metadata().unwrap().len() > 54);
        let scaled = scale_bgra(&frame, 1);
        assert_eq!(scaled.width, 1);
        assert_eq!(scaled.height, 1);
        let sized = scale_bgra_to(frame, 4, 4);
        assert_eq!(sized.width, 4);
        assert_eq!(sized.height, 4);
        assert_eq!(sized.bgra.len(), 64);
    }

    #[test]
    fn landscape_9x16_crop_is_full_height_and_follows_pan() {
        let (x, y, w, h) = crop_window_9x16(1920, 1080, 0.5);
        assert_eq!(y, 0);
        assert_eq!(h, 1080);
        assert_eq!(w, 608);
        assert_eq!(x, (1920 - 608) / 2);
        let left = crop_window_9x16(1920, 1080, 0.0);
        assert_eq!(left.0, 0);
        let right = crop_window_9x16(1920, 1080, 1.0);
        assert_eq!(right.0, 1920 - 608);
    }

    #[test]
    fn already_vertical_is_used_whole() {
        assert_eq!(crop_window_9x16(1080, 1920, 0.5), (0, 0, 1080, 1920));
    }

    #[test]
    fn watermark_logo_decodes() {
        let logo = load_watermark_logo().expect("watermark png");
        assert!(logo.width > 100);
        assert!(logo.height > 40);
        assert_eq!(
            logo.rgba.len(),
            logo.width as usize * logo.height as usize * 4
        );
    }

    #[test]
    fn watermark_lands_bottom_right() {
        let mut frame = StillFrame {
            bgra: vec![0; 320 * 180 * 4],
            width: 320,
            height: 180,
            pitch: 1280,
        };
        composite_watermark(&mut frame);
        assert_eq!(&frame.bgra[0..4], &[0, 0, 0, 0]);
        let mut marked = 0_u32;
        for y in 90..180 {
            for x in 160..320 {
                let i = (y * 320 + x) * 4;
                if frame.bgra[i] != 0 || frame.bgra[i + 1] != 0 || frame.bgra[i + 2] != 0 {
                    marked += 1;
                }
            }
        }
        assert!(
            marked > 80,
            "expected logo pixels in the bottom-right, got {marked}"
        );
    }

    #[test]
    fn fit_contain_preserves_4x3_inside_16x9_canvas() {
        let frame = StillFrame {
            bgra: vec![255; 40 * 30 * 4],
            width: 40,
            height: 30,
            pitch: 160,
        };
        let fitted = fit_bgra_contain(frame, 64, 36);
        assert_eq!(fitted.width, 64);
        assert_eq!(fitted.height, 36);
        // 40x30 → scale 1.2 → 48x36, centered with 8px pillars.
        let left = &fitted.bgra[0..4];
        assert_eq!(left, &[0, 0, 0, 0]);
        let mid = ((18 * 64 + 32) * 4) as usize;
        assert_eq!(&fitted.bgra[mid..mid + 4], &[255, 255, 255, 255]);
    }
}
