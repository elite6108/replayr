use std::path::Path;

use super::follow::WebcamFollow;

const AUDIT_MARKS: &[(i64, &str)] = &[
    (0, "0s"),
    (10_000_000, "1s"),
    (100_000_000, "10s"),
    (300_000_000, "30s"),
];

/// Decode-only follow walk. Session-placed files use clip-relative PTS.
pub fn audit_webcam_timeline(
    gameplay: &Path,
    webcam: &Path,
    start_hns: i64,
    end_hns: i64,
) -> Result<String, String> {
    let end_hns = if end_hns <= 0 { i64::MAX } else { end_hns };
    let gameplay_reader = crate::thumb::open_nv12_reader(gameplay)?;
    if start_hns > 0 {
        crate::thumb::seek_hns(&gameplay_reader, start_hns)?;
    }
    let webcam_reader = crate::thumb::open_nv12_reader(webcam)?;
    if start_hns > 0 {
        crate::thumb::seek_hns(&webcam_reader, start_hns)?;
    }
    let mut planes = Vec::new();
    let first_gameplay = crate::thumb::read_nv12_sample(&gameplay_reader, &mut planes)?
        .ok_or_else(|| "Gameplay has no video.".to_string())?;
    let mut cam_planes = Vec::new();
    let first_webcam = crate::thumb::read_nv12_sample(&webcam_reader, &mut cam_planes)?;
    drop(webcam_reader);

    let mut follow = WebcamFollow::open(webcam, start_hns, end_hns)?;
    follow.ensure_at(first_gameplay.timestamp);
    follow.log_sample(first_gameplay.timestamp, false);

    let mut samples = 1_u64;
    let mut last_ts = first_gameplay.timestamp;
    let mut last_output = first_gameplay.timestamp;
    let mut marks = Vec::new();
    record_marks(&mut marks, first_gameplay.timestamp, follow.selected_pts());
    loop {
        let Some(next) = crate::thumb::read_nv12_sample(&gameplay_reader, &mut planes)? else {
            follow.log_sample(last_output, true);
            break;
        };
        if next.timestamp >= end_hns {
            follow.log_sample(last_output, true);
            break;
        }
        last_ts = next.timestamp;
        last_output = next.timestamp;
        follow.ensure_at(next.timestamp);
        follow.log_sample(last_output, false);
        record_marks(&mut marks, next.timestamp, follow.selected_pts());
        samples += 1;
    }
    marks.push(("end", last_ts, follow.selected_pts()));

    let gp = first_gameplay.timestamp;
    let cam = first_webcam.as_ref().map(|frame| frame.timestamp).unwrap_or(-1);
    let mut report = format!(
        "capture_session_t0=unavailable_at_compose\n\
         timeline_basis=ClipSessionRelative\n\
         clip_start_hns={start_hns}\n\
         clip_end_hns={end_hns}\n\
         gameplay.first_source_pts={gp}\n\
         gameplay.first_normalized_pts={gp}\n\
         gameplay.first_output_pts={gp}\n\
         webcam.first_source_pts={cam}\n\
         webcam.first_normalized_pts={cam}\n\
         webcam.first_output_pts={cam}\n\
         raw_origin_delta_hns={}\n\
         gameplay_samples={samples}\n\
         last_gameplay_source_pts={last_ts}\n",
        if cam >= 0 { cam - gp } else { 0 }
    );
    for (label, gameplay_pts, webcam_pts) in marks {
        let delta = webcam_pts.saturating_sub(gameplay_pts);
        report.push_str(&format!(
            "mark={label} gameplay_pts={gameplay_pts} webcam_pts_selected={webcam_pts} \
             delta_hns={delta} gameplay_session={gameplay_pts} webcam_session={webcam_pts}\n"
        ));
    }
    Ok(report)
}

fn record_marks(marks: &mut Vec<(&'static str, i64, i64)>, gameplay_pts: i64, webcam_pts: i64) {
    for (threshold, label) in AUDIT_MARKS {
        if marks.iter().any(|(existing, _, _)| *existing == *label) {
            continue;
        }
        if gameplay_pts >= *threshold {
            marks.push((*label, gameplay_pts, webcam_pts));
        }
    }
}
