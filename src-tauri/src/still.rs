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
        if src + copy_width <= frame.bgra.len() {
            bytes.extend_from_slice(&frame.bgra[src..src + copy_width]);
        } else {
            bytes.resize(bytes.len() + copy_width, 0);
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
}
