#![allow(dead_code)]
#[path = "../src/capture_timing.rs"]
mod capture_timing;
#[path = "../src/encode.rs"]
mod encode;
#[path = "ir_export.rs"]
mod export;
use export::remux::{concat_mp4s, ConcatSegment};
use std::path::Path;

fn samples(path: &Path) -> Vec<mp4::Mp4Sample> {
    let f = std::fs::File::open(path).unwrap();
    let size = f.metadata().unwrap().len();
    let mut reader = mp4::Mp4Reader::read_header(std::io::BufReader::new(f), size).unwrap();
    let id = *reader
        .tracks()
        .iter()
        .find(|(_, t)| t.track_type().ok() == Some(mp4::TrackType::Video))
        .unwrap()
        .0;
    (1..=reader.sample_count(id).unwrap())
        .map(|i| reader.read_sample(id, i).unwrap().unwrap())
        .collect()
}

fn main() {
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
    unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED).ok().unwrap();
    }
    let out = std::path::PathBuf::from(std::env::args().nth(1).expect("output directory"));
    std::fs::create_dir_all(&out).unwrap();
    let mut durations = vec![];
    let mut global = 0usize;
    let mut last_capture = None;
    let mut cadence = capture_timing::FrameCadence::new(60);
    for (index, count) in [121usize, 120].iter().enumerate() {
        let path = out.join(format!("segment-{index}.mp4"));
        let mut writer = encode::MfWriter::new(
            &path,
            1920,
            1080,
            60,
            75_000_000,
            false,
            None,
            true,
            encode::VideoInput::Bgra,
        )
        .unwrap();
        writer.set_last_capture_hns(last_capture);
        let mut pixels = vec![0u8; 1920 * 1080 * 4];
        for frame in 0..*count {
            for y in 0..1080usize {
                for x in 0..1920usize {
                    let sx = (x + global * 13) / 4;
                    let sy = (y + global * 7) / 4;
                    let value =
                        ((sx.wrapping_mul(37) ^ sy.wrapping_mul(73) ^ (sx * sy)) & 255) as u8;
                    let off = (y * 1920 + x) * 4;
                    pixels[off..off + 4].copy_from_slice(&[value, value, value, 255]);
                }
            }
            let capture_hns = (global as i64 + 1) * 166_666;
            assert!(cadence.accept(capture_hns));
            writer
                .write_bgra(
                    &pixels,
                    1920 * 4,
                    1920,
                    1080,
                    capture_hns,
                    frame + 1 == *count,
                )
                .unwrap();
            global += 1;
        }
        durations.push(writer.timestamp());
        last_capture = writer.last_capture_hns();
        writer.finish().unwrap();
        let audio_frames = durations[index] * 48_000 / 10_000_000;
        let mut pcm = Vec::new();
        for frame in 0..audio_frames {
            let phase =
                frame as f64 * (440.0 + index as f64 * 440.0) * std::f64::consts::TAU / 48_000.0;
            let value = (phase.sin() * 8_000.0) as i16;
            pcm.extend_from_slice(&value.to_le_bytes());
            pcm.extend_from_slice(&value.to_le_bytes());
        }
        std::fs::write(encode::pcm_sidecar_path(&path), pcm).unwrap();
        println!(
            "production segment start={}",
            capture_timing::segment_start_hns(last_capture.unwrap(), durations[index])
        );
        let s = samples(&path);
        println!(
            "segment {index}: samples={} first_sync={} last_sync={} duration_hns={}",
            s.len(),
            s[0].is_sync,
            s.last().unwrap().is_sync,
            durations[index]
        );
    }
    let mut segments = vec![
        ConcatSegment {
            path: out.join("segment-0.mp4"),
            start_hns: 0,
            end_hns: durations[0],
        },
        ConcatSegment {
            path: out.join("segment-1.mp4"),
            start_hns: durations[0],
            end_hns: durations[0] + durations[1],
        },
    ];
    let bad = out.join("natural-rounding.mp4");
    concat_mp4s(&segments, &bad, 0).unwrap();
    println!(
        "natural 60fps timestamps output_samples={}",
        samples(&bad).len()
    );
    segments[1].start_hns += 10_000;
    segments[1].end_hns += 10_000;
    let clean = out.join("control.mp4");
    concat_mp4s(&segments, &clean, 0).unwrap();
    segments[1].start_hns -= 11_000;
    segments[1].end_hns -= 11_000;
    let bad = out.join("overlap-0.1ms.mp4");
    concat_mp4s(&segments, &bad, 0).unwrap();
    let a = samples(&clean);
    let b = samples(&bad);
    println!(
        "control_samples={} overlap_samples={} overlap_first_next_sample_sync={}",
        a.len(),
        b.len(),
        b[121].is_sync
    );
    assert_eq!(a.len(), 241);
    assert_eq!(b.len(), 241);
    assert!(a[121].is_sync);
    assert!(b[121].is_sync);
    for (control, overlap) in a.iter().zip(&b) {
        assert_eq!(control.bytes, overlap.bytes);
    }
    let natural = samples(&out.join("natural-rounding.mp4"));
    assert_eq!(natural.len(), 241);
    for (control, fixed) in a.iter().zip(&natural) {
        assert_eq!(control.bytes, fixed.bytes);
    }
}
