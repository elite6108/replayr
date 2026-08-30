//! Cloud webcam compose: GPU DXGI first, then CPU NV12, then CPU BGRA.

use std::path::Path;
use std::time::Instant;

use crate::overlay::OverlayLayout;

use super::audio::spawn_compose_audio;
use super::types::{ComposeMode, WebcamComposeOpts};

mod cpu_bgra;
mod cpu_nv12;
mod gpu_dxgi;
pub mod sizing;

pub(crate) use cpu_bgra::compose_webcam_rgb32;
pub(crate) use cpu_nv12::compose_webcam_nv12;

pub(crate) fn blank_direct_mft_long_test(frames: u64) -> Result<String, String> {
    unsafe {
        windows::Win32::Media::MediaFoundation::MFStartup(
            windows::Win32::Media::MediaFoundation::MF_VERSION,
            windows::Win32::Media::MediaFoundation::MFSTARTUP_FULL,
        )
        .map_err(|err| err.to_string())?;
    }
    gpu_dxgi::run_blank_direct_mft_long_test(frames)
}

pub(crate) fn now() -> Instant {
    Instant::now()
}

pub(crate) fn log_attempt(mode: ComposeMode, extra: &str) {
    tracing::info!(mode = mode.as_str(), extra, "starting webcam compose");
}

pub(crate) fn compose_webcam(
    gameplay: &Path,
    webcam: &Path,
    output: &Path,
    layout: &OverlayLayout,
    start_hns: i64,
    end_hns: i64,
    fps: u32,
    watermark: bool,
    opts: WebcamComposeOpts,
) -> Result<i64, String> {
    if watermark {
        tracing::info!("watermark requested; gpu_dxgi compose is skipped for this clip");
    } else {
        match gpu_dxgi::compose(
            gameplay,
            webcam,
            output,
            layout,
            start_hns,
            end_hns,
            fps,
            opts.clone(),
        ) {
            Ok(report) => {
                report.log();
                return Ok(report.written_ms);
            }
            Err(err) => {
                if std::env::var("REPLAYR_GPU_COMPOSE_NO_FALLBACK")
                    .ok()
                    .as_deref()
                    == Some("1")
                {
                    tracing::error!(
                        %err,
                        mode = "gpu_dxgi",
                        "REPLAYR_GPU_COMPOSE_NO_FALLBACK=1; gpu_dxgi stopped without cpu_nv12"
                    );
                    return Err(err);
                }
                if err.contains("gpu_dxgi_first_failing_boundary=") {
                    tracing::error!(
                        %err,
                        mode = "gpu_dxgi",
                        "gpu_dxgi first failing boundary logged; trying cpu_nv12"
                    );
                } else {
                    tracing::warn!(
                        %err,
                        mode = "gpu_dxgi",
                        "DXGI compose failed before the first-frame probe; trying cpu_nv12"
                    );
                }
                let _ = std::fs::remove_file(output);
            }
        }
    }

    log_attempt(ComposeMode::CpuNv12, "CPU NV12 scale/overlay");
    match compose_webcam_nv12(
        gameplay,
        webcam,
        output,
        layout,
        start_hns,
        end_hns,
        fps,
        watermark,
        opts.clone(),
        spawn_compose_audio(gameplay, start_hns, end_hns),
    ) {
        Ok(written) => {
            tracing::info!(
                mode = ComposeMode::CpuNv12.as_str(),
                compositor = "cpu_nv12",
                dxgi = false,
                written_ms = written,
                "webcam compose finished"
            );
            Ok(written)
        }
        Err(err) => {
            tracing::warn!(
                %err,
                mode = ComposeMode::CpuNv12.as_str(),
                "NV12 compose failed; trying cpu_bgra"
            );
            let _ = std::fs::remove_file(output);
            log_attempt(ComposeMode::CpuBgra, "CPU BGRA last-resort");
            let written = compose_webcam_rgb32(
                gameplay,
                webcam,
                output,
                layout,
                start_hns,
                end_hns,
                fps,
                watermark,
                opts,
                spawn_compose_audio(gameplay, start_hns, end_hns),
            )?;
            tracing::info!(
                mode = ComposeMode::CpuBgra.as_str(),
                compositor = "cpu_bgra",
                dxgi = false,
                written_ms = written,
                "webcam compose finished"
            );
            Ok(written)
        }
    }
}
