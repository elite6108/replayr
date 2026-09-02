//! Rasterize composed text once (or when HUD text changes). Plain text only.
//!
//! Glyph coverage is written to alpha. RGB is the requested color.
//! Textures are **straight (non-premultiplied) BGRA** — see `sources/mod.rs`.
//! RGB(0,0,0) is opaque black. Color-key transparency is forbidden.

#![cfg(windows)]

use windows::core::PCWSTR;
use windows::Win32::Foundation::RECT;
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, CreateDIBSection, CreateFontW, DeleteDC, DeleteObject, SelectObject,
    SetBkMode, SetTextColor, ANTIALIASED_QUALITY, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
    CLIP_DEFAULT_PRECIS, DEFAULT_CHARSET, DEFAULT_PITCH, DIB_RGB_COLORS, FW_SEMIBOLD,
    OUT_TT_PRECIS, TRANSPARENT,
};
use windows::Win32::Graphics::Gdi::DrawTextW;
use windows::Win32::Graphics::Gdi::{DT_CENTER, DT_END_ELLIPSIS, DT_LEFT, DT_RIGHT, DT_WORDBREAK};

use super::super::scene::{TextAlign, ValidatedText};

const MAX_TEXT_TEX: u32 = 2048;
const MIN_TEXT_TEX: u32 = 8;
const MAX_TEXT_BYTES: usize = 2048 * 2048 * 4;

pub struct RasterText {
    pub id: String,
    pub bgra: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

/// Clamp a text raster box to the canvas and a hard GPU texture cap.
pub fn clamp_text_raster(box_w: u32, box_h: u32, canvas_w: u32, canvas_h: u32) -> (u32, u32) {
    let width = box_w
        .max(MIN_TEXT_TEX)
        .min(canvas_w.max(MIN_TEXT_TEX))
        .min(MAX_TEXT_TEX);
    let height = box_h
        .max(MIN_TEXT_TEX)
        .min(canvas_h.max(MIN_TEXT_TEX))
        .min(MAX_TEXT_TEX);
    (even_floor(width), even_floor(height))
}

fn even_floor(value: u32) -> u32 {
    let value = value.max(MIN_TEXT_TEX);
    (value / 2) * 2
}

pub fn raster_text(spec: &ValidatedText, box_w: u32, box_h: u32) -> Result<RasterText, String> {
    raster_plain(
        &spec.id,
        &spec.text,
        spec.color,
        spec.size,
        spec.align,
        box_w,
        box_h,
        false,
    )
}

pub fn raster_hud_line(
    id: &str,
    text: &str,
    color: [u8; 4],
    size: u32,
    align: TextAlign,
    box_w: u32,
    box_h: u32,
) -> Result<RasterText, String> {
    raster_plain(id, text, color, size, align, box_w, box_h, true)
}

fn raster_plain(
    id: &str,
    text: &str,
    color: [u8; 4],
    size: u32,
    align: TextAlign,
    box_w: u32,
    box_h: u32,
    hud: bool,
) -> Result<RasterText, String> {
    let (width, height) = clamp_text_raster(box_w, box_h, box_w, box_h);
    let bytes = (width as usize)
        .checked_mul(height as usize)
        .and_then(|pixels| pixels.checked_mul(4))
        .filter(|len| *len > 0 && *len <= MAX_TEXT_BYTES)
        .ok_or_else(|| "Text source is too large to rasterize.".to_string())?;
    let mut wide: Vec<u16> = text.encode_utf16().collect();
    wide.push(0);
    let font_name: Vec<u16> = "Segoe UI".encode_utf16().chain(std::iter::once(0)).collect();
    let weight = if hud { 700 } else { FW_SEMIBOLD.0 as i32 };
    unsafe {
        let hdc = CreateCompatibleDC(None);
        if hdc.is_invalid() {
            return Err("Could not rasterize composed text.".into());
        }
        let info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width as i32,
                biHeight: -(height as i32),
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bits = std::ptr::null_mut();
        let dib = match CreateDIBSection(Some(hdc), &info, DIB_RGB_COLORS, &mut bits, None, 0) {
            Ok(dib) => dib,
            Err(_) => {
                let _ = DeleteDC(hdc);
                return Err("Could not rasterize composed text.".into());
            }
        };
        let old_bmp = SelectObject(hdc, dib.into());
        // Grayscale AA (not ClearType) so coverage is a single-channel mask.
        let font = CreateFontW(
            size.max(10) as i32,
            0,
            0,
            0,
            weight,
            0,
            0,
            0,
            DEFAULT_CHARSET,
            OUT_TT_PRECIS,
            CLIP_DEFAULT_PRECIS,
            ANTIALIASED_QUALITY,
            DEFAULT_PITCH.0 as u32,
            PCWSTR(font_name.as_ptr()),
        );
        let old_font = SelectObject(hdc, font.into());
        SetBkMode(hdc, TRANSPARENT);
        // White glyphs on a black DIB become the coverage mask. Never color-key.
        SetTextColor(hdc, windows::Win32::Foundation::COLORREF(0x00FF_FFFF));
        let flags = DT_WORDBREAK.0
            | DT_END_ELLIPSIS.0
            | match align {
                TextAlign::Left => DT_LEFT.0,
                TextAlign::Center => DT_CENTER.0,
                TextAlign::Right => DT_RIGHT.0,
            };
        let mut rect = RECT {
            left: 4,
            top: 2,
            right: width as i32 - 4,
            bottom: height as i32 - 2,
        };
        DrawTextW(
            hdc,
            &mut wide,
            &mut rect,
            windows::Win32::Graphics::Gdi::DRAW_TEXT_FORMAT(flags),
        );
        let mut bgra = vec![0u8; bytes];
        if !bits.is_null() {
            std::ptr::copy_nonoverlapping(bits as *const u8, bgra.as_mut_ptr(), bytes);
            apply_glyph_mask(&mut bgra, color);
        }
        SelectObject(hdc, old_font);
        SelectObject(hdc, old_bmp);
        let _ = DeleteObject(font.into());
        let _ = DeleteObject(dib.into());
        let _ = DeleteDC(hdc);
        Ok(RasterText {
            id: id.to_string(),
            bgra,
            width,
            height,
        })
    }
}

/// Convert a white-on-black glyph DIB into straight BGRA of `color`.
///
/// `color` is BGRA. Coverage is `max(B,G,R)` of the GDI glyph. RGB is copied
/// unchanged so #000000 stays black and only alpha carries the mask.
pub fn apply_glyph_mask(pixels: &mut [u8], color: [u8; 4]) {
    for px in pixels.chunks_exact_mut(4) {
        let coverage = px[0].max(px[1]).max(px[2]);
        let alpha = ((coverage as u16 * color[3] as u16) / 255) as u8;
        px[0] = color[0];
        px[1] = color[1];
        px[2] = color[2];
        px[3] = alpha;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pixel(bgra: &[u8], index: usize) -> [u8; 4] {
        [
            bgra[index * 4],
            bgra[index * 4 + 1],
            bgra[index * 4 + 2],
            bgra[index * 4 + 3],
        ]
    }

    #[test]
    fn black_text_is_opaque_on_covered_glyphs() {
        // White coverage 255 → requested #000000 must be (0,0,0,255), not keyed out.
        let mut pixels = vec![255, 255, 255, 0, 0, 0, 0, 0];
        apply_glyph_mask(&mut pixels, [0, 0, 0, 255]);
        assert_eq!(pixel(&pixels, 0), [0, 0, 0, 255]);
        assert_eq!(pixel(&pixels, 1), [0, 0, 0, 0]);
    }

    #[test]
    fn near_black_keeps_requested_rgb() {
        let mut pixels = vec![200, 200, 200, 0];
        apply_glyph_mask(&mut pixels, [8, 8, 8, 255]);
        assert_eq!(pixel(&pixels, 0), [8, 8, 8, 200]);
    }

    #[test]
    fn white_and_accent_colors_keep_rgb() {
        let mut white = vec![255, 255, 255, 0];
        apply_glyph_mask(&mut white, [255, 255, 255, 255]);
        assert_eq!(pixel(&white, 0), [255, 255, 255, 255]);

        let mut red = vec![255, 255, 255, 0];
        apply_glyph_mask(&mut red, [0, 0, 255, 255]);
        assert_eq!(pixel(&red, 0), [0, 0, 255, 255]);

        let mut cyan = vec![128, 128, 128, 0];
        apply_glyph_mask(&mut cyan, [255, 255, 0, 255]);
        assert_eq!(pixel(&cyan, 0), [255, 255, 0, 128]);
    }

    #[test]
    fn color_alpha_scales_coverage() {
        let mut pixels = vec![255, 255, 255, 0];
        apply_glyph_mask(&mut pixels, [0, 0, 255, 128]);
        assert_eq!(pixel(&pixels, 0)[3], 128);
        assert_eq!(&pixel(&pixels, 0)[..3], &[0, 0, 255]);
    }

    #[test]
    fn raster_dims_clamp_to_canvas_and_cap() {
        assert_eq!(clamp_text_raster(10_000, 10_000, 1920, 1080), (1920, 1080));
        assert_eq!(clamp_text_raster(1, 1, 1920, 1080), (8, 8));
        assert_eq!(clamp_text_raster(3000, 40, 1920, 1080), (1920, 40));
    }
}
