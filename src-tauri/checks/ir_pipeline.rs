//! Standalone Windows test harness: production IR encode/remux modules without
//! loading Tauri or starting the application. Compile with rustc --test and the
//! windows 0.61, tracing, mp4, tempfile, and serde dependencies from the Cargo build.
#![allow(dead_code)]

#[path = "../src/capture_timing.rs"]
mod capture_timing;
#[path = "../src/ir_runtime.rs"]
mod ir_runtime;
#[path = "../src/buffer.rs"]
mod buffer;
#[path = "../src/recording_bitrate.rs"]
mod recording_bitrate;
#[path = "../src/encode.rs"]
mod encode;
#[path = "ir_export.rs"]
mod export;
