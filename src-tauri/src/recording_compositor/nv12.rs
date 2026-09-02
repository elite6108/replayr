//! GPU NV12 helpers for composed session recording.

#![cfg(windows)]

use super::transforms::even_size;

pub fn align_output(width: u32, height: u32) -> (u32, u32) {
    even_size(width.clamp(320, 3840), height.clamp(240, 2160))
}
