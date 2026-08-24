//! Absolute-position audio timeline.
//!
//! Every capture source stamps its packets with a frame index derived from the
//! WASAPI QPC position, and sums them into one accumulator at that index. A
//! source that stops delivering (a game rendering no audio, a dropped packet)
//! leaves a hole that reads back as silence at the correct place, instead of
//! being closed by concatenation. Concatenating across a hole is what makes the
//! rest of the stream play early and click at the join.
//!
//! The reader always gets exactly the range it asks for, so the encoder's audio
//! clock cannot drift away from its video clock.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

pub const MIX_RATE: u32 = 48_000;
pub const MIX_CHANNELS: usize = 2;
pub const FRAME_BYTES: usize = MIX_CHANNELS * 2;

/// How far the read cursor trails the video clock. This is the jitter buffer:
/// it must exceed the worst-case delay between a sample being rendered and its
/// packet reaching us, or late packets get dropped. It also sets the residual
/// A/V offset (this lead minus the WGC callback latency), so it is the one
/// number to retune if a clap test shows the audio sitting late.
pub const AUDIO_LEAD_HNS: i64 = 500_000;

/// A source whose QPC position disagrees with its own running count by more
/// than this is treated as having a real gap rather than clock jitter.
const RESYNC_FRAMES: i64 = MIX_RATE as i64 / 100;

/// Safety cap on the accumulator. Only reachable if the encoder stalls, which
/// means the recording is already broken; dropping the oldest audio at least
/// keeps memory bounded.
const MAX_BUFFER_FRAMES: i64 = MIX_RATE as i64 * 2;

pub fn frames_from_hns(hns: i64) -> i64 {
    (hns as i128 * MIX_RATE as i128 / 10_000_000) as i64
}

fn qpc_frequency() -> i64 {
    static FREQ: OnceLock<i64> = OnceLock::new();
    *FREQ.get_or_init(|| {
        #[cfg(windows)]
        {
            let mut freq = 0i64;
            unsafe {
                let _ = windows::Win32::System::Performance::QueryPerformanceFrequency(&mut freq);
            }
            if freq > 0 { freq } else { 10_000_000 }
        }
        #[cfg(not(windows))]
        {
            10_000_000
        }
    })
}

/// The performance counter in 100 ns units, the same scale WASAPI reports in
/// `IAudioCaptureClient::GetBuffer`'s QPC position.
pub fn qpc_hns() -> i64 {
    #[cfg(windows)]
    {
        let mut now = 0i64;
        unsafe {
            let _ = windows::Win32::System::Performance::QueryPerformanceCounter(&mut now);
        }
        (now as i128 * 10_000_000 / qpc_frequency() as i128) as i64
    }
    #[cfg(not(windows))]
    {
        0
    }
}

fn clamp_i16(sample: i32) -> i16 {
    sample.clamp(i16::MIN as i32, i16::MAX as i32) as i16
}

/// Per-source routing state the capture thread reads on every packet, so
/// enabling a source or moving a gain slider never has to restart it.
pub struct SourceControl {
    enabled: AtomicBool,
    gain_bits: AtomicU32,
    peak: AtomicU32,
}

const PEAK_SCALE: f32 = 10_000.0;

impl SourceControl {
    pub fn new(enabled: bool, gain: f32) -> Self {
        Self {
            enabled: AtomicBool::new(enabled),
            gain_bits: AtomicU32::new(gain.clamp(0.0, 2.0).to_bits()),
            peak: AtomicU32::new(0),
        }
    }

    pub fn enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }

    pub fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::Relaxed);
    }

    pub fn gain(&self) -> f32 {
        f32::from_bits(self.gain_bits.load(Ordering::Relaxed)).clamp(0.0, 2.0)
    }

    pub fn set_gain(&self, gain: f32) {
        self.gain_bits
            .store(gain.clamp(0.0, 2.0).to_bits(), Ordering::Relaxed);
    }

    pub fn peak(&self) -> f32 {
        self.peak.load(Ordering::Relaxed) as f32 / PEAK_SCALE
    }

    pub fn reset_peak(&self) {
        self.peak.store(0, Ordering::Relaxed);
    }

    pub fn observe_peak(&self, samples: &[i16], gain: f32) {
        let mut max_abs = 0.0f32;
        for sample in samples {
            max_abs = max_abs.max((sample.unsigned_abs() as f32 / 32768.0) * gain);
        }
        let new = (max_abs.clamp(0.0, 1.0) * PEAK_SCALE) as u32;
        self.decay_peak_to(new);
    }

    pub fn decay_peak(&self) {
        self.decay_peak_to(0);
    }

    fn decay_peak_to(&self, floor: u32) {
        let decayed = self.peak.load(Ordering::Relaxed).saturating_mul(85) / 100;
        self.peak.store(decayed.max(floor), Ordering::Relaxed);
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct MixStats {
    /// Frames handed to the encoder.
    pub read_frames: u64,
    /// Frames read back as silence because no source had filled them.
    pub silent_frames: u64,
    /// Frames discarded because their packet arrived after the read cursor
    /// had already passed them. Persistent counts mean `AUDIO_LEAD_HNS` is short.
    pub late_frames: u64,
    /// Frames discarded because the encoder stalled past the buffer cap.
    pub overflow_frames: u64,
    /// Silence inserted because a source stopped delivering.
    pub gap_frames: u64,
    /// Times a source resynced to its QPC position.
    pub gaps: u64,
}

impl MixStats {
    /// Counters are cumulative over a session, so callers reporting per-segment
    /// health subtract the snapshot they took when the segment opened.
    pub fn since(&self, earlier: &MixStats) -> MixStats {
        MixStats {
            read_frames: self.read_frames.saturating_sub(earlier.read_frames),
            silent_frames: self.silent_frames.saturating_sub(earlier.silent_frames),
            late_frames: self.late_frames.saturating_sub(earlier.late_frames),
            overflow_frames: self.overflow_frames.saturating_sub(earlier.overflow_frames),
            gap_frames: self.gap_frames.saturating_sub(earlier.gap_frames),
            gaps: self.gaps.saturating_sub(earlier.gaps),
        }
    }

    pub fn ms(frames: u64) -> u64 {
        frames * 1000 / u64::from(MIX_RATE)
    }
}

struct MixState {
    origin_hns: i64,
    base_frame: i64,
    /// Interleaved stereo accumulator, `MIX_CHANNELS` entries per frame. Wider
    /// than i16 so summing sources cannot wrap before the final clamp.
    buf: Vec<i32>,
    stats: MixStats,
}

/// The shared destination every capture thread writes into.
pub struct MixSink {
    state: Mutex<MixState>,
    epoch: AtomicU64,
    active: AtomicBool,
}

impl Default for MixSink {
    fn default() -> Self {
        Self::new()
    }
}

impl MixSink {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(MixState {
                origin_hns: 0,
                base_frame: 0,
                buf: Vec::new(),
                stats: MixStats::default(),
            }),
            epoch: AtomicU64::new(0),
            active: AtomicBool::new(false),
        }
    }

    /// Opens the timeline at `origin_hns` on the QPC scale. The read cursor
    /// starts one lead behind zero so that the lead is emitted as silence at the
    /// head of the recording; every later frame then lands at its true position.
    pub fn begin_session(&self, origin_hns: i64) {
        if let Ok(mut state) = self.state.lock() {
            state.origin_hns = origin_hns;
            state.base_frame = -frames_from_hns(AUDIO_LEAD_HNS);
            state.buf.clear();
            state.stats = MixStats::default();
        }
        self.epoch.fetch_add(1, Ordering::SeqCst);
        self.active.store(true, Ordering::SeqCst);
    }

    pub fn end_session(&self) {
        self.active.store(false, Ordering::SeqCst);
        if let Ok(mut state) = self.state.lock() {
            state.buf.clear();
            state.buf.shrink_to_fit();
        }
    }

    pub fn epoch(&self) -> u64 {
        self.epoch.load(Ordering::SeqCst)
    }

    pub fn origin_hns(&self) -> i64 {
        self.state.lock().map(|state| state.origin_hns).unwrap_or(0)
    }

    /// Converts a QPC timestamp to a timeline frame index.
    pub fn frame_at(&self, qpc_hns: i64) -> i64 {
        let origin = self.origin_hns();
        frames_from_hns(qpc_hns - origin)
    }

    pub fn note_gap(&self, frames: i64) {
        if frames <= 0 {
            return;
        }
        if let Ok(mut state) = self.state.lock() {
            state.stats.gap_frames += frames as u64;
            state.stats.gaps += 1;
        }
    }

    /// Sums `samples` (interleaved stereo) into the timeline starting at
    /// absolute frame `first_frame`.
    pub fn mix(&self, first_frame: i64, samples: &[i16], gain: f32) {
        if samples.len() < MIX_CHANNELS || !self.active.load(Ordering::SeqCst) {
            return;
        }
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        let total_frames = (samples.len() / MIX_CHANNELS) as i64;

        // Anything the reader has already consumed is gone; keep the remainder.
        let mut first = first_frame;
        let mut src = 0usize;
        if first < state.base_frame {
            let skip = state.base_frame - first;
            if skip >= total_frames {
                state.stats.late_frames += total_frames as u64;
                return;
            }
            state.stats.late_frames += skip as u64;
            src = skip as usize * MIX_CHANNELS;
            first = state.base_frame;
        }

        let end = first + (samples.len() - src) as i64 / MIX_CHANNELS as i64;
        if end - state.base_frame > MAX_BUFFER_FRAMES {
            let drop_frames = end - state.base_frame - MAX_BUFFER_FRAMES;
            let drop_entries = (drop_frames as usize * MIX_CHANNELS).min(state.buf.len());
            state.buf.drain(..drop_entries);
            state.base_frame += drop_frames;
            state.stats.overflow_frames += drop_frames as u64;
            if first < state.base_frame {
                let skip = state.base_frame - first;
                if skip >= (samples.len() - src) as i64 / MIX_CHANNELS as i64 {
                    return;
                }
                src += skip as usize * MIX_CHANNELS;
                first = state.base_frame;
            }
        }

        let at = (first - state.base_frame) as usize * MIX_CHANNELS;
        let needed = at + (samples.len() - src);
        if needed > state.buf.len() {
            state.buf.resize(needed, 0);
        }
        if (gain - 1.0).abs() < f32::EPSILON {
            for (index, sample) in samples[src..].iter().enumerate() {
                state.buf[at + index] += *sample as i32;
            }
        } else {
            for (index, sample) in samples[src..].iter().enumerate() {
                state.buf[at + index] += (*sample as f32 * gain).round() as i32;
            }
        }
    }

    /// Returns frames `[cursor, end_frame)` as interleaved s16, zero-filled
    /// wherever no source wrote, and advances the cursor. The length always
    /// matches the request, which is what keeps the audio clock locked to video.
    pub fn read_upto(&self, end_frame: i64) -> Vec<u8> {
        let Ok(mut state) = self.state.lock() else {
            return Vec::new();
        };
        if end_frame <= state.base_frame {
            return Vec::new();
        }
        let want_frames = (end_frame - state.base_frame) as usize;
        let want = want_frames * MIX_CHANNELS;
        let mut out = vec![0u8; want_frames * FRAME_BYTES];
        let have = state.buf.len().min(want);
        for index in 0..have {
            let value = clamp_i16(state.buf[index]);
            out[index * 2..index * 2 + 2].copy_from_slice(&value.to_le_bytes());
        }
        if state.buf.len() > want {
            state.buf.drain(..want);
        } else {
            state.buf.clear();
        }
        state.base_frame = end_frame;
        state.stats.read_frames += want_frames as u64;
        state.stats.silent_frames += ((want - have) / MIX_CHANNELS) as u64;
        out
    }

    pub fn stats(&self) -> MixStats {
        self.state
            .lock()
            .map(|state| state.stats)
            .unwrap_or_default()
    }
}

/// Tracks where a single source's next packet belongs on the timeline.
///
/// Packets are laid down back to back so a healthy run stays sample exact and
/// immune to QPC jitter. The reported position only takes over when the source
/// actually skipped time, which is precisely when silence must be inserted.
pub struct SourceCursor {
    epoch: u64,
    next_frame: i64,
    started: bool,
}

impl Default for SourceCursor {
    fn default() -> Self {
        Self::new()
    }
}

impl SourceCursor {
    pub fn new() -> Self {
        Self {
            epoch: 0,
            next_frame: 0,
            started: false,
        }
    }

    /// Returns the frame to write at and the size of any gap it opened.
    pub fn resolve(
        &mut self,
        epoch: u64,
        qpc_frame: i64,
        frames: i64,
        discontinuity: bool,
    ) -> (i64, i64) {
        if !self.started || epoch != self.epoch {
            self.epoch = epoch;
            self.started = true;
            self.next_frame = qpc_frame + frames;
            return (qpc_frame, 0);
        }
        let drift = qpc_frame - self.next_frame;
        let at = if discontinuity || drift.abs() > RESYNC_FRAMES {
            qpc_frame
        } else {
            self.next_frame
        };
        let gap = (at - self.next_frame).max(0);
        self.next_frame = at + frames;
        (at, gap)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(frames: usize, value: i16) -> Vec<i16> {
        vec![value; frames * MIX_CHANNELS]
    }

    fn samples_from_bytes(bytes: &[u8]) -> Vec<i16> {
        bytes
            .chunks_exact(2)
            .map(|chunk| i16::from_le_bytes([chunk[0], chunk[1]]))
            .collect()
    }

    fn sink_at_zero() -> MixSink {
        let sink = MixSink::new();
        sink.begin_session(0);
        if let Ok(mut state) = sink.state.lock() {
            state.base_frame = 0;
        }
        sink
    }

    #[test]
    fn read_length_always_matches_the_request() {
        let sink = sink_at_zero();
        sink.mix(0, &tone(10, 100), 1.0);
        let out = sink.read_upto(480);
        assert_eq!(out.len(), 480 * FRAME_BYTES);
    }

    #[test]
    fn a_gap_reads_back_as_silence_at_the_right_place() {
        let sink = sink_at_zero();
        sink.mix(0, &tone(100, 500), 1.0);
        // Source went quiet for 100 frames, then resumed at its true position.
        sink.mix(200, &tone(100, 500), 1.0);
        let out = sink.read_upto(300);
        let samples = samples_from_bytes(&out);
        assert_eq!(samples.len(), 300 * MIX_CHANNELS);
        assert_eq!(samples[0], 500);
        assert_eq!(samples[150 * MIX_CHANNELS], 0, "gap must be silent");
        assert_eq!(samples[250 * MIX_CHANNELS], 500, "audio resumes in place");
        assert_eq!(sink.stats().silent_frames, 0);
    }

    #[test]
    fn sources_with_different_packet_sizes_stay_phase_locked() {
        let sink = sink_at_zero();
        // 480-frame packets from one source, 441-frame from another. Both land
        // at absolute positions, so sample N of each meets sample N of the other.
        for index in 0..4 {
            sink.mix(index * 480, &tone(480, 100), 1.0);
        }
        for index in 0..4 {
            sink.mix(index * 441, &tone(441, 200), 1.0);
        }
        let out = sink.read_upto(441 * 4);
        let samples = samples_from_bytes(&out);
        for frame in 0..441 * 4 {
            assert_eq!(samples[frame * MIX_CHANNELS], 300, "frame {frame}");
        }
    }

    #[test]
    fn summing_clamps_instead_of_wrapping() {
        let sink = sink_at_zero();
        sink.mix(0, &tone(4, 30_000), 1.0);
        sink.mix(0, &tone(4, 30_000), 1.0);
        let samples = samples_from_bytes(&sink.read_upto(4));
        assert!(samples.iter().all(|sample| *sample == i16::MAX));
    }

    #[test]
    fn audio_consumed_before_the_cursor_is_dropped_not_shifted() {
        let sink = sink_at_zero();
        let _ = sink.read_upto(100);
        sink.mix(0, &tone(150, 700), 1.0);
        let samples = samples_from_bytes(&sink.read_upto(150));
        // The first 100 frames were already gone; the rest keeps its position.
        assert_eq!(samples[0], 700);
        assert_eq!(sink.stats().late_frames, 100);
    }

    #[test]
    fn lead_is_emitted_as_silence_at_the_head() {
        let sink = MixSink::new();
        sink.begin_session(0);
        let lead = frames_from_hns(AUDIO_LEAD_HNS);
        let advance = lead * 4;
        sink.mix(0, &tone(advance as usize, 900), 1.0);
        // Video has advanced by `advance`; the reader trails by one lead.
        let out = sink.read_upto(advance - lead);
        // Total delivered still equals the video advance.
        assert_eq!(out.len(), advance as usize * FRAME_BYTES);
        let samples = samples_from_bytes(&out);
        assert_eq!(samples[0], 0, "recording opens with the lead as silence");
        assert_eq!(samples[(lead as usize + 5) * MIX_CHANNELS], 900);
    }

    #[test]
    fn cursor_lays_packets_back_to_back_through_jitter() {
        let mut cursor = SourceCursor::new();
        assert_eq!(cursor.resolve(1, 0, 480, false), (0, 0));
        // QPC wobbles by a few frames; the packet still abuts the previous one.
        assert_eq!(cursor.resolve(1, 483, 480, false), (480, 0));
        assert_eq!(cursor.resolve(1, 957, 480, false), (960, 0));
    }

    #[test]
    fn cursor_resyncs_and_reports_a_real_gap() {
        let mut cursor = SourceCursor::new();
        cursor.resolve(1, 0, 480, false);
        let (at, gap) = cursor.resolve(1, 48_000, 480, false);
        assert_eq!(at, 48_000);
        assert_eq!(gap, 48_000 - 480);
    }

    #[test]
    fn cursor_restarts_on_a_new_session() {
        let mut cursor = SourceCursor::new();
        cursor.resolve(1, 0, 480, false);
        let (at, gap) = cursor.resolve(2, 5_000, 480, false);
        assert_eq!((at, gap), (5_000, 0));
    }

    #[test]
    fn discontinuity_forces_a_resync_even_when_close() {
        let mut cursor = SourceCursor::new();
        cursor.resolve(1, 0, 480, false);
        let (at, _) = cursor.resolve(1, 500, 480, true);
        assert_eq!(at, 500);
    }
}
