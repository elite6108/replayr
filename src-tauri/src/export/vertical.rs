use std::path::Path;
use std::time::Instant;

use windows::Win32::Media::MediaFoundation::{MFStartup, MFSTARTUP_FULL, MF_VERSION};

use super::audio::{decode_audio_range, fit_pcm_to_video};
use super::types::WebcamCompose;
use super::webcam::{overlay_webcam_bgra, WebcamFollow};

const SHORT_WIDTH: u32 = 1080;
const SHORT_HEIGHT: u32 = 1920;
const SHORT_BITRATE: u32 = 15_000_000;

/// Re-encodes `start_hns..end_hns` as 1080x1920 9:16. `pan` 0 is left, 1 is right.
/// Optional webcam is overlaid on the cropped canvas; a missing/failed webcam
/// leaves a gameplay-only Short.
pub fn write_vertical_mp4(
    input: &Path,
    output: &Path,
    start_hns: i64,
    end_hns: i64,
    pan: f32,
    fps: u32,
    overlay: Option<&WebcamCompose>,
) -> Result<i64, String> {
    if !input.exists() {
        return Err("That clip is no longer on disk.".into());
    }
    if end_hns <= start_hns {
        return Err("Choose a longer selection.".into());
    }
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let started = Instant::now();
    unsafe {
        MFStartup(MF_VERSION, MFSTARTUP_FULL).map_err(|err| err.to_string())?;
    }

    let pcm = decode_audio_range(input, start_hns, end_hns).unwrap_or_default();
    let has_audio = !pcm.is_empty();
    // Same single-thread BGRA pitfall as compose_webcam_mp4 — disable sink throttling.
    let mut writer = crate::encode::MfWriter::create(
        output,
        SHORT_WIDTH,
        SHORT_HEIGHT,
        fps,
        SHORT_BITRATE,
        has_audio,
        None,
        true,
        crate::encode::VideoInput::Bgra,
        false,
    )?;

    let reader = crate::thumb::open_rgb_reader(input)?;
    if start_hns > 0 {
        crate::thumb::seek_hns(&reader, start_hns)?;
    }
    let mut webcam = match overlay {
        Some(overlay) => match WebcamFollow::open(&overlay.path, start_hns) {
            Ok(follow) => Some(follow),
            Err(err) => {
                tracing::warn!(%err, "webcam overlay skipped for this Short; encoding gameplay only");
                None
            }
        },
        None => None,
    };
    let mut origin: Option<i64> = None;
    let mut clock = 0_i64;
    let mut frames = 0_u32;
    loop {
        let Some((frame, timestamp, duration)) = crate::thumb::read_rgb_sample(&reader)? else {
            break;
        };
        if timestamp >= end_hns && origin.is_some() {
            break;
        }
        let base = *origin.get_or_insert(timestamp);
        if timestamp >= end_hns {
            break;
        }
        let from_source = (timestamp - base).max(0);
        let capture_hns = if from_source > clock {
            from_source
        } else {
            clock
        };
        let mut vertical =
            crate::still::crop_and_scale_9x16(&frame, pan, SHORT_WIDTH, SHORT_HEIGHT);
        if let Some(follow) = webcam.as_mut() {
            follow.ensure_at(timestamp);
        }
        if let Some(cam_frame) = webcam.as_ref().and_then(|follow| follow.current_frame()) {
            if let Some(overlay) = overlay {
                overlay_webcam_bgra(&mut vertical, cam_frame, &overlay.layout);
            }
        }
        writer.write_bgra(
            &vertical.bgra,
            vertical.pitch,
            vertical.width,
            vertical.height,
            capture_hns,
            frames == 0,
        )?;
        clock = capture_hns + duration;
        frames += 1;
    }
    drop(reader);

    if frames == 0 {
        return Err("That range did not include any video.".into());
    }

    let video_hns = writer.timestamp();
    if has_audio {
        let mut audio = pcm;
        let _ = fit_pcm_to_video(&mut audio, video_hns);
        writer.write_pcm_closing(&audio)?;
    } else {
        let _ = writer.write_pcm_closing(&[]);
    }
    let written_ms = (writer.timestamp() / 10_000).max(0);
    writer.finish()?;
    tracing::info!(
        "short {} -> {} ({} ms, {} frames) in {} ms",
        input.display(),
        output.display(),
        written_ms,
        frames,
        started.elapsed().as_millis()
    );
    Ok(written_ms)
}
