//! Standalone Windows test harness: production IR encode/remux modules without
//! loading Tauri or starting the application. Compile with rustc --test and the
//! windows 0.61, tracing, mp4, and tempfile dependencies from the Cargo build.
#![allow(dead_code)]

#[path = "../src/capture_timing.rs"]
mod capture_timing;
#[path = "../src/encode.rs"]
mod encode;
#[path = "ir_export.rs"]
mod export;
