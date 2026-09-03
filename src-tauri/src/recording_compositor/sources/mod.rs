//! Recording-only compositor sources. Instant Replay never reads these.
//!
//! # Alpha invariant
//!
//! Every CPU texture uploaded to the compositor is **straight
//! (non-premultiplied) BGRA8**:
//!
//! - `RGB` is the unassociated color
//! - `A` is coverage / opacity
//!
//! VideoProcessor **ignores per-pixel alpha**. It only applies planar
//! `VideoProcessorSetStreamAlpha` (whole-source opacity). Capture and webcam
//! stay on that path because they are opaque (`A = 255`).
//!
//! PNG / text / overlay / HUD use the Draw blender (`still_blend.rs`):
//! `out.rgb = src.rgb * (src.a * opacity) + dst.rgb * (1 - src.a * opacity)`
//!
//! Do **not** premultiply. Do **not** flatten against black. Color-key
//! (`RGB == 0` means transparent) is forbidden — black text and dark PNG
//! pixels must stay visible.
//!
//! | Source  | RGB                         | A                    |
//! |---------|-----------------------------|----------------------|
//! | Capture | gameplay pixels             | 255                  |
//! | Webcam  | camera pixels               | 255                  |
//! | JPEG    | decoded pixels              | 255                  |
//! | PNG     | decoded pixels (straight)   | file alpha           |
//! | Text    | requested color             | glyph coverage       |
//! | Overlay | generated color             | generated coverage   |
//! | HUD     | requested color             | glyph coverage       |

#![cfg(windows)]

pub mod capture;
pub mod image;
pub mod overlay;
pub mod text;
pub mod webcam;
