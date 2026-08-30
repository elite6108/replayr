use std::path::Path;
use std::time::Instant;

use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

use crate::overlay::OverlayLayout;

use super::super::audio::{fit_pcm_to_video, probe_copyable_audio, remux_aac};
use super::super::progress::expected_compose_frames;
use super::super::types::WebcamComposeOpts;
use super::super::watermark::{WatermarkFrame, WATERMARK_QUEUE_CAP};
use super::super::webcam::{overlay_webcam_nv12, WebcamFollow};
use super::super::writer::open_compose_writer_nv12;
use super::sizing::fit_compose_size;

pub(crate) fn compose_webcam_nv12(
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
    let reader = crate::thumb::open_nv12_reader(gameplay)?;
    if start_hns > 0 {
        crate::thumb::seek_hns(&reader, start_hns)?;
    }
    let mut follow = WebcamFollow::open(webcam, start_hns, end_hns)?;
    let mut planes = Vec::new();
    let Some(first) = crate::thumb::read_nv12_sample(&reader, &mut planes)? else {
        return Err("That clip has no video.".into());
    };
    if first.timestamp >= end_hns {
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
            "scaling NV12 webcam compose for cloud upload"
        );
    }
    let layout = layout.clone();
    let dest = output.to_path_buf();
    let gameplay_audio = gameplay.to_path_buf();
    let quality = opts.quality;
    let (frames_tx, frames_rx) =
        std::sync::mpsc::sync_channel::<WatermarkFrame>(WATERMARK_QUEUE_CAP);
    let (spare_tx, spare_rx) = std::sync::mpsc::channel::<Vec<u8>>();

    let encoder = std::thread::Builder::new()
        .name("compose-nv12-encode".into())
        .spawn(move || -> Result<(i64, u32), String> {
            unsafe {
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            }
            let copy_audio = probe_copyable_audio(&gameplay_audio);
            let mut writer: Option<crate::encode::MfWriter> = None;
            let mut clock = 0_i64;
            let mut frames = 0_u32;
            while let Ok(frame) = frames_rx.recv() {
                let writer = match writer {
                    Some(ref mut writer) => writer,
                    None => {
                        let bitrate = quality.bitrate_for(frame.width, frame.height, fps);
                        let audio = match copy_audio.clone() {
                            Some(media_type) => crate::encode::WriterAudio::Copy(media_type),
                            None => crate::encode::WriterAudio::PcmEncode,
                        };
                        writer.insert(open_compose_writer_nv12(
                            &dest,
                            frame.width,
                            frame.height,
                            fps,
                            bitrate,
                            audio,
                        )?)
                    }
                };
                writer.write_nv12(&frame.planes, frame.pitch, frame.height, clock, frames == 0)?;
                clock += frame.duration.max(1);
                frames += 1;
                let _ = spare_tx.send(frame.planes);
            }
            let Some(mut writer) = writer else {
                return Err("That clip has no video.".into());
            };
            if copy_audio.is_some() {
                let _ = remux_aac(&mut writer, &gameplay_audio, start_hns, end_hns);
            } else {
                let mut audio = audio_rx.recv().unwrap_or_default();
                if !audio.is_empty() {
                    let _ = fit_pcm_to_video(&mut audio, writer.timestamp());
                    writer.write_pcm_closing(&audio)?;
                } else {
                    let _ = writer.write_pcm_closing(&[]);
                }
            }
            let written_ms = (writer.timestamp() / 10_000).max(0);
            writer.finish()?;
            Ok((written_ms, frames))
        })
        .map_err(|err| format!("Could not start the compose encoder: {err}"))?;

    let first_ts = first.timestamp;
    let mut info = first;
    let mut decode_error = None;
    let mut done = 0_u32;
    loop {
        let mut packed = if (info.width, info.height) != (out_w, out_h) || info.pitch != out_w {
            crate::camera::color::scale_nv12(
                &planes,
                info.width,
                info.height,
                info.pitch as usize,
                out_w,
                out_h,
            )
            .ok_or_else(|| "Could not scale gameplay for cloud upload.".to_string())?
        } else if let Ok(mut spare) = spare_rx.try_recv() {
            if spare.len() == planes.len() {
                spare.copy_from_slice(&planes);
                spare
            } else {
                planes.clone()
            }
        } else {
            planes.clone()
        };
        follow.ensure_at(info.timestamp);
        follow.log_sample(info.timestamp.saturating_sub(first_ts).max(0), false);
        if let Some(cam) = follow.current_frame() {
            overlay_webcam_nv12(&mut packed, out_w, out_w, out_h, cam, &layout);
        }
        if watermark {
            crate::still::composite_watermark_nv12(&mut packed, out_w as usize, out_w, out_h);
        }
        let queued = WatermarkFrame {
            planes: packed,
            width: out_w,
            height: out_h,
            pitch: out_w,
            duration: info.duration,
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
        match crate::thumb::read_nv12_sample(&reader, &mut planes) {
            Ok(Some(next)) => {
                if next.timestamp >= end_hns {
                    break;
                }
                info = next;
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
        "composed {} + {} -> {} ({}x{} nv12, {} ms, {} frames) in {} ms",
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
