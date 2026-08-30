//! Copy-remux a composed MP4 through a standards-compliant ISO-BMFF writer.
//!
//! Compressed H.264 and AAC samples are copied. Nothing is decoded or
//! re-encoded. The GPU compose file stays the source; the original is
//! replaced only after the remux verifies.

use std::fs::{File, OpenOptions};
use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::Instant;

use mp4::{
    AacConfig, AvcConfig, FourCC, MediaConfig, Mp4Config, Mp4Reader, Mp4Sample, Mp4Writer,
    TrackConfig, TrackType,
};
use sha2::{Digest, Sha256};

use super::faststart::{faststart_mp4_in_place, moov_precedes_mdat};

const COMMON_HZ: u64 = 240_000;
const MAX_VIDEO_PER_CHUNK: usize = 2;

struct RemovePath(PathBuf);

impl Drop for RemovePath {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

#[derive(Debug, Clone)]
pub struct CopyRemuxStats {
    pub video_samples: u64,
    pub audio_samples: u64,
    pub video_sha256: String,
    pub audio_sha256: String,
    pub elapsed_ms: u128,
}

struct CopiedTrack {
    track_id: u32,
    timescale: u32,
    samples: Vec<Mp4Sample>,
}

/// Remux `src` into `dest`. `dest` must not be `src`.
pub fn remux_composed_mp4(src: &Path, dest: &Path) -> Result<CopyRemuxStats, String> {
    if src == dest {
        return Err("Copy-remux output cannot replace the source in one step.".into());
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let started = Instant::now();
    let cleanup = RemovePath(dest.to_path_buf());
    let input_stats = remux_to_path(src, dest)?;
    let output_stats = verify_remux(dest, &input_stats).map_err(|err| {
        let _ = std::fs::remove_file(dest);
        err
    })?;
    if !moov_precedes_mdat(dest)? {
        let _ = std::fs::remove_file(dest);
        return Err(format!(
            "Remuxed {} does not have moov before mdat.",
            dest.display()
        ));
    }
    std::mem::forget(cleanup);
    Ok(CopyRemuxStats {
        elapsed_ms: started.elapsed().as_millis(),
        ..output_stats
    })
}

/// Remux `path` to a sibling temp file, verify, then replace `path`.
/// On failure the original file is left untouched.
pub fn remux_composed_mp4_in_place(path: &Path) -> Result<CopyRemuxStats, String> {
    let tmp = temp_path(path);
    let cleanup = RemovePath(tmp.clone());
    let stats = remux_composed_mp4(path, &tmp)?;
    fsync_path(&tmp)?;
    replace_file(&tmp, path)?;
    std::mem::forget(cleanup);
    let _ = std::fs::remove_file(&tmp);
    Ok(stats)
}

fn temp_path(path: &Path) -> PathBuf {
    let stem = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("clip.mp4");
    path.with_file_name(format!("{stem}.isobmff-remux.tmp"))
}

fn fsync_path(path: &Path) -> Result<(), String> {
    let file = OpenOptions::new()
        .write(true)
        .open(path)
        .map_err(|err| format!("Could not reopen {} for fsync: {err}", path.display()))?;
    file.sync_all()
        .map_err(|err| format!("Could not fsync {}: {err}", path.display()))
}

fn replace_file(from: &Path, to: &Path) -> Result<(), String> {
    let backup = to.with_file_name(format!(
        "{}.isobmff-remux.bak",
        to.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("clip.mp4")
    ));
    let _ = std::fs::remove_file(&backup);
    if to.exists() {
        std::fs::rename(to, &backup).map_err(|err| {
            format!(
                "Could not park {} during remux replace: {err}",
                to.display()
            )
        })?;
    }
    match std::fs::rename(from, to) {
        Ok(()) => {
            let _ = std::fs::remove_file(&backup);
            Ok(())
        }
        Err(err) => {
            let _ = std::fs::rename(&backup, to);
            Err(format!(
                "Could not replace {} with remuxed file: {err}",
                to.display()
            ))
        }
    }
}

fn remux_to_path(src: &Path, dest: &Path) -> Result<CopyRemuxStats, String> {
    let file = File::open(src).map_err(|err| {
        format!("Could not open {} for ISO-BMFF remux: {err}", src.display())
    })?;
    let size = file
        .metadata()
        .map_err(|err| format!("Could not stat {}: {err}", src.display()))?
        .len();
    let mut reader = Mp4Reader::read_header(BufReader::new(file), size).map_err(|err| {
        format!("Could not demux {} for remux: {err}", src.display())
    })?;

    let mut video = None;
    let mut audio = None;
    let track_ids: Vec<u32> = reader.tracks().keys().copied().collect();
    for track_id in track_ids {
        let track = reader
            .tracks()
            .get(&track_id)
            .ok_or_else(|| format!("Missing track {track_id} while remuxing."))?;
        let kind = track
            .track_type()
            .map_err(|err| format!("Could not read track {track_id} type: {err}"))?;
        match kind {
            TrackType::Video => {
                if video.is_some() {
                    continue;
                }
                video = Some(load_track(&mut reader, track_id, TrackType::Video)?);
            }
            TrackType::Audio => {
                if audio.is_some() {
                    continue;
                }
                audio = Some(load_track(&mut reader, track_id, TrackType::Audio)?);
            }
            _ => {}
        }
    }
    let video = video.ok_or_else(|| "Source MP4 has no H.264 video track.".to_string())?;
    let audio = audio.ok_or_else(|| "Source MP4 has no AAC audio track.".to_string())?;

    let mut video_hash = Sha256::new();
    let mut audio_hash = Sha256::new();
    for sample in &video.samples {
        video_hash.update(&sample.bytes);
    }
    for sample in &audio.samples {
        audio_hash.update(&sample.bytes);
    }
    let stats = CopyRemuxStats {
        video_samples: video.samples.len() as u64,
        audio_samples: audio.samples.len() as u64,
        video_sha256: hex_sha(video_hash),
        audio_sha256: hex_sha(audio_hash),
        elapsed_ms: 0,
    };

    write_interleaved(src, dest, &mut reader, &video, &audio)?;
    drop(reader);
    faststart_mp4_in_place(dest).map_err(|err| {
        format!("Could not web-optimize remuxed {}: {err}", dest.display())
    })?;
    Ok(stats)
}

fn load_track(
    reader: &mut Mp4Reader<BufReader<File>>,
    track_id: u32,
    expected: TrackType,
) -> Result<CopiedTrack, String> {
    let track = reader
        .tracks()
        .get(&track_id)
        .ok_or_else(|| format!("Track {track_id} disappeared while remuxing."))?;
    let kind = track
        .track_type()
        .map_err(|err| format!("Could not classify track {track_id}: {err}"))?;
    if kind != expected {
        return Err(format!("Track {track_id} was not the expected {expected:?} track."));
    }
    let timescale = track.timescale();
    let count = reader
        .sample_count(track_id)
        .map_err(|err| format!("Could not count samples on track {track_id}: {err}"))?;
    let mut samples = Vec::with_capacity(count as usize);
    let mut clock = 0_u64;
    for sample_id in 1..=count {
        let mut sample = reader
            .read_sample(track_id, sample_id)
            .map_err(|err| format!("Could not read sample {sample_id} on track {track_id}: {err}"))?
            .ok_or_else(|| format!("Sample {sample_id} on track {track_id} is missing."))?;
        if sample.start_time == 0 && clock > 0 {
            sample.start_time = clock;
        }
        clock = sample.start_time.saturating_add(u64::from(sample.duration));
        samples.push(sample);
    }
    if samples.is_empty() {
        return Err(format!("Track {track_id} has no compressed samples."));
    }
    Ok(CopiedTrack {
        track_id,
        timescale,
        samples,
    })
}

fn write_interleaved(
    src: &Path,
    dest: &Path,
    reader: &Mp4Reader<BufReader<File>>,
    video: &CopiedTrack,
    audio: &CopiedTrack,
) -> Result<(), String> {
    let video_track = reader.tracks().get(&video.track_id).ok_or_else(|| {
        format!("Video track {} missing while writing remux.", video.track_id)
    })?;
    let audio_track = reader.tracks().get(&audio.track_id).ok_or_else(|| {
        format!("Audio track {} missing while writing remux.", audio.track_id)
    })?;

    let output = File::create(dest).map_err(|err| {
        format!("Could not create remux temp {}: {err}", dest.display())
    })?;
    let mut writer = Mp4Writer::write_start(
        BufWriter::new(output),
        &Mp4Config {
            major_brand: FourCC::from(*b"isom"),
            minor_version: 512,
            compatible_brands: vec![
                FourCC::from(*b"isom"),
                FourCC::from(*b"iso2"),
                FourCC::from(*b"avc1"),
                FourCC::from(*b"mp41"),
            ],
            timescale: 48_000,
        },
    )
    .map_err(|err| format!("Could not start ISO-BMFF writer: {err}"))?;

    writer
        .add_track(&TrackConfig {
            track_type: TrackType::Video,
            timescale: video.timescale,
            language: "und".into(),
            media_conf: MediaConfig::AvcConfig(avc_config_from_source(src, video_track)?),
        })
        .map_err(|err| format!("Could not add remuxed video track: {err}"))?;
    writer
        .add_track(&TrackConfig {
            track_type: TrackType::Audio,
            timescale: audio.timescale,
            language: "und".into(),
            media_conf: MediaConfig::AacConfig(AacConfig {
                bitrate: audio_track.bitrate(),
                profile: audio_track
                    .audio_profile()
                    .map_err(|err| format!("Could not read AAC profile from {}: {err}", src.display()))?,
                freq_index: audio_track.sample_freq_index().map_err(|err| {
                    format!("Could not read AAC sample rate from {}: {err}", src.display())
                })?,
                chan_conf: audio_track.channel_config().map_err(|err| {
                    format!("Could not read AAC channels from {}: {err}", src.display())
                })?,
            }),
        })
        .map_err(|err| format!("Could not add remuxed audio track: {err}"))?;

    let mut vi = 0usize;
    let mut ai = 0usize;
    while vi < video.samples.len() || ai < audio.samples.len() {
        let v_dts = video
            .samples
            .get(vi)
            .map(|sample| common_dts(sample.start_time, video.timescale));
        let a_dts = audio
            .samples
            .get(ai)
            .map(|sample| common_dts(sample.start_time, audio.timescale));
        match (v_dts, a_dts) {
            (Some(v), Some(a)) if v <= a => {
                let mut written = 0;
                while vi < video.samples.len()
                    && common_dts(video.samples[vi].start_time, video.timescale) <= a
                    && written < MAX_VIDEO_PER_CHUNK
                {
                    writer
                        .write_sample(1, &video.samples[vi])
                        .map_err(|err| format!("Could not write remuxed video sample: {err}"))?;
                    vi += 1;
                    written += 1;
                }
            }
            (Some(_), None) => {
                let mut written = 0;
                while vi < video.samples.len() && written < MAX_VIDEO_PER_CHUNK {
                    writer
                        .write_sample(1, &video.samples[vi])
                        .map_err(|err| format!("Could not write remuxed video sample: {err}"))?;
                    vi += 1;
                    written += 1;
                }
            }
            (Some(_), Some(_)) | (None, Some(_)) => {
                writer
                    .write_sample(2, &audio.samples[ai])
                    .map_err(|err| format!("Could not write remuxed audio sample: {err}"))?;
                ai += 1;
            }
            (None, None) => break,
        }
    }

    writer
        .write_end()
        .map_err(|err| format!("Could not finish remuxed MP4: {err}"))?;
    Ok(())
}

fn verify_remux(dest: &Path, expected: &CopyRemuxStats) -> Result<CopyRemuxStats, String> {
    let file = File::open(dest).map_err(|err| {
        format!("Could not reopen remuxed {}: {err}", dest.display())
    })?;
    let size = file
        .metadata()
        .map_err(|err| format!("Could not stat remuxed {}: {err}", dest.display()))?
        .len();
    let mut reader = Mp4Reader::read_header(BufReader::new(file), size).map_err(|err| {
        format!("Could not verify remuxed {}: {err}", dest.display())
    })?;

    let mut video_samples = 0_u64;
    let mut audio_samples = 0_u64;
    let mut video_hash = Sha256::new();
    let mut audio_hash = Sha256::new();
    let track_ids: Vec<u32> = reader.tracks().keys().copied().collect();
    for track_id in track_ids {
        let kind = reader
            .tracks()
            .get(&track_id)
            .and_then(|track| track.track_type().ok());
        let count = reader
            .sample_count(track_id)
            .map_err(|err| format!("Could not count remuxed track {track_id}: {err}"))?;
        for sample_id in 1..=count {
            let sample = reader
                .read_sample(track_id, sample_id)
                .map_err(|err| {
                    format!("Could not read remuxed sample {sample_id} on track {track_id}: {err}")
                })?
                .ok_or_else(|| format!("Remuxed sample {sample_id} on track {track_id} is missing."))?;
            match kind {
                Some(TrackType::Video) => {
                    video_samples += 1;
                    video_hash.update(&sample.bytes);
                }
                Some(TrackType::Audio) => {
                    audio_samples += 1;
                    audio_hash.update(&sample.bytes);
                }
                _ => {}
            }
        }
    }

    let stats = CopyRemuxStats {
        video_samples,
        audio_samples,
        video_sha256: hex_sha(video_hash),
        audio_sha256: hex_sha(audio_hash),
        elapsed_ms: 0,
    };
    if stats.video_samples != expected.video_samples {
        return Err(format!(
            "Remux video sample count changed ({} -> {}).",
            expected.video_samples, stats.video_samples
        ));
    }
    if stats.audio_samples != expected.audio_samples {
        return Err(format!(
            "Remux audio sample count changed ({} -> {}).",
            expected.audio_samples, stats.audio_samples
        ));
    }
    if stats.video_sha256 != expected.video_sha256 {
        return Err("Remux changed H.264 sample payloads.".into());
    }
    if stats.audio_sha256 != expected.audio_sha256 {
        return Err("Remux changed AAC sample payloads.".into());
    }
    Ok(stats)
}

fn avc_config_from_source(path: &Path, track: &mp4::Mp4Track) -> Result<AvcConfig, String> {
    if let (Ok(sps), Ok(pps)) = (
        track.sequence_parameter_set(),
        track.picture_parameter_set(),
    ) {
        return Ok(AvcConfig {
            width: track.width(),
            height: track.height(),
            seq_param_set: sps.to_vec(),
            pic_param_set: pps.to_vec(),
        });
    }
    let (sps, pps) = read_avcc_param_sets(path)?;
    Ok(AvcConfig {
        width: if track.width() > 0 { track.width() } else { 1920 },
        height: if track.height() > 0 { track.height() } else { 1080 },
        seq_param_set: sps,
        pic_param_set: pps,
    })
}

/// The `mp4` crate reads `avc3` samples but only exposes `avc1` sample entries.
/// Replayr GPU compose writes `avc3`; the `avcC` payload is the same layout.
fn read_avcc_param_sets(path: &Path) -> Result<(Vec<u8>, Vec<u8>), String> {
    let moov = read_moov_bytes(path)?;
    let Some(avcc) = find_box_payload(&moov, 0, moov.len(), b"avcC") else {
        return Err(format!("{} has no avcC decoder config.", path.display()));
    };
    parse_avcc_param_sets(avcc)
        .ok_or_else(|| format!("{} avcC is missing SPS/PPS.", path.display()))
}

fn read_moov_bytes(path: &Path) -> Result<Vec<u8>, String> {
    let mut file = File::open(path).map_err(|err| {
        format!("Could not reopen {} for avcC: {err}", path.display())
    })?;
    let file_len = file
        .metadata()
        .map_err(|err| format!("Could not stat {}: {err}", path.display()))?
        .len();
    let mut offset = 0_u64;
    while offset + 8 <= file_len {
        file.seek(SeekFrom::Start(offset)).map_err(|err| err.to_string())?;
        let mut head = [0_u8; 8];
        file.read_exact(&mut head).map_err(|err| err.to_string())?;
        let size32 = u32::from_be_bytes(head[0..4].try_into().unwrap());
        let kind = [head[4], head[5], head[6], head[7]];
        let (header_len, size) = match size32 {
            1 => {
                let mut wide = [0_u8; 8];
                file.read_exact(&mut wide).map_err(|err| err.to_string())?;
                (16_u64, u64::from_be_bytes(wide))
            }
            0 => (8_u64, file_len - offset),
            n => (8_u64, u64::from(n)),
        };
        if &kind == b"moov" {
            let mut payload = vec![0_u8; (size - header_len) as usize];
            file.read_exact(&mut payload).map_err(|err| {
                format!("Could not read moov from {}: {err}", path.display())
            })?;
            return Ok(payload);
        }
        offset = offset.saturating_add(size);
    }
    Err(format!("{} has no moov atom.", path.display()))
}

fn find_box_payload<'a>(buf: &'a [u8], start: usize, end: usize, want: &[u8; 4]) -> Option<&'a [u8]> {
    let mut offset = start;
    while offset + 8 <= end {
        let size32 = u32::from_be_bytes(buf[offset..offset + 4].try_into().ok()?);
        let kind: [u8; 4] = buf[offset + 4..offset + 8].try_into().ok()?;
        let (header, size) = match size32 {
            1 if offset + 16 <= end => {
                let size = u64::from_be_bytes(buf[offset + 8..offset + 16].try_into().ok()?) as usize;
                (16usize, size)
            }
            0 => (8usize, end - offset),
            n => (8usize, n as usize),
        };
        if size < header || offset + size > end {
            break;
        }
        let payload = offset + header;
        let box_end = offset + size;
        if &kind == want {
            return Some(&buf[payload..box_end]);
        }
        let child_start = match &kind {
            b"stsd" => payload.saturating_add(8),
            b"avc1" | b"avc3" => payload.saturating_add(78),
            b"trak" | b"mdia" | b"minf" | b"stbl" => payload,
            _ => 0,
        };
        if child_start > 0 {
            if let Some(found) = find_box_payload(buf, child_start, box_end, want) {
                return Some(found);
            }
        }
        offset = box_end;
    }
    None
}

fn parse_avcc_param_sets(avcc: &[u8]) -> Option<(Vec<u8>, Vec<u8>)> {
    if avcc.len() < 7 {
        return None;
    }
    let mut pos = 5;
    let sps_count = avcc[pos] & 0x1f;
    pos += 1;
    let mut sps = None;
    for _ in 0..sps_count {
        if pos + 2 > avcc.len() {
            return None;
        }
        let len = u16::from_be_bytes([avcc[pos], avcc[pos + 1]]) as usize;
        pos += 2;
        if pos + len > avcc.len() {
            return None;
        }
        if sps.is_none() {
            sps = Some(avcc[pos..pos + len].to_vec());
        }
        pos += len;
    }
    if pos >= avcc.len() {
        return None;
    }
    let pps_count = avcc[pos];
    pos += 1;
    let mut pps = None;
    for _ in 0..pps_count {
        if pos + 2 > avcc.len() {
            return None;
        }
        let len = u16::from_be_bytes([avcc[pos], avcc[pos + 1]]) as usize;
        pos += 2;
        if pos + len > avcc.len() {
            return None;
        }
        if pps.is_none() {
            pps = Some(avcc[pos..pos + len].to_vec());
        }
        pos += len;
    }
    Some((sps?, pps?))
}

fn common_dts(start_time: u64, timescale: u32) -> u64 {
    start_time.saturating_mul(COMMON_HZ) / u64::from(timescale.max(1))
}

fn hex_sha(hasher: Sha256) -> String {
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
