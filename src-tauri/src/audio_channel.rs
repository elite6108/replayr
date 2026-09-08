//! Source-channel preparation before MixSink.
//!
//! Capture always arrives as interleaved stereo i16 (WASAPI AUTOCONVERTPCM).
//! Mono mics that report as 2ch with a silent side must be centered so both
//! ears hear the signal. True stereo desktop/game content is preserved in Auto.

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[repr(u8)]
pub enum ChannelMode {
    #[default]
    Auto = 0,
    Mono = 1,
    Stereo = 2,
}

impl ChannelMode {
    pub fn parse(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "mono" => Self::Mono,
            "stereo" => Self::Stereo,
            _ => Self::Auto,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Mono => "mono",
            Self::Stereo => "stereo",
        }
    }

    pub fn from_u8(value: u8) -> Self {
        match value {
            1 => Self::Mono,
            2 => Self::Stereo,
            _ => Self::Auto,
        }
    }
}

/// Near-silence threshold for detecting a dead stereo side (~−72 dBFS).
const SILENT_SIDE: i16 = 8;

/// Normalize interleaved stereo samples in place according to `mode`.
///
/// - Auto / Stereo: if one side is effectively silent, duplicate the active side
///   (fixes mono mics that arrive as FL-only stereo). True dual-sided stereo is
///   left unchanged.
/// - Mono: collapse to dual-mono via (L+R)/2 with overflow-safe averaging.
pub fn normalize_source_channels(samples: &mut [i16], mode: ChannelMode) {
    if samples.len() < 2 || samples.len() % 2 != 0 {
        return;
    }
    match mode {
        ChannelMode::Mono => collapse_to_dual_mono(samples),
        ChannelMode::Auto | ChannelMode::Stereo => center_if_single_sided(samples),
    }
}

/// Linear pan after channel normalize. `-1` = left, `0` = center, `+1` = right.
/// Center leaves samples unchanged.
pub fn apply_source_pan(samples: &mut [i16], pan: f32) {
    let pan = pan.clamp(-1.0, 1.0);
    if pan.abs() < 1e-6 {
        return;
    }
    let left_g = if pan > 0.0 { 1.0 - pan } else { 1.0 };
    let right_g = if pan < 0.0 { 1.0 + pan } else { 1.0 };
    for chunk in samples.chunks_exact_mut(2) {
        chunk[0] = scale_i16(chunk[0], left_g);
        chunk[1] = scale_i16(chunk[1], right_g);
    }
}

fn collapse_to_dual_mono(samples: &mut [i16]) {
    for chunk in samples.chunks_exact_mut(2) {
        let mid = ((i32::from(chunk[0]) + i32::from(chunk[1])) / 2) as i16;
        chunk[0] = mid;
        chunk[1] = mid;
    }
}

fn center_if_single_sided(samples: &mut [i16]) {
    let mut max_l = 0i16;
    let mut max_r = 0i16;
    for chunk in samples.chunks_exact(2) {
        max_l = max_l.max(chunk[0].saturating_abs());
        max_r = max_r.max(chunk[1].saturating_abs());
    }
    let left_alive = max_l > SILENT_SIDE;
    let right_alive = max_r > SILENT_SIDE;
    if left_alive == right_alive {
        return;
    }
    if left_alive {
        for chunk in samples.chunks_exact_mut(2) {
            chunk[1] = chunk[0];
        }
    } else {
        for chunk in samples.chunks_exact_mut(2) {
            chunk[0] = chunk[1];
        }
    }
}

fn scale_i16(sample: i16, gain: f32) -> i16 {
    (f32::from(sample) * gain)
        .round()
        .clamp(i16::MIN as f32, i16::MAX as f32) as i16
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_centers_left_only_packet() {
        let mut samples = vec![1000i16, 0, 2000, 0, -500, 0];
        normalize_source_channels(&mut samples, ChannelMode::Auto);
        assert_eq!(samples, vec![1000, 1000, 2000, 2000, -500, -500]);
    }

    #[test]
    fn auto_preserves_true_stereo() {
        let mut samples = vec![1000i16, -800, 400, 900];
        normalize_source_channels(&mut samples, ChannelMode::Auto);
        assert_eq!(samples, vec![1000, -800, 400, 900]);
    }

    #[test]
    fn mono_collapses_average() {
        let mut samples = vec![1000i16, 2000, -1000, 1000];
        normalize_source_channels(&mut samples, ChannelMode::Mono);
        assert_eq!(samples, vec![1500, 1500, 0, 0]);
    }

    #[test]
    fn stereo_mode_still_centers_silent_side() {
        let mut samples = vec![3000i16, 0, 100, 0];
        normalize_source_channels(&mut samples, ChannelMode::Stereo);
        assert_eq!(samples, vec![3000, 3000, 100, 100]);
    }

    #[test]
    fn pan_center_is_noop() {
        let mut samples = vec![1000i16, 2000];
        apply_source_pan(&mut samples, 0.0);
        assert_eq!(samples, vec![1000, 2000]);
    }

    #[test]
    fn pan_full_right_mutes_left() {
        let mut samples = vec![1000i16, 2000];
        apply_source_pan(&mut samples, 1.0);
        assert_eq!(samples[0], 0);
        assert_eq!(samples[1], 2000);
    }

    #[test]
    fn parse_unknown_defaults_to_auto() {
        assert_eq!(ChannelMode::parse("auto"), ChannelMode::Auto);
        assert_eq!(ChannelMode::parse("weird"), ChannelMode::Auto);
        assert_eq!(ChannelMode::parse("MONO"), ChannelMode::Mono);
    }
}
