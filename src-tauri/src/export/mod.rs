mod audio;
mod compose;
mod copy_remux;
mod faststart;
pub(crate) mod mux;
mod progress;
mod remux;
mod session_place;
mod types;
mod vertical;
mod watermark;
mod webcam;
mod writer;

#[allow(unused_imports)]
pub(crate) use audio::{fit_pcm_to_video, spawn_compose_audio};
pub use compose::sizing::fit_compose_size;
#[allow(unused_imports)]
pub(crate) use compose::{blank_direct_mft_long_test, compose_webcam_nv12, compose_webcam_rgb32};
#[allow(unused_imports)]
pub(crate) use progress::expected_compose_frames;
pub use copy_remux::{remux_composed_mp4, remux_composed_mp4_in_place, CopyRemuxStats};
pub use faststart::faststart_mp4_in_place;
pub use remux::{concat_mp4s, concat_mp4s_preserve_timeline, trim_mp4, ConcatSegment};
pub use session_place::TimelineBasis;
#[allow(unused_imports)]
pub use types::{
    ComposeProgress, ComposeQuality, WebcamCompose, WebcamComposeOpts, CLOUD_COMPOSE_MAX_HEIGHT,
    CLOUD_COMPOSE_MAX_WIDTH,
};
pub use vertical::write_vertical_mp4;
pub use watermark::{should_watermark_exports, watermarked_temp, write_watermarked_mp4};

use std::path::Path;

use windows::Win32::Media::MediaFoundation::{MFStartup, MFSTARTUP_FULL, MF_VERSION};

/// Decode-only webcam follow audit. Does not encode or remux.
pub fn audit_webcam_timeline(
    gameplay: &Path,
    webcam: &Path,
    start_hns: i64,
    end_hns: i64,
) -> Result<String, String> {
    unsafe {
        MFStartup(MF_VERSION, MFSTARTUP_FULL).map_err(|err| err.to_string())?;
    }
    webcam::audit_webcam_timeline(gameplay, webcam, start_hns, end_hns)
}

/// Timeline-driven compositor. Gameplay PTS is the master clock; webcam is
/// sampled at the same timestamp and blitted with `layout`. Optional watermark
/// is applied after the overlay. `end_hns <= 0` reads until end of stream.
pub fn compose_webcam_mp4(
    gameplay: &Path,
    webcam: &Path,
    output: &Path,
    layout: &crate::overlay::OverlayLayout,
    start_hns: i64,
    end_hns: i64,
    fps: u32,
    watermark: bool,
) -> Result<i64, String> {
    compose_webcam_mp4_inner(
        gameplay,
        webcam,
        output,
        layout,
        start_hns,
        end_hns,
        fps,
        watermark,
        WebcamComposeOpts::native(),
    )
}

/// A compose that timed out is still encoding. The next compose waits so we
/// never stack two full-resolution re-encodes (that is what blew RAM to 17 GB).
static ORPHAN_COMPOSE: std::sync::Mutex<Option<std::thread::JoinHandle<()>>> =
    std::sync::Mutex::new(None);

fn reap_orphan_compose() {
    let handle = ORPHAN_COMPOSE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take();
    if let Some(handle) = handle {
        tracing::warn!("waiting for a previous webcam compose to finish");
        let _ = handle.join();
    }
}

/// Same as [`compose_webcam_mp4`], but aborts if composition exceeds `timeout`.
pub fn compose_webcam_mp4_timed(
    gameplay: &Path,
    webcam: &Path,
    output: &Path,
    layout: &crate::overlay::OverlayLayout,
    start_hns: i64,
    end_hns: i64,
    fps: u32,
    watermark: bool,
    timeout: std::time::Duration,
    opts: WebcamComposeOpts,
) -> Result<i64, String> {
    reap_orphan_compose();
    let gameplay = gameplay.to_path_buf();
    let webcam = webcam.to_path_buf();
    let output = output.to_path_buf();
    let layout = layout.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    let handle = std::thread::Builder::new()
        .name("compose-webcam".into())
        .spawn(move || {
            let result = compose_webcam_mp4_inner(
                &gameplay, &webcam, &output, &layout, start_hns, end_hns, fps, watermark, opts,
            );
            let _ = tx.send(result);
        })
        .map_err(|err| err.to_string())?;
    match rx.recv_timeout(timeout) {
        Ok(result) => {
            let _ = handle.join();
            result
        }
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            *ORPHAN_COMPOSE
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(handle);
            Err("Webcam compose timed out. Try again or turn webcam off for this clip.".into())
        }
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
            let _ = handle.join();
            Err("Webcam compose stopped unexpectedly.".into())
        }
    }
}

fn compose_webcam_mp4_inner(
    gameplay: &Path,
    webcam: &Path,
    output: &Path,
    layout: &crate::overlay::OverlayLayout,
    start_hns: i64,
    end_hns: i64,
    fps: u32,
    watermark: bool,
    opts: WebcamComposeOpts,
) -> Result<i64, String> {
    if !gameplay.exists() {
        return Err("That clip is no longer on disk.".into());
    }
    if !webcam.exists() {
        return Err("Webcam sidecar is no longer on disk.".into());
    }
    if gameplay == output {
        return Err("Composed output cannot replace the original file.".into());
    }
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    unsafe {
        MFStartup(MF_VERSION, MFSTARTUP_FULL).map_err(|err| err.to_string())?;
    }

    let end_hns = if end_hns <= 0 { i64::MAX } else { end_hns };
    compose::compose_webcam(
        gameplay, webcam, output, layout, start_hns, end_hns, fps, watermark, opts,
    )
}

#[cfg(test)]
mod tests {
    #[test]
    #[ignore = "needs a local Instant Replay clip with webcam sidecar"]
    fn compose_display_clip_nv12_under_3_minutes() {
        let _ = tracing_subscriber::fmt()
            .with_max_level(tracing::Level::INFO)
            .with_test_writer()
            .try_init();
        let gameplay =
            std::path::PathBuf::from(r"C:\Users\gordo\Videos\Project Replay\clip-1787970963.mp4");
        let webcam = std::path::PathBuf::from(
            r"C:\Users\gordo\Videos\Project Replay\clip-1787970963-webcam.mp4",
        );
        assert!(
            gameplay.is_file(),
            "gameplay clip missing: {}",
            gameplay.display()
        );
        assert!(
            webcam.is_file(),
            "webcam sidecar missing: {}",
            webcam.display()
        );
        let output = gameplay.with_file_name("clip-1787970963.verify-nv12.mp4");
        let _ = std::fs::remove_file(&output);
        let started = std::time::Instant::now();
        let written_ms = super::compose_webcam_mp4_timed(
            &gameplay,
            &webcam,
            &output,
            &crate::overlay::OverlayLayout::default(),
            0,
            0,
            60,
            false,
            std::time::Duration::from_secs(240),
            super::WebcamComposeOpts::cloud(None),
        )
        .expect("NV12 webcam compose");
        let elapsed_ms = started.elapsed().as_millis();
        let size = std::fs::metadata(&output)
            .map(|meta| meta.len())
            .unwrap_or(0);
        println!("verify compose wrote {written_ms} ms video ({size} bytes) in {elapsed_ms} ms");
        let _ = std::fs::remove_file(&output);
        assert!(
            size > 1_000_000,
            "composed file was too small: {size} bytes"
        );
        assert!(
            elapsed_ms < 180_000,
            "compose took {elapsed_ms} ms; expected under 180000"
        );
    }
}
