use std::fs::File;
use std::io::Write;
use std::path::Path;

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
        bytes.resize(bytes.len() + (row_stride as usize).saturating_sub(copy_width), 0);
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
pub fn crop_and_scale_9x16(frame: &StillFrame, pan: f32, out_width: u32, out_height: u32) -> StillFrame {
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

pub fn scale_bgra(frame: &StillFrame, max_width: u32) -> StillFrame {
    if frame.width == 0 || frame.height == 0 || frame.width <= max_width {
        return frame.clone();
    }
    let width = max_width.max(1);
    let height = ((u64::from(frame.height) * u64::from(width)) / u64::from(frame.width)).max(1) as u32;
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

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn writes_readable_bitmap_header() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("frame.bmp");
        let frame = StillFrame {
            bgra: vec![0, 0, 255, 255, 0, 255, 0, 255, 255, 0, 0, 255, 255, 255, 255, 255],
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
}
