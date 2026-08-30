use std::path::Path;
use std::time::Instant;

use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

use crate::overlay::OverlayLayout;

use super::super::audio::fit_pcm_to_video;
use super::super::progress::expected_compose_frames;
use super::super::types::WebcamComposeOpts;
use super::super::webcam::{overlay_webcam_bgra, WebcamFollow};
use super::super::writer::open_compose_writer;
use super::sizing::fit_compose_size;

/// One composed BGRA frame between the decode and encode threads.
struct ComposeFrame {
    bgra: Vec<u8>,
    width: u32,
    height: u32,
    pitch: u32,
    duration: i64,
}

/// Four 1080p BGRA frames is about 32 MB — enough overlap without hoarding the clip.
const COMPOSE_QUEUE_CAP: usize = 4;

pub(crate) fn compose_webcam_rgb32(
    gameplay: &Path,
    webcam: &Path,
    output: &Path,
    layout: &OverlayLayout,
    start_hns: i64,
    end_hns: i64,
    fps: u32,
    watermark: bool,
    opts: WebcamComposeOpts,
    audio_rx: std::sync::mpsc::Receiver<Vec<u8>>,
) -> Result<i64, String> {
    let started = Instant::now();
    let reader = crate::thumb::open_rgb_reader(gameplay)?;
    if start_hns > 0 {
        crate::thumb::seek_hns(&reader, start_hns)?;
    }
    let mut follow = WebcamFollow::open(webcam, start_hns, end_hns)?;
    let Some((first, first_ts, first_duration)) = crate::thumb::read_rgb_sample(&reader)? else {
        return Err("That clip has no video.".into());
    };
    if first_ts >= end_hns {
        return Err("That range did not include any video.".into());
    }
    let fps = fps.clamp(24, 60);
    let (out_w, out_h) =
        fit_compose_size(first.width, first.height, opts.max_width, opts.max_height);
    let expected = expected_compose_frames(start_hns, end_hns, fps);
    if let Some(progress) = opts.progress.as_ref() {
        progress(0, expected);
    }
    if (out_w, out_h) != (first.width, first.height) {
        tracing::info!(
            src = format!("{}x{}", first.width, first.height),
            dest = format!("{out_w}x{out_h}"),
            "scaling webcam compose for cloud upload"
        );
    }
    let layout = layout.clone();
    let dest = output.to_path_buf();
    let quality = opts.quality;
    let (frames_tx, frames_rx) = std::sync::mpsc::sync_channel::<ComposeFrame>(COMPOSE_QUEUE_CAP);
    let (spare_tx, spare_rx) = std::sync::mpsc::channel::<Vec<u8>>();

    // Decode and encode on separate threads so the sink writer can stay throttled
    // (WriteSample blocks) instead of queuing the whole clip in memory.
    let encoder = std::thread::Builder::new()
        .name("compose-encode".into())
        .spawn(move || -> Result<(i64, u32), String> {
            unsafe {
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            }
            let mut writer: Option<crate::encode::MfWriter> = None;
            let mut clock = 0_i64;
            let mut frames = 0_u32;
            while let Ok(frame) = frames_rx.recv() {
                let writer = match writer {
                    Some(ref mut writer) => writer,
                    None => {
                        let bitrate = quality.bitrate_for(frame.width, frame.height, fps);
                        writer.insert(open_compose_writer(
                            &dest,
                            frame.width,
                            frame.height,
                            fps,
                            bitrate,
                            true,
                        )?)
                    }
                };
                writer.write_bgra(
                    &frame.bgra,
                    frame.pitch,
                    frame.width,
                    frame.height,
                    clock,
                    frames == 0,
                )?;
                clock += frame.duration.max(1);
                frames += 1;
                let _ = spare_tx.send(frame.bgra);
            }
            let Some(mut writer) = writer else {
                return Err("That clip has no video.".into());
            };
            let mut audio = audio_rx.recv().unwrap_or_default();
            if !audio.is_empty() {
                let _ = fit_pcm_to_video(&mut audio, writer.timestamp());
                writer.write_pcm_closing(&audio)?;
            } else {
                let _ = writer.write_pcm_closing(&[]);
            }
            let written_ms = (writer.timestamp() / 10_000).max(0);
            writer.finish()?;
            Ok((written_ms, frames))
        })
        .map_err(|err| format!("Could not start the compose encoder: {err}"))?;

    let mut frame = first;
    let mut timestamp = first_ts;
    let mut duration = first_duration;
    let mut decode_error = None;
    let mut done = 0_u32;
    loop {
        if (frame.width, frame.height) != (out_w, out_h) {
            frame = crate::still::scale_bgra_to(frame, out_w, out_h);
        }
        follow.ensure_at(timestamp);
        follow.log_sample(timestamp.saturating_sub(first_ts).max(0), false);
        if let Some(cam) = follow.current_frame() {
            overlay_webcam_bgra(&mut frame, cam, &layout);
        }
        if watermark {
            crate::still::composite_watermark(&mut frame);
        }
        let bgra = if let Ok(mut spare) = spare_rx.try_recv() {
            if spare.len() == frame.bgra.len() {
                spare.copy_from_slice(&frame.bgra);
                spare
            } else {
                std::mem::take(&mut frame.bgra)
            }
        } else {
            std::mem::take(&mut frame.bgra)
        };
        let queued = ComposeFrame {
            bgra,
            width: frame.width,
            height: frame.height,
            pitch: frame.pitch,
            duration,
        };
        if frames_tx.send(queued).is_err() {
            break;
        }
        done = done.saturating_add(1);
        if let Some(progress) = opts.progress.as_ref() {
            if done == 1 || done % 15 == 0 || (expected > 0 && done >= expected) {
                progress(done, expected.max(done));
            }
        }
        match crate::thumb::read_rgb_sample(&reader) {
            Ok(Some((next, next_ts, next_duration))) => {
                if next_ts >= end_hns {
                    break;
                }
                frame = next;
                timestamp = next_ts;
                duration = next_duration;
            }
            Ok(None) => break,
            Err(err) => {
                decode_error = Some(err);
                break;
            }
        }
    }
    drop(frames_tx);
    drop(reader);

    let (written_ms, frames) = encoder
        .join()
        .map_err(|_| "The compose encoder stopped unexpectedly.".to_string())??;
    if let Some(err) = decode_error {
        return Err(err);
    }
    if frames == 0 {
        return Err("That range did not include any video.".into());
    }
    if let Some(progress) = opts.progress.as_ref() {
        progress(frames, expected.max(frames));
    }
    tracing::info!(
        "composed {} + {} -> {} ({}x{}, {} ms, {} frames) in {} ms",
        gameplay.display(),
        webcam.display(),
        output.display(),
        out_w,
        out_h,
        written_ms,
        frames,
        started.elapsed().as_millis()
    );
    Ok(written_ms)
}
