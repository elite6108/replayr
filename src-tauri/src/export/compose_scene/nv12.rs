//! NV12-native compositing for the offline clip burn.
//!
//! Instant Replay decodes NV12 and the H.264 encoder consumes NV12, so working in NV12 end to
//! end removes the two full-frame colour conversions (NV12 -> RGB32 -> NV12) that dominated the
//! first version of this burn. Per frame the cost becomes a 3 MB plane copy plus a blend over
//! the small region the overlays actually occupy.
//!
//! Colour grading is also cheaper here than in RGB: brightness and contrast are Y-only, and
//! saturation and hue are a rotation of the chroma pair around 128.
//!
//! Layout
//! - Y plane: `height` rows of `stride` bytes, one byte per pixel.
//! - UV plane: `height / 2` rows of `stride` bytes, interleaved U,V per 2x2 luma block.
//!
//! Everything here is plain safe Rust with explicit bounds checks; every rectangle is clamped to
//! the canvas and snapped to even coordinates so a 2x2 chroma block never straddles the edge.

use crate::recording_compositor::filters::FilterTune;
use crate::recording_compositor::transforms::PixelRect;

/// Hard ceiling on canvas size, mirroring `MAX_CANVAS_*` in recording_compositor::scene.
/// Guards the allocation below against a malformed decoder report.
const MAX_DIM: u32 = 7680;

/// Snap a rectangle to even bounds and clamp it inside `w` x `h`.
///
/// Chroma is subsampled 2x2, so an odd origin or extent would split a chroma sample between
/// "inside" and "outside" the region and tint the edge.
pub fn even_clamped(rect: PixelRect, w: u32, h: u32) -> PixelRect {
    let x0 = rect.x.max(0) as u32 & !1;
    let y0 = rect.y.max(0) as u32 & !1;
    if x0 >= w || y0 >= h {
        return PixelRect { x: 0, y: 0, w: 0, h: 0 };
    }
    let x1 = ((rect.x.max(0) as u32).saturating_add(rect.w)).min(w);
    let y1 = ((rect.y.max(0) as u32).saturating_add(rect.h)).min(h);
    PixelRect {
        x: x0 as i32,
        y: y0 as i32,
        w: (x1.saturating_sub(x0)) & !1,
        h: (y1.saturating_sub(y0)) & !1,
    }
}

/// An NV12 frame the burn owns and mutates.
pub struct Nv12Canvas {
    pub planes: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

impl Nv12Canvas {
    pub fn new(width: u32, height: u32) -> Result<Self, String> {
        if width == 0 || height == 0 || width % 2 == 1 || height % 2 == 1 {
            return Err(format!("Clip frame size {width}x{height} is not usable."));
        }
        if width > MAX_DIM || height > MAX_DIM {
            return Err(format!("Clip frame size {width}x{height} is too large to burn."));
        }
        let luma = (width as usize) * (height as usize);
        Ok(Self {
            // Y plane plus a half-height interleaved chroma plane.
            planes: vec![0u8; luma + luma / 2],
            width,
            height,
        })
    }

    fn luma_len(&self) -> usize {
        (self.width as usize) * (self.height as usize)
    }

    /// Copy a decoded frame in, dropping any row padding the decoder added.
    pub fn copy_from(&mut self, src: &[u8], src_pitch: u32, src_height: u32) -> Result<(), String> {
        let width = self.width as usize;
        let pitch = (src_pitch as usize).max(width);
        let rows = (src_height as usize).min(self.height as usize);
        let luma = self.luma_len();
        if src.len() < pitch * (src_height as usize) * 3 / 2 {
            return Err("Decoded frame was smaller than its reported size.".into());
        }
        for row in 0..rows {
            let from = row * pitch;
            let to = row * width;
            self.planes[to..to + width].copy_from_slice(&src[from..from + width]);
        }
        let src_chroma = pitch * (src_height as usize);
        for row in 0..(rows / 2) {
            let from = src_chroma + row * pitch;
            let to = luma + row * width;
            if from + width <= src.len() {
                self.planes[to..to + width].copy_from_slice(&src[from..from + width]);
            }
        }
        Ok(())
    }

    /// Fill the whole frame with opaque black (Y=0, chroma centred).
    ///
    /// Used by tests today, and by the letterbox ground once cropped or repositioned gameplay is
    /// supported — a zeroed chroma plane would come out bright green rather than black.
    #[allow(dead_code)]
    pub fn clear_black(&mut self) {
        let luma = self.luma_len();
        self.planes[..luma].fill(0);
        self.planes[luma..].fill(128);
    }
}

/// One overlay layer set, pre-converted to NV12 once and reused every frame.
///
/// Images, text, filter chrome and the REC indicator never change over a clip, so converting
/// them per frame would be pure waste. Only the region they occupy is stored.
pub struct Nv12Sheet {
    /// Even-aligned region of the canvas this sheet covers.
    pub rect: PixelRect,
    /// Luma, one byte per pixel of `rect`.
    luma: Vec<u8>,
    /// Luma coverage, one byte per pixel of `rect`.
    luma_alpha: Vec<u8>,
    /// Interleaved U,V per 2x2 block of `rect`.
    chroma: Vec<u8>,
    /// Chroma coverage, one byte per 2x2 block of `rect`.
    chroma_alpha: Vec<u8>,
}

impl Nv12Sheet {
    /// Convert a straight-BGRA sheet region into NV12 planes plus coverage.
    pub fn from_bgra(bgra: &[u8], canvas_w: u32, canvas_h: u32, rect: PixelRect) -> Option<Self> {
        let rect = even_clamped(rect, canvas_w, canvas_h);
        if rect.is_empty() {
            return None;
        }
        let (rw, rh) = (rect.w as usize, rect.h as usize);
        let mut luma = vec![0u8; rw * rh];
        let mut luma_alpha = vec![0u8; rw * rh];
        let mut chroma = vec![128u8; (rw / 2) * (rh / 2) * 2];
        let mut chroma_alpha = vec![0u8; (rw / 2) * (rh / 2)];

        for row in 0..rh {
            for col in 0..rw {
                let sx = rect.x as usize + col;
                let sy = rect.y as usize + row;
                let si = (sy * canvas_w as usize + sx) * 4;
                if si + 3 >= bgra.len() {
                    continue;
                }
                let (b, g, r, a) = (bgra[si], bgra[si + 1], bgra[si + 2], bgra[si + 3]);
                let (y, _, _) = crate::camera::color::rgb_to_yuv(r, g, b);
                luma[row * rw + col] = y;
                luma_alpha[row * rw + col] = a;
            }
        }

        // Chroma is one sample per 2x2 luma block: average the block's colour and coverage so a
        // partially covered block blends proportionally instead of snapping to the overlay hue.
        for by in 0..(rh / 2) {
            for bx in 0..(rw / 2) {
                let mut sum_u = 0u32;
                let mut sum_v = 0u32;
                let mut sum_a = 0u32;
                let mut weighted = 0u32;
                for dy in 0..2 {
                    for dx in 0..2 {
                        let sx = rect.x as usize + bx * 2 + dx;
                        let sy = rect.y as usize + by * 2 + dy;
                        let si = (sy * canvas_w as usize + sx) * 4;
                        if si + 3 >= bgra.len() {
                            continue;
                        }
                        let (b, g, r, a) = (bgra[si], bgra[si + 1], bgra[si + 2], bgra[si + 3]);
                        let (_, u, v) = crate::camera::color::rgb_to_yuv(r, g, b);
                        // Weight colour by coverage so transparent pixels do not drag the hue.
                        sum_u += u as u32 * a as u32;
                        sum_v += v as u32 * a as u32;
                        sum_a += a as u32;
                        weighted += a as u32;
                    }
                }
                let index = by * (rw / 2) + bx;
                chroma_alpha[index] = (sum_a / 4) as u8;
                if weighted > 0 {
                    chroma[index * 2] = (sum_u / weighted) as u8;
                    chroma[index * 2 + 1] = (sum_v / weighted) as u8;
                }
            }
        }

        Some(Self { rect, luma, luma_alpha, chroma, chroma_alpha })
    }

    /// Alpha-blend this sheet onto `canvas`. Opaque pixels are a straight copy.
    pub fn blend_onto(&self, canvas: &mut Nv12Canvas) {
        let cw = canvas.width as usize;
        let luma_len = canvas.luma_len();
        let (rw, rh) = (self.rect.w as usize, self.rect.h as usize);
        let (rx, ry) = (self.rect.x as usize, self.rect.y as usize);

        for row in 0..rh {
            let dst_row = (ry + row) * cw;
            for col in 0..rw {
                let alpha = self.luma_alpha[row * rw + col] as u32;
                if alpha == 0 {
                    continue;
                }
                let di = dst_row + rx + col;
                if di >= luma_len {
                    continue;
                }
                let src = self.luma[row * rw + col] as u32;
                canvas.planes[di] = if alpha == 255 {
                    src as u8
                } else {
                    ((src * alpha + canvas.planes[di] as u32 * (255 - alpha)) / 255) as u8
                };
            }
        }

        for by in 0..(rh / 2) {
            let dst_row = luma_len + ((ry / 2) + by) * cw;
            for bx in 0..(rw / 2) {
                let index = by * (rw / 2) + bx;
                let alpha = self.chroma_alpha[index] as u32;
                if alpha == 0 {
                    continue;
                }
                let di = dst_row + rx + bx * 2;
                if di + 1 >= canvas.planes.len() {
                    continue;
                }
                for channel in 0..2 {
                    let src = self.chroma[index * 2 + channel] as u32;
                    canvas.planes[di + channel] = if alpha == 255 {
                        src as u8
                    } else {
                        ((src * alpha + canvas.planes[di + channel] as u32 * (255 - alpha)) / 255) as u8
                    };
                }
            }
        }
    }
}

/// Colour grading applied straight to NV12 planes.
///
/// Mirrors `filters::tune_for`, which the live compositor hands to the D3D11 video processor:
/// brightness and contrast act on luma, saturation scales chroma away from neutral, and hue
/// rotates the chroma pair.
pub struct Nv12Tune {
    luma_lut: Option<[u8; 256]>,
    saturation: Option<f32>,
    hue: Option<f32>,
}

impl Nv12Tune {
    pub fn new(tune: FilterTune) -> Self {
        let brightness = tune.brightness.unwrap_or(0.0);
        let contrast = tune.contrast.unwrap_or(0.0);
        let luma_lut = if brightness == 0.0 && contrast == 0.0 {
            None
        } else {
            let mut table = [0u8; 256];
            for (value, slot) in table.iter_mut().enumerate() {
                let mut y = value as f32;
                y = (y - 128.0) * (1.0 + contrast) + 128.0;
                y += brightness * 255.0;
                *slot = y.round().clamp(0.0, 255.0) as u8;
            }
            Some(table)
        };
        if tune.noise.is_some() {
            // The GPU term is NOISE_REDUCTION — a denoiser, not film grain. Faking grain would
            // make the burn look unlike both the preview and live composed recording.
            tracing::debug!("clip burn ignores the filter's noise-reduction term");
        }
        Self {
            luma_lut,
            saturation: tune.saturation.filter(|value| *value != 0.0),
            hue: tune.hue.filter(|value| *value != 0.0),
        }
    }

    pub fn is_identity(&self) -> bool {
        self.luma_lut.is_none() && self.saturation.is_none() && self.hue.is_none()
    }

    /// Grade `rect` of `canvas` in place. Overlays are blended after this, so they stay ungraded
    /// — stage 2 of the composed pipeline treats the base capture alone.
    pub fn apply(&self, canvas: &mut Nv12Canvas, rect: PixelRect) {
        if self.is_identity() {
            return;
        }
        let rect = even_clamped(rect, canvas.width, canvas.height);
        if rect.is_empty() {
            return;
        }
        let cw = canvas.width as usize;
        let luma_len = canvas.luma_len();
        let (rx, ry) = (rect.x as usize, rect.y as usize);

        if let Some(lut) = &self.luma_lut {
            for row in 0..rect.h as usize {
                let base = (ry + row) * cw + rx;
                for col in 0..rect.w as usize {
                    let index = base + col;
                    if index < luma_len {
                        canvas.planes[index] = lut[canvas.planes[index] as usize];
                    }
                }
            }
        }

        if self.saturation.is_none() && self.hue.is_none() {
            return;
        }
        let factor = 1.0 + self.saturation.unwrap_or(0.0);
        let (sin_h, cos_h) = match self.hue {
            Some(hue) => {
                let radians = (hue * 180.0).to_radians();
                (radians.sin(), radians.cos())
            }
            None => (0.0, 1.0),
        };
        for by in 0..(rect.h as usize / 2) {
            let base = luma_len + ((ry / 2) + by) * cw + rx;
            for bx in 0..(rect.w as usize / 2) {
                let index = base + bx * 2;
                if index + 1 >= canvas.planes.len() {
                    continue;
                }
                let u = canvas.planes[index] as f32 - 128.0;
                let v = canvas.planes[index + 1] as f32 - 128.0;
                let (mut u, mut v) = (u * factor, v * factor);
                if self.hue.is_some() {
                    let ru = u * cos_h - v * sin_h;
                    let rv = u * sin_h + v * cos_h;
                    u = ru;
                    v = rv;
                }
                canvas.planes[index] = (u + 128.0).round().clamp(0.0, 255.0) as u8;
                canvas.planes[index + 1] = (v + 128.0).round().clamp(0.0, 255.0) as u8;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tune(brightness: f32, saturation: f32) -> FilterTune {
        FilterTune {
            brightness: Some(brightness),
            contrast: Some(0.0),
            saturation: Some(saturation),
            hue: None,
            noise: None,
        }
    }

    #[test]
    fn canvas_rejects_odd_and_oversized_frames() {
        assert!(Nv12Canvas::new(1921, 1080).is_err(), "odd width splits a chroma block");
        assert!(Nv12Canvas::new(1920, 1081).is_err(), "odd height splits a chroma block");
        assert!(Nv12Canvas::new(0, 1080).is_err());
        assert!(Nv12Canvas::new(8000, 4000).is_err(), "beyond the supported ceiling");
        let canvas = Nv12Canvas::new(1920, 1080).unwrap();
        assert_eq!(canvas.planes.len(), 1920 * 1080 * 3 / 2);
    }

    #[test]
    fn even_clamped_snaps_and_clips() {
        // Odd origin and extent both snap down so 2x2 chroma blocks stay whole.
        let rect = even_clamped(PixelRect { x: 3, y: 5, w: 7, h: 9 }, 100, 100);
        assert_eq!((rect.x, rect.y), (2, 4));
        assert_eq!((rect.w % 2, rect.h % 2), (0, 0));
        // Past the edge clips rather than overflowing.
        let rect = even_clamped(PixelRect { x: 90, y: 90, w: 50, h: 50 }, 100, 100);
        assert_eq!((rect.x + rect.w as i32, rect.y + rect.h as i32), (100, 100));
        // Fully outside collapses to empty.
        assert!(even_clamped(PixelRect { x: 200, y: 0, w: 10, h: 10 }, 100, 100).is_empty());
        // Negative origin is clamped, not wrapped.
        let rect = even_clamped(PixelRect { x: -8, y: -8, w: 20, h: 20 }, 100, 100);
        assert_eq!((rect.x, rect.y), (0, 0));
    }

    #[test]
    fn sheet_blends_opaque_white_over_black() {
        let mut canvas = Nv12Canvas::new(8, 8).unwrap();
        canvas.clear_black();
        // Opaque white 4x4 patch at the origin.
        let mut bgra = vec![0u8; 8 * 8 * 4];
        for row in 0..4 {
            for col in 0..4 {
                let index = (row * 8 + col) * 4;
                bgra[index..index + 4].copy_from_slice(&[255, 255, 255, 255]);
            }
        }
        let sheet = Nv12Sheet::from_bgra(&bgra, 8, 8, PixelRect { x: 0, y: 0, w: 4, h: 4 })
            .expect("a covered rect yields a sheet");
        sheet.blend_onto(&mut canvas);
        assert!(canvas.planes[0] > 200, "covered luma should be near white, got {}", canvas.planes[0]);
        assert_eq!(canvas.planes[5], 0, "luma outside the rect is untouched");
    }

    #[test]
    fn sheet_ignores_fully_transparent_pixels() {
        let mut canvas = Nv12Canvas::new(8, 8).unwrap();
        canvas.clear_black();
        // Opaque-looking colour but zero alpha: must not tint anything.
        let bgra = vec![255u8, 255, 255, 0].repeat(8 * 8);
        let sheet = Nv12Sheet::from_bgra(&bgra, 8, 8, PixelRect { x: 0, y: 0, w: 8, h: 8 }).unwrap();
        sheet.blend_onto(&mut canvas);
        assert!(canvas.planes[..64].iter().all(|y| *y == 0));
        assert!(canvas.planes[64..].iter().all(|uv| *uv == 128));
    }

    #[test]
    fn tune_identity_leaves_planes_alone() {
        let mut canvas = Nv12Canvas::new(4, 4).unwrap();
        canvas.planes.fill(120);
        let before = canvas.planes.clone();
        let tune = Nv12Tune::new(FilterTune {
            brightness: None,
            contrast: None,
            saturation: None,
            hue: None,
            noise: None,
        });
        assert!(tune.is_identity());
        tune.apply(&mut canvas, PixelRect { x: 0, y: 0, w: 4, h: 4 });
        assert_eq!(canvas.planes, before);
    }

    #[test]
    fn tune_brightens_luma_and_desaturates_chroma() {
        let mut canvas = Nv12Canvas::new(4, 4).unwrap();
        canvas.planes.fill(100);
        let tune = Nv12Tune::new(tune(0.1, -0.5));
        tune.apply(&mut canvas, PixelRect { x: 0, y: 0, w: 4, h: 4 });
        assert!(canvas.planes[0] > 100, "brightness raises luma");
        // Chroma at 100 is 28 below neutral; halving saturation pulls it toward 128.
        let chroma = canvas.planes[16];
        assert!(chroma > 100 && chroma < 128, "chroma should move toward neutral, got {chroma}");
    }

    #[test]
    fn copy_from_drops_row_padding() {
        let mut canvas = Nv12Canvas::new(4, 4).unwrap();
        // A decoder handing back an 8-byte pitch for a 4-pixel-wide frame.
        let pitch = 8usize;
        let mut src = vec![0u8; pitch * 4 * 3 / 2];
        for row in 0..4 {
            for col in 0..4 {
                src[row * pitch + col] = (row * 4 + col) as u8;
            }
        }
        canvas.copy_from(&src, pitch as u32, 4).unwrap();
        assert_eq!(&canvas.planes[..4], &[0, 1, 2, 3]);
        assert_eq!(&canvas.planes[4..8], &[4, 5, 6, 7], "padding must not leak into row 2");
    }

    #[test]
    fn copy_from_rejects_a_short_buffer() {
        let mut canvas = Nv12Canvas::new(4, 4).unwrap();
        assert!(canvas.copy_from(&[0u8; 8], 4, 4).is_err());
    }
}
