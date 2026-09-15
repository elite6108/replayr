//! Selection geometry for region screenshots. Pure, platform-independent, unit-tested.
//!
//! Everything is in **physical pixels**. Replayr runs Per-Monitor-V2 DPI aware, so window client
//! coordinates, monitor rects and captured frames all share one pixel grid — no logical/DIP
//! conversion happens anywhere in the snip path, which is what keeps crops exact on mixed-DPI and
//! fractional-scale (125%, 175%) setups.

/// Smallest selection that counts as a screenshot. A click without a real drag is ignored rather
/// than producing a 1x1 image.
pub const MIN_SELECTION_PX: u32 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Point {
    pub x: i32,
    pub y: i32,
}

/// An axis-aligned rectangle. `w` and `h` are never negative by construction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct PhysRect {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
}

impl PhysRect {
    pub fn is_empty(self) -> bool {
        self.w == 0 || self.h == 0
    }

    pub fn right(self) -> i64 {
        self.x as i64 + self.w as i64
    }

    pub fn bottom(self) -> i64 {
        self.y as i64 + self.h as i64
    }

    /// Smallest rectangle covering both. Used to repaint only what a drag step changed.
    pub fn union(self, other: PhysRect) -> PhysRect {
        if self.is_empty() {
            return other;
        }
        if other.is_empty() {
            return self;
        }
        let left = self.x.min(other.x);
        let top = self.y.min(other.y);
        let right = self.right().max(other.right());
        let bottom = self.bottom().max(other.bottom());
        PhysRect {
            x: left,
            y: top,
            w: (right - left as i64).clamp(0, u32::MAX as i64) as u32,
            h: (bottom - top as i64).clamp(0, u32::MAX as i64) as u32,
        }
    }

    /// Grow on every side by `by` pixels, for repainting the border and size label.
    pub fn inflate(self, by: u32) -> PhysRect {
        let by_i = by.min(i32::MAX as u32) as i32;
        PhysRect {
            x: self.x.saturating_sub(by_i),
            y: self.y.saturating_sub(by_i),
            w: self.w.saturating_add(by.saturating_mul(2)),
            h: self.h.saturating_add(by.saturating_mul(2)),
        }
    }
}

/// Turn a drag from `anchor` to `current` into a rectangle, whichever direction it went.
///
/// The end point is inclusive of the pixel under the cursor, so dragging from (10,10) to (12,12)
/// selects a 3x3 region — matching what the user sees highlighted.
pub fn normalize_drag(anchor: Point, current: Point) -> PhysRect {
    let left = anchor.x.min(current.x);
    let top = anchor.y.min(current.y);
    let right = anchor.x.max(current.x) as i64 + 1;
    let bottom = anchor.y.max(current.y) as i64 + 1;
    PhysRect {
        x: left,
        y: top,
        w: (right - left as i64).clamp(0, u32::MAX as i64) as u32,
        h: (bottom - top as i64).clamp(0, u32::MAX as i64) as u32,
    }
}

/// Clip `rect` to lie inside `bounds`. Returns an empty rect when they do not overlap.
pub fn clamp_to(rect: PhysRect, bounds: PhysRect) -> PhysRect {
    let left = (rect.x as i64).max(bounds.x as i64);
    let top = (rect.y as i64).max(bounds.y as i64);
    let right = rect.right().min(bounds.right());
    let bottom = rect.bottom().min(bounds.bottom());
    if right <= left || bottom <= top {
        return PhysRect::default();
    }
    PhysRect {
        x: left as i32,
        y: top as i32,
        w: (right - left) as u32,
        h: (bottom - top) as u32,
    }
}

/// Clamp a point to lie inside a `w` x `h` client area, so a drag that leaves the monitor keeps
/// selecting up to its edge instead of wrapping or going negative.
pub fn clamp_point(point: Point, w: u32, h: u32) -> Point {
    let max_x = w.saturating_sub(1).min(i32::MAX as u32) as i32;
    let max_y = h.saturating_sub(1).min(i32::MAX as u32) as i32;
    Point {
        x: point.x.clamp(0, max_x),
        y: point.y.clamp(0, max_y),
    }
}

/// Whether a selection is big enough to save.
pub fn is_usable(rect: PhysRect) -> bool {
    rect.w >= MIN_SELECTION_PX && rect.h >= MIN_SELECTION_PX
}

/// Map a rectangle in window client pixels onto the captured frame.
///
/// Under Per-Monitor-V2 these sizes are equal and this is the identity. They can differ if the
/// monitor mode changed between capture and selection or a driver reports a scaled frame; scaling
/// here keeps the crop faithful to what was highlighted instead of silently offsetting it.
pub fn client_to_frame(rect: PhysRect, client_w: u32, client_h: u32, frame_w: u32, frame_h: u32) -> PhysRect {
    if client_w == 0 || client_h == 0 || frame_w == 0 || frame_h == 0 {
        return PhysRect::default();
    }
    if client_w == frame_w && client_h == frame_h {
        return clamp_to(rect, PhysRect { x: 0, y: 0, w: frame_w, h: frame_h });
    }
    let sx = |value: i64| (value * frame_w as i64) / client_w as i64;
    let sy = |value: i64| (value * frame_h as i64) / client_h as i64;
    let left = sx(rect.x as i64);
    let top = sy(rect.y as i64);
    // Round the far edge up so a selection touching the client edge reaches the frame edge.
    let right = (rect.right() * frame_w as i64 + client_w as i64 - 1) / client_w as i64;
    let bottom = (rect.bottom() * frame_h as i64 + client_h as i64 - 1) / client_h as i64;
    let scaled = PhysRect {
        x: left.clamp(i32::MIN as i64, i32::MAX as i64) as i32,
        y: top.clamp(i32::MIN as i64, i32::MAX as i64) as i32,
        w: (right - left).clamp(0, u32::MAX as i64) as u32,
        h: (bottom - top).clamp(0, u32::MAX as i64) as u32,
    };
    clamp_to(scaled, PhysRect { x: 0, y: 0, w: frame_w, h: frame_h })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pt(x: i32, y: i32) -> Point {
        Point { x, y }
    }

    #[test]
    fn drag_direction_does_not_matter() {
        let expected = PhysRect { x: 10, y: 20, w: 91, h: 31 };
        // Down-right, up-left, up-right, down-left all describe the same region.
        assert_eq!(normalize_drag(pt(10, 20), pt(100, 50)), expected);
        assert_eq!(normalize_drag(pt(100, 50), pt(10, 20)), expected);
        assert_eq!(normalize_drag(pt(10, 50), pt(100, 20)), expected);
        assert_eq!(normalize_drag(pt(100, 20), pt(10, 50)), expected);
    }

    #[test]
    fn a_click_is_a_one_pixel_rect_and_not_usable() {
        let rect = normalize_drag(pt(5, 5), pt(5, 5));
        assert_eq!(rect, PhysRect { x: 5, y: 5, w: 1, h: 1 });
        assert!(!is_usable(rect));
        assert!(is_usable(normalize_drag(pt(5, 5), pt(7, 7))), "3x3 is the minimum");
    }

    #[test]
    fn clamp_handles_negative_origins_and_overhang() {
        // A monitor left of the primary has negative virtual coordinates.
        let bounds = PhysRect { x: -1920, y: 0, w: 1920, h: 1080 };
        let rect = PhysRect { x: -2000, y: -50, w: 300, h: 200 };
        assert_eq!(clamp_to(rect, bounds), PhysRect { x: -1920, y: 0, w: 220, h: 150 });
        // Entirely outside collapses to empty rather than producing a nonsense rect.
        let outside = PhysRect { x: 10, y: 10, w: 5, h: 5 };
        assert!(clamp_to(outside, bounds).is_empty());
    }

    #[test]
    fn clamp_point_keeps_drags_on_the_monitor() {
        assert_eq!(clamp_point(pt(-40, 5000), 1920, 1080), pt(0, 1079));
        assert_eq!(clamp_point(pt(99_999, -1), 2560, 1440), pt(2559, 0));
    }

    #[test]
    fn client_to_frame_is_identity_when_sizes_match() {
        let rect = PhysRect { x: 100, y: 200, w: 300, h: 150 };
        assert_eq!(client_to_frame(rect, 1920, 1080, 1920, 1080), rect);
    }

    #[test]
    fn client_to_frame_scales_and_reaches_the_far_edge() {
        // Client reports half the frame's pixels: a full-width selection must cover the full frame.
        let full = PhysRect { x: 0, y: 0, w: 960, h: 540 };
        assert_eq!(
            client_to_frame(full, 960, 540, 1920, 1080),
            PhysRect { x: 0, y: 0, w: 1920, h: 1080 }
        );
        let mid = PhysRect { x: 480, y: 270, w: 10, h: 10 };
        assert_eq!(
            client_to_frame(mid, 960, 540, 1920, 1080),
            PhysRect { x: 960, y: 540, w: 20, h: 20 }
        );
    }

    #[test]
    fn client_to_frame_rejects_degenerate_sizes() {
        let rect = PhysRect { x: 0, y: 0, w: 10, h: 10 };
        assert!(client_to_frame(rect, 0, 1080, 1920, 1080).is_empty());
        assert!(client_to_frame(rect, 1920, 1080, 1920, 0).is_empty());
    }

    #[test]
    fn union_and_inflate_cover_the_repaint_area() {
        let a = PhysRect { x: 10, y: 10, w: 10, h: 10 };
        let b = PhysRect { x: 15, y: 30, w: 10, h: 10 };
        assert_eq!(a.union(b), PhysRect { x: 10, y: 10, w: 15, h: 30 });
        assert_eq!(a.union(PhysRect::default()), a);
        assert_eq!(a.inflate(4), PhysRect { x: 6, y: 6, w: 18, h: 18 });
    }
}
