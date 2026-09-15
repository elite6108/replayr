//! Cropping a captured monitor frame down to the selected region.

use crate::still::StillFrame;

use super::geometry::PhysRect;

/// Copy `rect` out of `frame` into a new, tightly packed BGRA frame (`pitch == width * 4`).
///
/// `rect` must lie entirely inside the frame. This is checked with overflow-safe arithmetic
/// rather than trusted: a rect that escapes the frame is a bug upstream, and silently clamping it
/// here would save a different region than the one the user selected.
#[cfg(test)]
pub fn crop_bgra(frame: &StillFrame, rect: PhysRect) -> Result<StillFrame, String> {
    crop_slice(&frame.bgra, frame.width, frame.height, frame.pitch, rect)
}

/// [`crop_bgra`] over a borrowed buffer, so the selection surface can crop straight out of the
/// bitmap it is already displaying instead of keeping a second full-screen copy alive.
pub fn crop_slice(
    bgra: &[u8],
    width: u32,
    height: u32,
    pitch: u32,
    rect: PhysRect,
) -> Result<StillFrame, String> {
    if rect.is_empty() {
        return Err("The selection is empty.".into());
    }
    if width == 0 || height == 0 {
        return Err("The captured screen is empty.".into());
    }
    if rect.x < 0 || rect.y < 0 {
        return Err("The selection starts outside the captured screen.".into());
    }
    let (x, y) = (rect.x as u64, rect.y as u64);
    let (w, h) = (rect.w as u64, rect.h as u64);
    if x + w > width as u64 || y + h > height as u64 {
        return Err("The selection extends past the captured screen.".into());
    }

    let row_bytes = width as u64 * 4;
    let pitch = (pitch as u64).max(row_bytes);
    let needed = pitch
        .checked_mul(height as u64 - 1)
        .and_then(|rows| rows.checked_add(row_bytes))
        .ok_or_else(|| "The captured screen is too large.".to_string())?;
    if (bgra.len() as u64) < needed {
        return Err("The captured screen was incomplete.".into());
    }

    let out_len = w
        .checked_mul(h)
        .and_then(|pixels| pixels.checked_mul(4))
        .and_then(|bytes| usize::try_from(bytes).ok())
        .ok_or_else(|| "The selection is too large.".to_string())?;
    let mut out = Vec::with_capacity(out_len);
    let span = (w * 4) as usize;
    for row in y..y + h {
        let start = (row * pitch + x * 4) as usize;
        out.extend_from_slice(&bgra[start..start + span]);
    }

    Ok(StillFrame {
        bgra: out,
        width: rect.w,
        height: rect.h,
        pitch: rect.w * 4,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A frame whose pixel at (x, y) is [x, y, 0xAA, 0xFF], with optional row padding.
    fn frame(width: u32, height: u32, pitch: u32) -> StillFrame {
        let mut bgra = vec![0u8; (pitch * height) as usize];
        for y in 0..height {
            for x in 0..width {
                let i = (y * pitch + x * 4) as usize;
                bgra[i..i + 4].copy_from_slice(&[x as u8, y as u8, 0xAA, 0xFF]);
            }
        }
        StillFrame { bgra, width, height, pitch }
    }

    #[test]
    fn crops_exact_pixels() {
        let source = frame(8, 6, 32);
        let cropped = crop_bgra(&source, PhysRect { x: 2, y: 1, w: 3, h: 2 }).unwrap();
        assert_eq!((cropped.width, cropped.height, cropped.pitch), (3, 2, 12));
        let px = |x: usize, y: usize| &cropped.bgra[(y * 3 + x) * 4..(y * 3 + x) * 4 + 4];
        assert_eq!(px(0, 0), &[2, 1, 0xAA, 0xFF]);
        assert_eq!(px(2, 1), &[4, 2, 0xAA, 0xFF]);
    }

    #[test]
    fn skips_row_padding() {
        // A 5-pixel-wide frame reported with a 24-byte pitch (4 bytes of padding per row).
        let source = frame(5, 4, 24);
        let cropped = crop_bgra(&source, PhysRect { x: 0, y: 3, w: 5, h: 1 }).unwrap();
        assert_eq!(&cropped.bgra[0..4], &[0, 3, 0xAA, 0xFF]);
        assert_eq!(&cropped.bgra[16..20], &[4, 3, 0xAA, 0xFF]);
    }

    #[test]
    fn a_single_pixel_works() {
        let source = frame(4, 4, 16);
        let cropped = crop_bgra(&source, PhysRect { x: 3, y: 3, w: 1, h: 1 }).unwrap();
        assert_eq!(cropped.bgra, vec![3, 3, 0xAA, 0xFF]);
    }

    #[test]
    fn rejects_out_of_bounds_instead_of_clamping() {
        let source = frame(4, 4, 16);
        assert!(crop_bgra(&source, PhysRect { x: 2, y: 0, w: 3, h: 1 }).is_err());
        assert!(crop_bgra(&source, PhysRect { x: 0, y: 3, w: 1, h: 2 }).is_err());
        assert!(crop_bgra(&source, PhysRect { x: -1, y: 0, w: 1, h: 1 }).is_err());
        assert!(crop_bgra(&source, PhysRect { x: 0, y: 0, w: 0, h: 1 }).is_err());
    }

    #[test]
    fn rejects_a_short_buffer() {
        let mut source = frame(4, 4, 16);
        source.bgra.truncate(20);
        assert!(crop_bgra(&source, PhysRect { x: 0, y: 0, w: 1, h: 1 }).is_err());
    }
}
