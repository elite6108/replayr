//! Per-section volume, text, and speed for an editor save.
//!
//! Identity sections (full volume, 1×, no text) stay on the lossless trim path.
//! Anything else re-encodes so the file matches the preview: frames are dropped or
//! repeated, text is burned on top of the webcam, and PCM is overlap-added so the
//! pitch stays recognizable.

use std::path::Path;

use crate::recording_compositor::scene::{TextAlign, ValidatedText};
use crate::recording_compositor::sources::text::raster_text;
use crate::recording_compositor::transforms::{NormRect, PixelRect};

use super::audio::decode_audio_range;
use super::types::WebcamCompose;

pub const SECTION_SPEEDS: [f32; 6] = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];

#[derive(Debug, Clone)]
pub struct TreatedText {
    pub text: String,
    pub color: String,
    pub size: u32,
    pub x: f32,
    pub y: f32,
}

#[derive(Debug, Clone)]
pub struct TreatedSection {
    pub start_ms: u64,
    pub end_ms: u64,
    pub game_volume: f32,
    pub mic_volume: f32,
    pub speed: f32,
    pub text: Option<TreatedText>,
    /// `Some` crops the section to 1080×1920. `None` keeps the source frame.
    pub vertical_pan: Option<f32>,
}

pub fn sanitize_speed(speed: f32) -> f32 {
    if !speed.is_finite() {
        return 1.0;
    }
    SECTION_SPEEDS
        .into_iter()
        .min_by(|left, right| {
            (left - speed)
                .abs()
                .partial_cmp(&(right - speed).abs())
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .unwrap_or(1.0)
}

pub fn sanitize_gain(gain: f32) -> f32 {
    if !gain.is_finite() {
        1.0
    } else {
        gain.clamp(0.0, 2.0)
    }
}

pub fn section_is_identity(section: &TreatedSection) -> bool {
    sanitize_speed(section.speed) == 1.0
        && (sanitize_gain(section.game_volume) - 1.0).abs() < 0.011
        && (sanitize_gain(section.mic_volume) - 1.0).abs() < 0.011
        && section
            .text
            .as_ref()
            .map(|text| text.text.trim().is_empty())
            .unwrap_or(true)
}

pub fn output_frame_count(input_frames: u32, speed: f32) -> u32 {
    if input_frames == 0 {
        return 0;
    }
    let speed = sanitize_speed(speed);
    ((input_frames as f32) / speed).round().max(1.0) as u32
}

/// Source frame used for output frame `output_index` when the clip plays at `speed`.
pub fn source_frame_index(output_index: u32, speed: f32, input_frames: u32) -> u32 {
    if input_frames == 0 {
        return 0;
    }
    let speed = sanitize_speed(speed);
    let index = (output_index as f32 * speed).round() as u32;
    index.min(input_frames - 1)
}

/// Scales interleaved stereo s16le PCM. `0.5` is half as loud.
pub fn apply_gain_pcm(pcm: &mut [u8], gain: f32) {
    let gain = sanitize_gain(gain);
    if (gain - 1.0).abs() < 0.001 {
        return;
    }
    let frames = pcm.len() / 4;
    for frame in 0..frames {
        for channel in 0..2 {
            let offset = frame * 4 + channel * 2;
            let sample = i16::from_le_bytes([pcm[offset], pcm[offset + 1]]);
            let scaled = (sample as f32 * gain)
                .round()
                .clamp(i16::MIN as f32, i16::MAX as f32) as i16;
            let bytes = scaled.to_le_bytes();
            pcm[offset] = bytes[0];
            pcm[offset + 1] = bytes[1];
        }
    }
}

/// Overlap-add time scale. Grains are not resampled, so pitch stays close.
pub fn stretch_pcm(pcm: &[u8], speed: f32) -> Vec<u8> {
    let speed = sanitize_speed(speed);
    let aligned = pcm.len() - (pcm.len() % 4);
    if (speed - 1.0).abs() < 0.001 || aligned < 4 * 2048 {
        return pcm[..aligned].to_vec();
    }
    let frames = aligned / 4;
    let grain = 1024_usize;
    let hop_out = 512_usize;
    let hop_in = ((hop_out as f32) * speed).round().max(1.0) as usize;
    let out_frames = ((frames as f32) / speed).round().max(1.0) as usize;
    let mut left = vec![0_i64; out_frames];
    let mut right = vec![0_i64; out_frames];
    let mut weight = vec![0_i64; out_frames];
    let mut in_pos = 0_usize;
    let mut out_pos = 0_usize;
    while in_pos + grain <= frames && out_pos < out_frames {
        let grain_out = grain.min(out_frames - out_pos);
        for index in 0..grain_out {
            let window = hann(index, grain);
            let sample_at = (in_pos + index) * 4;
            let sample_l = i16::from_le_bytes([pcm[sample_at], pcm[sample_at + 1]]) as i64;
            let sample_r = i16::from_le_bytes([pcm[sample_at + 2], pcm[sample_at + 3]]) as i64;
            let dest = out_pos + index;
            left[dest] += sample_l * window;
            right[dest] += sample_r * window;
            weight[dest] += window;
        }
        in_pos += hop_in;
        out_pos += hop_out;
    }
    let mut out = vec![0_u8; out_frames * 4];
    for index in 0..out_frames {
        let window = weight[index].max(1);
        let sample_l = (left[index] / window).clamp(i16::MIN as i64, i16::MAX as i64) as i16;
        let sample_r = (right[index] / window).clamp(i16::MIN as i64, i16::MAX as i64) as i16;
        out[index * 4..index * 4 + 2].copy_from_slice(&sample_l.to_le_bytes());
        out[index * 4 + 2..index * 4 + 4].copy_from_slice(&sample_r.to_le_bytes());
    }
    out
}

pub fn mix_pcm(game: &[u8], mic: &[u8]) -> Vec<u8> {
    let len = game.len().max(mic.len());
    let len = len - (len % 4);
    if len == 0 {
        return Vec::new();
    }
    let mut out = vec![0_u8; len];
    let frames = len / 4;
    for frame in 0..frames {
        for channel in 0..2 {
            let offset = frame * 4 + channel * 2;
            let left = if offset + 1 < game.len() {
                i16::from_le_bytes([game[offset], game[offset + 1]]) as i32
            } else {
                0
            };
            let right = if offset + 1 < mic.len() {
                i16::from_le_bytes([mic[offset], mic[offset + 1]]) as i32
            } else {
                0
            };
            let mixed = (left + right).clamp(i16::MIN as i32, i16::MAX as i32) as i16;
            out[offset..offset + 2].copy_from_slice(&mixed.to_le_bytes());
        }
    }
    out
}

fn hann(index: usize, width: usize) -> i64 {
    if width <= 1 {
        return 1;
    }
    let x = index as f32 / width as f32;
    let window = 0.5 - 0.5 * (std::f32::consts::PI * 2.0 * x).cos();
    (window * 256.0).round().max(1.0) as i64
}

/// Re-encodes one kept range. Webcam video, when present, is burned in at the same speed.
pub fn write_treated_section(
    input: &Path,
    webcam: Option<&WebcamCompose>,
    output: &Path,
    section: &TreatedSection,
    fps: u32,
) -> Result<i64, String> {
    write_treated_section_with(input, webcam, output, section, fps, &mut |_, _| {})
}

/// Same as [`write_treated_section`], reporting `(frames_written, frames_expected)`.
pub fn write_treated_section_with(
    input: &Path,
    webcam: Option<&WebcamCompose>,
    output: &Path,
    section: &TreatedSection,
    fps: u32,
    progress: &mut dyn FnMut(u32, u32),
) -> Result<i64, String> {
    use std::time::Instant;

    use windows::Win32::Media::MediaFoundation::{MFStartup, MFSTARTUP_FULL, MF_VERSION};

    use super::webcam::WebcamFollow;

    if !input.exists() {
        return Err("That clip is no longer on disk.".into());
    }
    let start_hns = (section.start_ms as i64).saturating_mul(10_000);
    let end_hns = (section.end_ms as i64).saturating_mul(10_000);
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

    let speed = sanitize_speed(section.speed);
    let fps = fps.clamp(24, 60);
    let frame_hns = 10_000_000 / fps as i64;
    let expected = (((section.end_ms.saturating_sub(section.start_ms)) as f32) / 1000.0 * fps as f32 / speed)
        .round()
        .max(1.0) as u32;
    let vertical = section.vertical_pan.map(|pan| pan.clamp(0.0, 1.0));

    let mut game = decode_audio_range(input, start_hns, end_hns).unwrap_or_default();
    apply_gain_pcm(&mut game, sanitize_gain(section.game_volume));
    let game = stretch_pcm(&game, speed);
    let mic = match webcam {
        Some(overlay) => decode_audio_range(&overlay.path, start_hns, end_hns)
            .ok()
            .map(|mut pcm| {
                apply_gain_pcm(&mut pcm, sanitize_gain(section.mic_volume));
                stretch_pcm(&pcm, speed)
            })
            .unwrap_or_default(),
        None => Vec::new(),
    };
    let mixed = mix_pcm(&game, &mic);

    let reader = crate::thumb::open_rgb_reader(input)?;
    if start_hns > 0 {
        crate::thumb::seek_hns(&reader, start_hns)?;
    }
    let mut webcam_follow = match webcam {
        Some(overlay) => match WebcamFollow::open(&overlay.path, start_hns, end_hns) {
            Ok(follow) => Some(follow),
            Err(err) => {
                tracing::warn!(%err, "webcam overlay skipped for this section; encoding gameplay only");
                None
            }
        },
        None => None,
    };

    let mut index = 0_u32;
    let mut next_out = 0_u32;
    let mut clock = 0_i64;
    let mut frames = 0_u32;
    let mut writer: Option<crate::encode::MfWriter> = None;
    let mut text_raster: Option<(crate::recording_compositor::sources::text::RasterText, f32, f32)> = None;
    let mut last: Option<(crate::still::StillFrame, i64)> = None;
    let mut pcm_at = 0_usize;

    loop {
        let sample = match crate::thumb::read_rgb_sample(&reader)? {
            Some((frame, timestamp, _duration)) if timestamp < end_hns => Some((frame, timestamp)),
            _ => None,
        };
        let Some((frame, timestamp)) = sample else {
            break;
        };
        if timestamp < start_hns && index == 0 && next_out == 0 {
            // Seek can land slightly early. Keep reading until the range starts.
            continue;
        }

        if writer.is_none() {
            let (width, height, bitrate) = if vertical.is_some() {
                (1080, 1920, 15_000_000)
            } else {
                let width = frame.width.max(2);
                let height = frame.height.max(2);
                let pixels = u64::from(width) * u64::from(height) * u64::from(fps);
                (width, height, (pixels / 6).clamp(4_000_000, 25_000_000) as u32)
            };
            writer = Some(crate::encode::MfWriter::create(
                output,
                width,
                height,
                fps,
                bitrate,
                !mixed.is_empty(),
                None,
                true,
                crate::encode::VideoInput::Bgra,
                false,
            )?);
            if let Some(label) = prepared_text(section, width, height) {
                text_raster = Some(label);
            }
        }

        loop {
            let src = source_frame_index(next_out, speed, u32::MAX);
            if src > index {
                break;
            }
            if src == index {
                write_painted(
                    &frame,
                    timestamp,
                    vertical,
                    webcam,
                    &mut webcam_follow,
                    text_raster.as_ref(),
                    writer.as_mut().expect("writer"),
                    clock,
                    frames == 0,
                )?;
                clock += frame_hns;
                frames += 1;
                if let Some(sink) = writer.as_mut() {
                    pace_audio(sink, &mixed, &mut pcm_at)?;
                }
                if frames == 1 || frames % 30 == 0 {
                    progress(frames, expected);
                }
            }
            next_out += 1;
            if next_out > index.saturating_mul(4).saturating_add(8) {
                break;
            }
        }
        last = Some((frame, timestamp));
        index += 1;
    }
    if let Some((frame, timestamp)) = last {
        let target = output_frame_count(index, speed);
        while next_out < target {
            let src = source_frame_index(next_out, speed, index.max(1));
            if src + 1 < index {
                break;
            }
            write_painted(
                &frame,
                timestamp,
                vertical,
                webcam,
                &mut webcam_follow,
                text_raster.as_ref(),
                writer.as_mut().expect("writer"),
                clock,
                frames == 0,
            )?;
            clock += frame_hns;
            frames += 1;
            if let Some(sink) = writer.as_mut() {
                pace_audio(sink, &mixed, &mut pcm_at)?;
            }
            next_out += 1;
        }
    }
    progress(frames.max(1), expected.max(frames.max(1)));
    drop(reader);

    if frames == 0 {
        return Err("That range did not include any video.".into());
    }
    let mut writer = writer.ok_or_else(|| "That range did not include any video.".to_string())?;
    let video_hns = writer.timestamp();
    if mixed.is_empty() {
        let _ = writer.write_pcm_closing(&[]);
    } else {
        let want = super::audio::hns_to_pcm_bytes(video_hns);
        let end = want.min(mixed.len());
        let mut tail = if end > pcm_at {
            mixed[pcm_at..end].to_vec()
        } else {
            Vec::new()
        };
        let have = pcm_at + tail.len();
        if want > have {
            tail.resize(tail.len() + (want - have), 0);
        }
        writer.write_pcm_closing(&tail)?;
    }
    let written_ms = (writer.timestamp() / 10_000).max(0);
    writer.finish()?;
    tracing::info!(
        "treated section {} -> {} ({} ms, {} frames, speed {speed}) in {} ms",
        input.display(),
        output.display(),
        written_ms,
        frames,
        started.elapsed().as_millis()
    );
    Ok(written_ms)
}

/// Keeps the audio clock with the video clock so the MP4 sink can flush frames
/// instead of holding the whole clip in memory.
fn pace_audio(writer: &mut crate::encode::MfWriter, pcm: &[u8], cursor: &mut usize) -> Result<(), String> {
    if pcm.is_empty() {
        return Ok(());
    }
    let want = super::audio::hns_to_pcm_bytes(writer.timestamp());
    if want <= *cursor {
        return Ok(());
    }
    let end = want.min(pcm.len());
    if end > *cursor {
        writer.write_pcm(&pcm[*cursor..end])?;
        *cursor = end;
    }
    let gap = want.saturating_sub(*cursor);
    if gap > 0 {
        writer.write_pcm(&vec![0_u8; gap])?;
        *cursor = want;
    }
    Ok(())
}

fn write_painted(
    frame: &crate::still::StillFrame,
    timestamp: i64,
    vertical: Option<f32>,
    webcam: Option<&WebcamCompose>,
    webcam_follow: &mut Option<super::webcam::WebcamFollow>,
    text_raster: Option<&(crate::recording_compositor::sources::text::RasterText, f32, f32)>,
    writer: &mut crate::encode::MfWriter,
    clock: i64,
    first: bool,
) -> Result<(), String> {
    let mut picture = if let Some(pan) = vertical {
        crate::still::crop_and_scale_9x16(frame, pan, 1080, 1920)
    } else {
        frame.clone()
    };
    if let Some(follow) = webcam_follow.as_mut() {
        follow.ensure_at(timestamp);
    }
    if let Some(cam_frame) = webcam_follow.as_ref().and_then(|follow| follow.current_frame()) {
        if let Some(overlay) = webcam {
            super::webcam::overlay_webcam_bgra(&mut picture, cam_frame, &overlay.layout);
        }
    }
    if let Some((raster, x, y)) = text_raster {
        blend_text(&mut picture, raster, *x, *y);
    }
    writer.write_bgra(&picture.bgra, picture.pitch, picture.width, picture.height, clock, first)
}

fn prepared_text(
    section: &TreatedSection,
    canvas_w: u32,
    canvas_h: u32,
) -> Option<(crate::recording_compositor::sources::text::RasterText, f32, f32)> {
    let label = section.text.as_ref()?;
    let text = label.text.trim();
    if text.is_empty() {
        return None;
    }
    let text: String = text.chars().take(80).collect();
    let size = label.size.clamp(18, 120);
    let x = if label.x.is_finite() { label.x.clamp(0.0, 1.0) } else { 0.5 };
    let y = if label.y.is_finite() { label.y.clamp(0.0, 1.0) } else { 0.82 };
    let width = (text.chars().count() as u32 * size).clamp(size * 2, canvas_w).max(8);
    let height = (size + size / 2).clamp(size, canvas_h).max(8);
    let spec = ValidatedText {
        id: "editor-text".into(),
        name: "Text".into(),
        order: 0,
        transform: NormRect::FULL,
        opacity: 1.0,
        text,
        color: parse_color(&label.color),
        size,
        align: TextAlign::Center,
    };
    let raster = raster_text(&spec, width, height).ok()?;
    Some((raster, x, y))
}

fn parse_color(value: &str) -> [u8; 4] {
    let hex = value.trim().trim_start_matches('#');
    if hex.len() != 6 {
        return [255, 255, 255, 255];
    }
    let Ok(rgb) = u32::from_str_radix(hex, 16) else {
        return [255, 255, 255, 255];
    };
    let r = ((rgb >> 16) & 0xff) as u8;
    let g = ((rgb >> 8) & 0xff) as u8;
    let b = (rgb & 0xff) as u8;
    [b, g, r, 255]
}

fn blend_text(
    frame: &mut crate::still::StillFrame,
    raster: &crate::recording_compositor::sources::text::RasterText,
    x: f32,
    y: f32,
) {
    use super::compose_scene::layers::blend_straight_bgra;

    let at = PixelRect {
        x: (x * frame.width as f32 - raster.width as f32 / 2.0).round() as i32,
        y: (y * frame.height as f32 - raster.height as f32 / 2.0).round() as i32,
        w: raster.width,
        h: raster.height,
    };
    let packed_pitch = frame.width.saturating_mul(4);
    if packed_pitch == 0 {
        return;
    }
    if frame.pitch == packed_pitch {
        blend_straight_bgra(
            &mut frame.bgra,
            frame.width,
            frame.height,
            &raster.bgra,
            raster.width,
            raster.height,
            at,
            1.0,
        );
        return;
    }
    let rows = frame.height as usize;
    let tight = packed_pitch as usize;
    let mut packed = vec![0_u8; tight * rows];
    for row in 0..rows {
        let from = row * frame.pitch as usize;
        let to = row * tight;
        if from + tight <= frame.bgra.len() {
            packed[to..to + tight].copy_from_slice(&frame.bgra[from..from + tight]);
        }
    }
    blend_straight_bgra(
        &mut packed,
        frame.width,
        frame.height,
        &raster.bgra,
        raster.width,
        raster.height,
        at,
        1.0,
    );
    for row in 0..rows {
        let from = row * tight;
        let to = row * frame.pitch as usize;
        if to + tight <= frame.bgra.len() {
            frame.bgra[to..to + tight].copy_from_slice(&packed[from..from + tight]);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn double_speed_keeps_half_the_frames() {
        assert_eq!(output_frame_count(10, 2.0), 5);
        assert_eq!(source_frame_index(0, 2.0, 10), 0);
        assert_eq!(source_frame_index(1, 2.0, 10), 2);
        assert_eq!(source_frame_index(4, 2.0, 10), 8);
    }

    #[test]
    fn half_gain_scales_a_pcm_sample() {
        let mut pcm = Vec::new();
        pcm.extend_from_slice(&1000_i16.to_le_bytes());
        pcm.extend_from_slice(&1000_i16.to_le_bytes());
        apply_gain_pcm(&mut pcm, 0.5);
        assert_eq!(i16::from_le_bytes([pcm[0], pcm[1]]), 500);
        assert_eq!(i16::from_le_bytes([pcm[2], pcm[3]]), 500);
    }

    #[test]
    fn two_sections_bake_speed_and_leave_the_source_unchanged() {
        let dir = std::env::temp_dir().join(format!("replayr-treat-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let source = dir.join("source.mp4");
        write_tone_clip(&source, 60, 30);
        let before = std::fs::read(&source).unwrap();

        let slow = TreatedSection {
            start_ms: 0,
            end_ms: 1_000,
            game_volume: 0.5,
            mic_volume: 1.0,
            speed: 0.5,
            text: Some(TreatedText {
                text: "Slow".into(),
                color: "#ffffff".into(),
                size: 48,
                x: 0.5,
                y: 0.82,
            }),
            vertical_pan: None,
        };
        let fast = TreatedSection {
            start_ms: 1_000,
            end_ms: 2_000,
            game_volume: 1.0,
            mic_volume: 1.0,
            speed: 2.0,
            text: Some(TreatedText {
                text: "Fast".into(),
                color: "#ffe14a".into(),
                size: 48,
                x: 0.5,
                y: 0.2,
            }),
            vertical_pan: None,
        };
        let slow_path = dir.join("slow.mp4");
        let fast_path = dir.join("fast.mp4");
        let slow_ms = write_treated_section(&source, None, &slow_path, &slow, 30).unwrap();
        let fast_ms = write_treated_section(&source, None, &fast_path, &fast, 30).unwrap();
        assert!(
            (1_600..2_400).contains(&slow_ms),
            "half speed of one second should last about two seconds, got {slow_ms}"
        );
        assert!(
            (350..700).contains(&fast_ms),
            "double speed of one second should last about half a second, got {fast_ms}"
        );

        let joined = dir.join("joined.mp4");
        let slow_hns = slow_ms * 10_000;
        crate::export::concat_mp4s(
            &[
                crate::export::ConcatSegment {
                    path: slow_path,
                    start_hns: 0,
                    end_hns: slow_hns,
                },
                crate::export::ConcatSegment {
                    path: fast_path,
                    start_hns: slow_hns,
                    end_hns: slow_hns + fast_ms * 10_000,
                },
            ],
            &joined,
            0,
        )
        .unwrap();
        assert!(joined.is_file());
        assert!(std::fs::metadata(&joined).unwrap().len() > 1_000);
        assert_eq!(before, std::fs::read(&source).unwrap());
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn write_tone_clip(path: &std::path::Path, frames: u32, fps: u32) {
        let width = 320_u32;
        let height = 180_u32;
        let mut writer = crate::encode::MfWriter::create(
            path,
            width,
            height,
            fps,
            1_000_000,
            true,
            None,
            true,
            crate::encode::VideoInput::Bgra,
            false,
        )
        .unwrap();
        let pitch = width * 4;
        let mut bgra = vec![0_u8; (pitch * height) as usize];
        for pixel in bgra.chunks_exact_mut(4) {
            pixel[0] = 40;
            pixel[1] = 90;
            pixel[2] = 180;
            pixel[3] = 255;
        }
        let frame_hns = 10_000_000 / fps as i64;
        for index in 0..frames {
            writer
                .write_bgra(&bgra, pitch, width, height, index as i64 * frame_hns, index == 0)
                .unwrap();
        }
        let samples = 48_000 * frames as usize / fps as usize;
        let mut pcm = Vec::with_capacity(samples * 4);
        for index in 0..samples {
            let sample = ((index as f32 * 0.05).sin() * 8_000.0) as i16;
            pcm.extend_from_slice(&sample.to_le_bytes());
            pcm.extend_from_slice(&sample.to_le_bytes());
        }
        writer.write_pcm_closing(&pcm).unwrap();
        writer.finish().unwrap();
    }
}
