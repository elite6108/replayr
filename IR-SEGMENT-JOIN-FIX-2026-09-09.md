# Instant Replay artifacts: segment-join fix

Date: 2026-09-09. Branch: `fix/ir-capture-integrity`.
Base: fetched and fast-forwarded to main `3ae361458dde3d8ad27793235b6d6dd44177dcf7`
(0.1.39) before implementation. This patch does not publish a release or change main.

## Finding

The gameplay remuxer could discard the opening keyframe of a new two-second
encoder segment when the previous MP4's last sample extended slightly past the
capture-derived boundary. It then copied the dependent compressed frames without
their required reference image. More bitrate cannot restore a discarded reference.

This is a reproduced production-code bug, not just a bitrate-quality hypothesis.
The user's latest clip is consistent with this mechanism, but the original rolling
segments were not available to establish every damaged frame's exact history.

The latest supplied clip was inspected locally: 1920x1080 H.264 Constrained
Baseline, approximately 151.040 seconds, actual average video payload 67.258 Mbps.
The reported 75 Mbps setting was therefore not simply still running at the old
low bitrate. There is visible rectangular corruption immediately after the clean
2.000-second IDR, starting at about 2.029 seconds. There are 9,037 video packets
but only 9,004 independently decoded frames, including a later approximately
0.583-second decoded-frame gap. No decoder exception was necessary for corruption
to appear. The video and extracted user images were not uploaded to GitHub.

Why the earlier tests missed it: fractional metadata tests used positive timing
jitter and retained their keyframes even on the old path. Exact 100-nanosecond
metadata alone did not eliminate Media Foundation MP4 timescale rounding. The
new reproduction uses the production 60 FPS floor, 166,666 hns per capture,
and a 121-frame segment followed by a 120-frame segment. It fails on the old
remuxer without injecting an artificial overlap.

## Implementation

Only production file changed: `src-tauri/src/export/remux.rs`.

- Bound the previous gameplay segment's final sample duration to the next
  segment's absolute start. Preserve its compressed bytes and the incoming IDR.
- Never silently discard a gameplay prefix to resolve an overlap. If the overlap
  reaches an actual frame boundary, or leaves less than 1 ms of the shortened
  frame, fail the save explicitly instead of generating dependent frames without
  their reference. Source segments are not modified by the remuxer; the existing
  rolling-buffer retention policy still applies.
- Place stitched PCM on absolute session positions. Shorten the matching audio
  tail, preserve the incoming audio head, and put gap silence after the preceding
  audio. This also avoids rounding accumulating over repeated joins and avoids
  inserting the same gap at both sides of a join.
- Log the amount of corrected video-tail timing.

The patch does not re-encode the copied gameplay video, change bitrate/profile,
reduce resolution or FPS, or alter capture, live preview, hotkeys, bitrate restart,
UI, upload, composition, or webcam-window trimming code. Segmented manual
recordings using this same remuxer also receive the boundary correction. A severe
overlap now produces an explicit save error rather than a potentially damaged
output; this is an intentional behavior change, not a promise of zero regression
risk. Existing damaged clips cannot regain already-missing keyframes from this fix.

## Verification

| Check | Result |
| --- | --- |
| Windows production-module harness, including native MF tests | 39 passed, 0 failed, 0 ignored |
| Natural 60 FPS boundary and explicit 0.1 ms overlap | 241/241 compressed samples retained; new segment IDR retained; every payload unchanged |
| Independent PyAV/FFmpeg decoding, 1080p60 at 75 Mbps requested | All 241 frames pixel-identical to separately decoded source segments, for control and both boundary cases |
| Old reproduction, before this patch | 240/241 samples retained; 59 subsequent decoded images differed until the next IDR |
| Real MP4 mux over 150 segments, about five minutes | 18,075 samples retained byte-for-byte, strictly increasing timestamps, endpoint error below 0.1 ms |
| PCM gap and overlap placement | Audio head preserved; exact silence position and length; 150 joins without accumulated PCM endpoint drift |
| Synthetic PCM sidecars through stitched AAC and independent decode | 48 kHz audio decodes; 4.032 s decoded audio for approximately 4.017 s video, within AAC frame padding tolerance |
| Bitrate restart, manual-session deferral, buffer pinning, cadence, webcam placement tests | Passed in the same harness |
| Rust application test target | `cargo test --lib --locked --no-run` compiles successfully |
| Frontend typecheck | `npm run typecheck` passes |
| Frontend production build | Vite build passes with native config loader workaround; no config changes |

The independent decoder compared joined images to independently decoded original
segment images, not to raw pre-encode pixels: this proves the join adds no image
damage in the reproduction, not that lossy H.264 is lossless.

The full Tauri test executable was not run; the earlier environment had a native
entry-point startup issue. The separate harness actually executed the production
capture timing, bitrate, encoder, buffer, audio and remux modules without launching
the app. Compiler warnings and existing frontend bundle warnings remain. No new
installed-app gameplay session, webcam device recording, cloud upload, or installer
smoke test was performed. These results support testing the fix, not unconditional
launch certification.

## Reproducing the checks

`src-tauri/checks/ir_pipeline.rs` is the standalone Rust test entry point. Build it
with `rustc --test --edition=2021 -C opt-level=1`, the Cargo-built dependency
directory, and the matching `windows`, `tracing`, `mp4`, `tempfile`, and `serde`
rlibs. Run with `--include-ignored --nocapture --test-threads=1`; the ignored tests
require Windows Media Foundation.

`src-tauri/checks/ir_boundary_probe.rs` is a standalone synthetic fixture generator
using the production encoder and remuxer. Build it with `rustc --edition=2021
-C opt-level=1`, the same dependency directory, and `windows`, `tracing`, and
`mp4` rlibs. Run it with a fresh output-directory argument. It generates only
synthetic scrolling textures, two PCM tones, and three joined MP4s.

With Python packages `av` and `numpy` installed, run:

```text
python src-tauri/checks/verify_ir_decode.py <fixture-directory>
```

The frontend build used this environment-specific workaround:

```text
node --input-type=module -e "globalThis.__dirname=process.cwd(); const {build}=await import('vite'); await build({configLoader:'native'});"
```

## Before merging to main

Build/install this exact test-branch revision; a source push does not update the
currently installed app. Start a fresh IR session and capture several minutes of
the same fast turns at the same resolution/FPS and 75 Mbps target. Save overlapping
short and long clips and inspect every two-second join. Verify game audio/mic sync,
webcam overlay timing, manual recording start/stop, bitrate change/restart, and one
normal upload. Check for any new explicit overlap error. If artifacts remain,
retain the new clip and diagnostic logs before changing settings again. Do not
raise bitrate further as a substitute for checking the join.
