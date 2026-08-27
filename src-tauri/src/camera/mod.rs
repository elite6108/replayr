//! Long-lived camera engine. Phase 1 enumerates devices and previews.
//! Phase 2 can write a standalone webcam MP4. Phase 3 shares SessionClock
//! with gameplay capture. Phase 4 writes Instant Replay webcam segments
//! as a separate source; F10 remuxes overlapping webcam without burning
//! it into gameplay.
//!
//! Webcam remains optional: gameplay recording never depends on this module.

mod clock;
mod color;
mod engine;
mod format;
mod ring;
mod safety;
mod types;

#[cfg(windows)]
mod device;
#[cfg(windows)]
mod encoder;
#[cfg(windows)]
mod preview;
#[cfg(windows)]
mod record;
#[cfg(windows)]
mod roll;

#[allow(unused_imports)]
pub use clock::{
    overlapping_segments, remux_paths, segment_bounds, segment_index, webcam_sidecar_path, CameraClockMap,
    SessionClock, SEGMENT_HNS, WEBCAM_SYNC_DELAY_HNS,
};
#[allow(unused_imports)]
pub use engine::{estimate_storage_mb_per_minute, CameraEngine};
#[allow(unused_imports)]
pub use format::{
    estimated_mb_per_minute, pick_camera_mode, suggested_webcam_presets, webcam_bitrate_bps, CameraMode,
    CameraSubtype, RequestedMode,
};
#[allow(unused_imports)]
pub use ring::WEBCAM_ROTATE_TIMEOUT;
#[allow(unused_imports)]
pub use safety::{TEST_RECORD_SECONDS, webcam_encode_should_abort};
#[allow(unused_imports)]
pub use types::{CameraAvailability, CameraDeviceInfo, CameraStatus, PreviewFrame, PreviewRequest};
