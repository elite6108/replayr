//! Recording-only compositor sources. Instant Replay never reads these.
//!
//! # Alpha invariant
//!
//! Every CPU texture uploaded to the compositor is **straight
//! (non-premultiplied) BGRA**:
//!
//! - `RGB` is the unassociated color
//! - `A` is coverage / opacity
//!
//! `VideoProcessorBlt` blends:
//! `out = src.rgb * src.a * stream_a + dst.rgb * (1 - src.a * stream_a)`
//!
//! Do **not** premultiply. Premul + this blender darkens antialiased edges
//! (halos on logos and light text). Color-key (`RGB == 0` means transparent)
//! is forbidden — black text and dark PNG pixels must stay visible.
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
