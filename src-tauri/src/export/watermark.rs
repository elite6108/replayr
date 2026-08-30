use std::path::{Path, PathBuf};

use tauri::Manager;
use windows::Win32::Media::MediaFoundation::{MFStartup, MFSTARTUP_FULL, MF_VERSION};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

use super::audio::{decode_audio_pcm, fit_pcm_to_video};

/// One decoded frame in flight between the decode and encode threads.
pub(crate) struct WatermarkFrame {
    pub(crate) planes: Vec<u8>,
    /// Visible frame size. `pitch` is the row stride, which can be padded wider.
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) pitch: u32,
    pub(crate) duration: i64,
}

/// Frames allowed to sit between the decode and encode threads. Four 1080p NV12
/// frames is about 12 MB, which buys the two stages enough slack to overlap
/// without letting Media Foundation hoard the clip in memory.
pub(crate) const WATERMARK_QUEUE_CAP: usize = 4;

/// Re-encodes `input` with a Replayr.tv watermark. The source file is not modified.
pub fn write_watermarked_mp4(input: &Path, output: &Path, fps: u32) -> Result<i64, String> {
    if !input.exists() {
        return Err("That clip is no longer on disk.".into());
    }
    if input == output {
        return Err("Watermark output cannot replace the original file.".into());
    }
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    unsafe {
        MFStartup(MF_VERSION, MFSTARTUP_FULL).map_err(|err| err.to_string())?;
    }
    let pcm = decode_audio_pcm(input).unwrap_or_default();
    let has_audio = !pcm.is_empty();
    match crate::thumb::open_nv12_reader(input) {
        Ok(reader) => watermark_nv12(reader, input, output, fps, pcm, has_audio),
        Err(err) => {
            tracing::warn!(
                "NV12 decode unavailable for {} ({err}); falling back to the RGB32 watermark path",
                input.display()
            );
            watermark_rgb32(input, output, fps, pcm, has_audio)
        }
    }
}

/// Decodes to NV12, stamps the logo, and re-encodes without ever touching RGB.
///
/// Decode and encode run on separate threads over a bounded queue. A single
/// thread would serialise them, because the sink writer is throttled and
/// `WriteSample` blocks until the encoder accepts the frame.
fn watermark_nv12(
    reader: windows::Win32::Media::MediaFoundation::IMFSourceReader,
    input: &Path,
    output: &Path,
    fps: u32,
    pcm: Vec<u8>,
    has_audio: bool,
) -> Result<i64, String> {
    let fps = fps.clamp(24, 60);
    let (frames_tx, frames_rx) =
        std::sync::mpsc::sync_channel::<WatermarkFrame>(WATERMARK_QUEUE_CAP);
    let (spare_tx, spare_rx) = std::sync::mpsc::channel::<Vec<u8>>();
    let dest = output.to_path_buf();

    let encoder = std::thread::Builder::new()
        .name("watermark-encode".into())
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
                        let bitrate =
                            ((u64::from(frame.width) * u64::from(frame.height) * u64::from(fps))
                                / 6)
                            .clamp(4_000_000, 25_000_000) as u32;
                        writer.insert(crate::encode::MfWriter::new(
                            &dest,
                            frame.width,
                            frame.height,
                            fps,
                            bitrate,
                            has_audio,
                            None,
                            false,
                            crate::encode::VideoInput::Nv12,
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
            if has_audio {
                let mut audio = pcm;
                let _ = fit_pcm_to_video(&mut audio, writer.timestamp());
                writer.write_pcm_closing(&audio)?;
            } else {
                let _ = writer.write_pcm_closing(&[]);
            }
            let written_ms = (writer.timestamp() / 10_000).max(0);
            writer.finish()?;
            Ok((written_ms, frames))
        })
        .map_err(|err| format!("Could not start the watermark encoder: {err}"))?;

    let mut decoded = 0_u32;
    let mut decode_error = None;
    loop {
        let mut planes = spare_rx.try_recv().unwrap_or_default();
        match crate::thumb::read_nv12_sample(&reader, &mut planes) {
            Ok(Some(info)) => {
                crate::still::composite_watermark_nv12(
                    &mut planes,
                    info.pitch as usize,
                    info.width,
                    info.height,
                );
                decoded += 1;
                let queued = WatermarkFrame {
                    planes,
                    width: info.width,
                    height: info.height,
                    pitch: info.pitch,
                    duration: info.duration,
                };
                // A send failure means the encoder stopped; join reports why.
                if frames_tx.send(queued).is_err() {
                    break;
                }
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
        .map_err(|_| "The watermark encoder stopped unexpectedly.".to_string())??;
    if let Some(err) = decode_error {
        return Err(err);
    }
    if frames == 0 {
        return Err("That clip has no video.".into());
    }
    tracing::info!(
        "watermarked {} -> {} ({} ms, {} frames, {} decoded, nv12)",
        input.display(),
        output.display(),
        written_ms,
        frames,
        decoded
    );
    Ok(written_ms)
}

/// Fallback for sources whose decoder will not hand back NV12.
fn watermark_rgb32(
    input: &Path,
    output: &Path,
    fps: u32,
    pcm: Vec<u8>,
    has_audio: bool,
) -> Result<i64, String> {
    let reader = crate::thumb::open_rgb_reader(input)?;
    let Some((first, _, duration)) = crate::thumb::read_rgb_sample(&reader)? else {
        return Err("That clip has no video.".into());
    };
    let width = first.width.max(16);
    let height = first.height.max(16);
    let fps = fps.clamp(24, 60);
    let bitrate =
        ((width as u64 * height as u64 * u64::from(fps)) / 6).clamp(4_000_000, 25_000_000) as u32;
    let mut writer = crate::encode::MfWriter::new(
        output,
        width,
        height,
        fps,
        bitrate,
        has_audio,
        None,
        false,
        crate::encode::VideoInput::Bgra,
    )?;
    let mut frame = first;
    crate::still::composite_watermark(&mut frame);
    writer.write_bgra(&frame.bgra, frame.pitch, frame.width, frame.height, 0, true)?;
    let mut clock = duration.max(1);
    let mut frames = 1_u32;
    loop {
        let Some((mut next, _, next_duration)) = crate::thumb::read_rgb_sample(&reader)? else {
            break;
        };
        crate::still::composite_watermark(&mut next);
        writer.write_bgra(
            &next.bgra,
            next.pitch,
            next.width,
            next.height,
            clock,
            false,
        )?;
        clock += next_duration.max(1);
        frames += 1;
    }
    drop(reader);
    if frames == 0 {
        return Err("That clip has no video.".into());
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
        "watermarked {} -> {} ({} ms, {} frames, rgb32)",
        input.display(),
        output.display(),
        written_ms,
        frames
    );
    Ok(written_ms)
}

pub fn should_watermark_exports(app: &tauri::AppHandle) -> bool {
    let state = app.state::<crate::database::AppState>();
    let Ok(db) = state.db.lock() else {
        return true;
    };
    crate::settings::load(&db)
        .map(|item| item.watermark_exports)
        .unwrap_or(true)
}

pub fn watermarked_temp(source: &Path, fps: u32) -> Result<PathBuf, String> {
    let dest = source.with_file_name(format!(
        "{}.watermark.mp4",
        source
            .file_stem()
            .and_then(|name| name.to_str())
            .unwrap_or("clip")
    ));
    if watermark_temp_reusable(source, &dest) {
        tracing::info!("reusing watermarked clip {}", dest.display());
        return Ok(dest);
    }
    write_watermarked_mp4(source, &dest, fps)?;
    Ok(dest)
}

fn watermark_temp_reusable(source: &Path, dest: &Path) -> bool {
    let Ok(src) = source.metadata() else {
        return false;
    };
    let Ok(dst) = dest.metadata() else {
        return false;
    };
    if dst.len() < 64 * 1024 {
        return false;
    }
    let newer = match (src.modified().ok(), dst.modified().ok()) {
        (Some(src_mtime), Some(dst_mtime)) => dst_mtime >= src_mtime,
        _ => false,
    };
    if !newer {
        return false;
    }
    let src_len = src.len().max(1);
    let dst_len = dst.len();
    dst_len >= src_len / 4 && dst_len <= src_len.saturating_mul(4)
}
