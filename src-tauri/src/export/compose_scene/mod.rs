//! Offline overlay burn for saved Instant Replay clips.
//!
//! Runs on a file that is already on disk, after the remux and after the replay ring has been
//! unlocked. It never starts the live `recording_compositor`, never touches the encode pump, and
//! never restarts Instant Replay. What it reuses from that module is pure: the validated scene
//! types, the transform math, the GDI text rasterizer, the filter chrome bitmaps, and
//! `filters::tune_for`.
//!
//! Layer order matches `src/recording/composedSemantics.ts`:
//!   1. base gameplay frame (crop, then contain into the capture transform)
//!   2. base filter (colour grading, on the gameplay rect only)
//!   3. image and text layers by z-order
//!   4. filter chrome (vignette / letterbox / scanlines / frame)
//!   5. HUD (REC, filter label, timestamp)
//!
//! Webcam is deliberately absent: it stays a sidecar so the editor can keep moving it, and
//! share/upload compose it on top of whatever this produces.
//!
//! **Path choice: NV12 end to end.** Instant Replay decodes NV12 and the H.264 encoder consumes
//! NV12, so the burn never leaves that format. An earlier version composited in BGRA, which cost
//! two full-frame colour conversions per frame (NV12 -> RGB32 to decode, RGB32 -> NV12 to encode)
//! — roughly 8 million pixel operations of pure format shuffling against ~120 thousand for the
//! overlay itself. The GPU tier in `compose/gpu_dxgi` is not used: it is hard-pinned to
//! 1920x1080@60 and would silently downscale every 1440p, 4K, or 120 fps clip, and a GPU burn
//! competes with the game being recorded for the same device.
//!
//! Cost per frame is therefore a plane copy plus a blend over the region the overlays occupy.
//! Every layer except the ticking timestamp is static, so images, text, chrome and REC are
//! rasterized in BGRA once and converted to NV12 once.

#![cfg(windows)]

pub mod layers;
pub mod nv12;

use std::path::Path;
use std::sync::mpsc::sync_channel;
use std::time::Instant;

use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

use crate::clip_scene::ClipHudClock;
use crate::recording_compositor::filters::tune_for;
use crate::recording_compositor::scene::ValidatedComposition;
use crate::recording_compositor::transforms::{dest_rect, even_size};

use super::audio::{hns_to_pcm_bytes, probe_copyable_audio, spawn_compose_audio, AacSinkFeeder};
use super::types::ComposeQuality;
use super::writer::open_compose_writer_nv12;
use layers::build_static_sheet;
use nv12::{Nv12Canvas, Nv12Sheet, Nv12Tune};

/// Three 4K NV12 frames is about 36 MB — enough overlap to keep the encoder fed without hoarding
/// a long clip in memory.
const QUEUE_CAP: usize = 3;

pub struct ClipSceneComposeReport {
    pub written_ms: i64,
    pub frames: u32,
    pub width: u32,
    pub height: u32,
}

struct EncodedFrame {
    nv12: Vec<u8>,
    duration: i64,
}

/// A burn that blew its deadline is still encoding and still holding the hardware encoder. Park
/// it here and join it before the next one starts, rather than stacking two full-resolution
/// re-encodes.
static ORPHAN_BURN: std::sync::Mutex<Option<(std::thread::JoinHandle<()>, std::path::PathBuf)>> =
    std::sync::Mutex::new(None);

fn reap_orphan_burn() {
    let orphan = ORPHAN_BURN
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take();
    if let Some((handle, temp)) = orphan {
        tracing::warn!("waiting for a previous clip burn to finish");
        let _ = handle.join();
        let _ = std::fs::remove_file(&temp);
    }
}

/// [`compose_clip_scene`] with a deadline.
///
/// Media Foundation can stall in ways that are not recoverable from the outside, and a burn that
/// never returns would hold the `exporting` flag forever — leaving the UI stuck on "Saving…" and
/// blocking every later Save Clip until the app restarts. Past the deadline the caller gives up,
/// keeps the raw remux, and the clip still reaches the library.
pub(crate) fn compose_clip_scene_timed(
    source: &Path,
    dest: &Path,
    spec: &ValidatedComposition,
    hud: &ClipHudClock,
    fps: u32,
    expect_w: u32,
    expect_h: u32,
    timeout: std::time::Duration,
) -> Result<ClipSceneComposeReport, String> {
    reap_orphan_burn();

    let (tx, rx) = std::sync::mpsc::channel();
    let source = source.to_path_buf();
    let dest_owned = dest.to_path_buf();
    let spec = spec.clone();
    let hud = *hud;
    let handle = std::thread::Builder::new()
        .name("compose-clip".into())
        .spawn(move || {
            let result =
                compose_clip_scene(&source, &dest_owned, &spec, &hud, fps, expect_w, expect_h);
            let _ = tx.send(result);
        })
        .map_err(|err| format!("Could not start the clip burn: {err}"))?;

    match rx.recv_timeout(timeout) {
        Ok(result) => {
            let _ = handle.join();
            result
        }
        Err(_) => {
            *ORPHAN_BURN
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) =
                Some((handle, dest.to_path_buf()));
            Err("The clip burn took too long and was abandoned.".into())
        }
    }
}

/// Burn `spec` into `source`, writing `dest`. Video is re-encoded; audio is copied when it can be.
pub(crate) fn compose_clip_scene(
    source: &Path,
    dest: &Path,
    spec: &ValidatedComposition,
    hud: &ClipHudClock,
    fps: u32,
    expect_w: u32,
    expect_h: u32,
) -> Result<ClipSceneComposeReport, String> {
    if source == dest {
        return Err("The clip burn cannot write over its own source.".into());
    }
    // A webcam compose that timed out earlier is still holding the hardware encoder.
    super::reap_orphan_compose();
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }

    let started = Instant::now();
    // NV12 in, NV12 out. Instant Replay decodes NV12 and the encoder wants NV12, so staying in
    // that format for the whole burn removes two full-frame colour conversions per frame — the
    // cost that dominated the first version of this path.
    let reader = crate::thumb::open_nv12_reader(source)?;
    let mut decoded: Vec<u8> = Vec::new();
    let Some(first) = crate::thumb::read_nv12_sample(&reader, &mut decoded)? else {
        return Err("That clip has no video.".into());
    };

    // H.264 codes 1080p as 1088 rows (16-pixel macroblocks), and the NV12 reader reports that
    // coded size rather than the display size. Burning at the coded height would add a strip of
    // decoder padding to the bottom of every clip, so prefer the size Instant Replay captured
    // and treat the decoder's extra rows as padding to drop.
    let (decoded_w, decoded_h) = even_size(first.width, first.height);
    let (canvas_w, canvas_h) = display_size(expect_w, expect_h, decoded_w, decoded_h);
    if (canvas_w, canvas_h) != (decoded_w, decoded_h) {
        tracing::debug!(
            decoded = format!("{decoded_w}x{decoded_h}"),
            display = format!("{canvas_w}x{canvas_h}"),
            "clip burn trimming codec padding"
        );
    }
    let mut canvas = Nv12Canvas::new(canvas_w, canvas_h)?;
    let fps = fps.clamp(1, 240);
    let bitrate = ComposeQuality::High.bitrate_for(canvas_w, canvas_h, fps);

    let hud_scale = layers::hud_scale_for(canvas_h);
    // Images, text, filter chrome and REC are rasterized once in BGRA, then converted to NV12
    // once. Per frame they cost only a blend over the region they actually occupy.
    let bgra_sheet = build_static_sheet(spec, canvas_w, canvas_h, hud_scale);
    let sheet = if bgra_sheet.occupied {
        Nv12Sheet::from_bgra(&bgra_sheet.bgra, canvas_w, canvas_h, bgra_sheet.bounds)
    } else {
        None
    };
    let tune = Nv12Tune::new(tune_for(spec.filter));
    let show_clock = spec.hud.as_ref().map(|hud| hud.timestamp).unwrap_or(false);

    // Where the gameplay frame lands, which is also the only region the base filter grades.
    let capture_box = dest_rect(spec.capture.transform, canvas_w, canvas_h);
    // Codec padding is trimmed by `copy_from`, so a decoded frame that is only taller than the
    // canvas still counts as identity framing.
    let identity_capture = spec.capture.transform.is_full()
        && spec.capture.crop.is_full()
        && decoded_w == canvas_w
        && decoded_h >= canvas_h;
    if !identity_capture {
        // Cropping or repositioning gameplay needs a scaled NV12 blit, which this path does not
        // implement yet. Bail out rather than silently ignoring the user's framing; the caller
        // keeps the raw remux and the clip still saves.
        return Err("Clip framing (crop or reposition) is not supported by the burn yet.".into());
    }

    let (tx, rx) = sync_channel::<EncodedFrame>(QUEUE_CAP);
    let dest_owned = dest.to_path_buf();
    let source_owned = source.to_path_buf();
    let encoder = std::thread::Builder::new()
        .name("compose-clip-encode".into())
        .spawn(move || -> Result<(i64, u32), String> {
            unsafe {
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            }
            let copy_audio = probe_copyable_audio(&source_owned);
            let writer_audio = match copy_audio.clone() {
                Some(media_type) => crate::encode::WriterAudio::Copy(media_type),
                None => crate::encode::WriterAudio::PcmEncode,
            };
            let mut writer: Option<crate::encode::MfWriter> = None;
            // Audio has to be interleaved with video, not appended after it. Offline sink writers
            // keep MF throttling on, so a sink holding an audio stream that receives nothing will
            // block WriteSample on video once the streams drift — which deadlocks this thread and
            // then the decode loop behind it.
            let mut aac = if copy_audio.is_some() {
                match AacSinkFeeder::open(&source_owned, 0, i64::MAX) {
                    Ok(feeder) => Some(feeder),
                    Err(error) => {
                        tracing::warn!(%error, "clip burn could not open the audio track");
                        None
                    }
                }
            } else {
                None
            };
            let pcm_rx = if copy_audio.is_none() {
                Some(spawn_compose_audio(&source_owned, 0, i64::MAX))
            } else {
                None
            };
            let mut pcm_pending: Vec<u8> = Vec::new();
            let mut pcm_written: usize = 0;
            let mut clock: i64 = 0;
            let mut frames: u32 = 0;

            while let Ok(frame) = rx.recv() {
                if writer.is_none() {
                    writer = Some(open_compose_writer_nv12(
                        &dest_owned,
                        canvas_w,
                        canvas_h,
                        fps,
                        bitrate,
                        writer_audio.clone(),
                    )?);
                }
                let sink = writer.as_mut().expect("writer opened above");
                sink.write_nv12(&frame.nv12, canvas_w, canvas_h, clock, frames == 0)?;
                // Source frame durations drive the clock, so variable-rate IR output keeps its
                // original timing instead of being resampled to a nominal fps.
                clock += frame.duration.max(1);
                frames += 1;

                if let Some(feeder) = aac.as_mut() {
                    if let Err(error) = feeder.feed_until(sink, clock) {
                        tracing::warn!(%error, "clip burn stopped copying audio");
                        aac = None;
                    }
                } else if let Some(rx) = pcm_rx.as_ref() {
                    // The audio stream must keep pace with video even when the source is silent
                    // or the decoder is behind: a stream that never advances is what throttling
                    // blocks on. Wait briefly for real samples, then pad with silence.
                    let want = hns_to_pcm_bytes(clock);
                    while pcm_pending.len() + pcm_written < want {
                        match rx.recv_timeout(std::time::Duration::from_millis(50)) {
                            Ok(chunk) => pcm_pending.extend_from_slice(&chunk),
                            Err(_) => break,
                        }
                    }
                    let mut chunk_len = pcm_pending.len().min(want.saturating_sub(pcm_written));
                    let mut chunk: Vec<u8> = pcm_pending.drain(..chunk_len).collect();
                    let short = want.saturating_sub(pcm_written + chunk_len);
                    if short > 0 {
                        chunk.resize(chunk_len + short, 0);
                        chunk_len += short;
                    }
                    if chunk_len > 0 {
                        pcm_written += chunk_len;
                        if let Err(error) = sink.write_pcm(&chunk) {
                            tracing::warn!(%error, "clip burn stopped writing audio");
                        }
                    }
                }
            }

            let Some(mut sink) = writer else {
                return Err("The clip burn produced no frames.".into());
            };
            if let Some(feeder) = aac.as_mut() {
                if let Err(error) = feeder.finish(&mut sink) {
                    tracing::warn!(%error, "clip burn could not finish the audio track");
                }
            } else if let Some(rx) = pcm_rx.as_ref() {
                while let Ok(chunk) = rx.recv() {
                    pcm_pending.extend_from_slice(&chunk);
                }
                // Pad or trim the tail to exactly the span the video clock advanced.
                let remaining = hns_to_pcm_bytes(clock).saturating_sub(pcm_written);
                pcm_pending.truncate(remaining);
                pcm_pending.resize(remaining, 0);
                if let Err(error) = sink.write_pcm_closing(&pcm_pending) {
                    tracing::warn!(%error, "clip burn could not close the audio track");
                }
            }
            sink.finish()?;
            Ok((clock, frames))
        })
        .map_err(|err| err.to_string())?;

    // The ticking timestamp is the one layer that cannot join the static sheet. Converting it
    // once a second instead of once a frame keeps it off the hot path.
    let mut clock_sheet: Option<(u64, Nv12Sheet)> = None;
    let mut info = Some(first);
    let mut source_pts: i64 = 0;
    let mut send_error: Option<String> = None;

    loop {
        let Some(current) = info.take() else {
            break;
        };
        let duration = current.duration;

        // Stage 1: the decoded frame is the canvas. Identity framing was verified above, so this
        // is a plane copy rather than a scale-and-blit.
        if let Err(error) = canvas.copy_from(&decoded, current.pitch, current.height) {
            send_error = Some(error);
            break;
        }

        // Stage 2: grade the gameplay rect only; overlays blend on top ungraded.
        tune.apply(&mut canvas, capture_box);

        // Stages 3-5: pre-converted overlays.
        if let Some(sheet) = sheet.as_ref() {
            sheet.blend_onto(&mut canvas);
        }

        if show_clock {
            let stamp_secs = (hud.started_unix_secs as i64
                + i64::from(hud.tz_offset_minutes) * 60
                + source_pts / 10_000_000)
                .max(0) as u64;
            let stale = clock_sheet
                .as_ref()
                .map(|(secs, _)| *secs != stamp_secs)
                .unwrap_or(true);
            if stale {
                clock_sheet = render_clock_sheet(canvas_w, canvas_h, hud_scale, spec, stamp_secs)
                    .map(|sheet| (stamp_secs, sheet));
            }
            if let Some((_, sheet)) = clock_sheet.as_ref() {
                sheet.blend_onto(&mut canvas);
            }
        }

        if tx.send(EncodedFrame { nv12: canvas.planes.clone(), duration }).is_err() {
            // The encoder thread died; its error is the real one.
            break;
        }
        source_pts += duration.max(1);

        match crate::thumb::read_nv12_sample(&reader, &mut decoded)? {
            Some(next) => info = Some(next),
            None => break,
        }
    }

    drop(tx);
    let (written_hns, frames) = encoder
        .join()
        .map_err(|_| "The clip burn encoder thread panicked.".to_string())??;
    if let Some(error) = send_error {
        return Err(error);
    }

    let written_ms = written_hns / 10_000;
    tracing::info!(
        elapsed_ms = started.elapsed().as_millis() as u64,
        frames,
        width = canvas_w,
        height = canvas_h,
        written_ms,
        "clip overlay burn finished"
    );
    Ok(ClipSceneComposeReport {
        written_ms,
        frames,
        width: canvas_w,
        height: canvas_h,
    })
}

/// Pick the frame size to burn at.
///
/// `expect_*` is what Instant Replay captured; `decoded_*` is what the NV12 reader reports, which
/// for H.264 is rounded up to whole 16-pixel macroblocks (1080 -> 1088). Prefer the expected size
/// when it is no larger than the decoded frame and within one macroblock of it, so the padding
/// rows get dropped instead of burned in. Anything else and the decoder wins — a mismatch that
/// large means the expectation was wrong, not that there is padding.
fn display_size(expect_w: u32, expect_h: u32, decoded_w: u32, decoded_h: u32) -> (u32, u32) {
    const MACROBLOCK: u32 = 16;
    let w = expect_w & !1;
    let h = expect_h & !1;
    let plausible = w > 0
        && h > 0
        && w <= decoded_w
        && h <= decoded_h
        && decoded_w - w < MACROBLOCK
        && decoded_h - h < MACROBLOCK;
    if plausible {
        (w, h)
    } else {
        (decoded_w, decoded_h)
    }
}

#[cfg(test)]
mod tests {
    use super::display_size;

    #[test]
    fn display_size_trims_h264_macroblock_padding() {
        // The case that matters: 1080p is coded as 1088 rows.
        assert_eq!(display_size(1920, 1080, 1920, 1088), (1920, 1080));
        // 720p and 1440p code exactly, so nothing to trim.
        assert_eq!(display_size(1280, 720, 1280, 720), (1280, 720));
        assert_eq!(display_size(2560, 1440, 2560, 1440), (2560, 1440));
        // 4K is 2160, also a multiple of 16.
        assert_eq!(display_size(3840, 2160, 3840, 2160), (3840, 2160));
    }

    #[test]
    fn display_size_defers_to_the_decoder_when_the_expectation_is_wrong() {
        // A gap of a whole macroblock or more is a real size mismatch, not padding: trusting the
        // expectation there would crop actual picture.
        assert_eq!(display_size(1920, 1000, 1920, 1088), (1920, 1088));
        assert_eq!(display_size(1280, 720, 1920, 1088), (1920, 1088));
        // An expectation larger than the decoded frame would read past the buffer.
        assert_eq!(display_size(1920, 1200, 1920, 1088), (1920, 1088));
        // Missing dimensions fall back rather than producing a zero-sized canvas.
        assert_eq!(display_size(0, 0, 1920, 1088), (1920, 1088));
    }

    #[test]
    fn display_size_keeps_the_canvas_even() {
        // Odd dimensions would split a 2x2 chroma block.
        let (w, h) = display_size(1921, 1081, 1936, 1088);
        assert_eq!((w % 2, h % 2), (0, 0));
    }
}

/// Rasterize the ticking timestamp and pre-convert it to NV12.
///
/// Separate from the static sheet because it changes once a second; separate from the frame loop
/// because converting it per frame would undo the point of the static sheet.
fn render_clock_sheet(
    canvas_w: u32,
    canvas_h: u32,
    hud_scale: f32,
    spec: &ValidatedComposition,
    stamp_secs: u64,
) -> Option<Nv12Sheet> {
    let text = crate::recording_compositor::compositor::format_wall_clock(stamp_secs);
    let (raster, at) = layers::render_hud_line(
        canvas_w,
        canvas_h,
        "hud-clock",
        &text,
        layers::CLOCK_COLOR,
        hud_scale,
        spec,
    )?;
    // Paint the raster into a full-canvas scratch so the sheet converter sees canvas coordinates.
    let mut scratch = vec![0u8; (canvas_w as usize) * (canvas_h as usize) * 4];
    layers::blend_straight_bgra(
        &mut scratch,
        canvas_w,
        canvas_h,
        &raster.bgra,
        raster.width,
        raster.height,
        at,
        1.0,
    );
    Nv12Sheet::from_bgra(&scratch, canvas_w, canvas_h, at)
}
