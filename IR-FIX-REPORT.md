# IR capture integrity — staged patch, not release approval

Base: `6a682e1baf214dbc79b5896dcaf06ab2999cd89d` (0.1.35).
Local branch: `fix/ir-capture-integrity`. No push, deployment, installer replacement,
or changes to existing user recordings were performed.

## Status of the five audit findings

| Finding | This patch | Still required |
| --- | --- | --- |
| 1. High does not update a running IR encoder | Captures the startup quality settings and displays an explicit pending-restart notice in Settings, the game panel, and recording status. Reverting to the active settings clears the notice. No automatic buffer deletion. | This is a mitigation, not hot reconfiguration. Save wanted clips before toggling IR off/on. A seamless transition needs compatible stream parameters and preservation of old buffered footage. |
| 2. Two-second encoder restarts and queue drops | Removes a redundant directory sweep during rotation; adds rate-limited drop counts and rotation duration logs. Cadence work also reduces incoming load. | Restarts and the eight-frame queue remain. Measure stalls on supported GPUs before deciding whether continuous encoding/keyframe-aligned muxing is necessary. |
| 3. Capture cadence and preview overhead | IR now selects frames on a fixed cadence before readback and timestamps before pixel processing. It retains the shared SessionClock and does not fabricate catch-up frames. Preview is checked before cloning. IR metadata uses the encoder's existing 24–60 FPS range. | High-refresh gameplay, sparse frame delivery, A/V sync, and game-performance validation. Non-segmented recording cadence and composed recording are not rewritten. |
| 4. Segment integrity | Segment start times now use exact encoded duration in 100 ns units rather than a duration rounded through milliseconds. Adds an actual encoder/remux sample-preservation test. | General compressed-frame dependency handling, independently decodable segment validation, and codec-configuration mismatch recovery remain unresolved. |
| 5. Encoder quality control | Adds read-only negotiated bitrate/profile/rate-control/quality-speed diagnostics, identifying the encoder by transform category instead of assuming transform zero is the encoder. | No profile, rate-control, or quality preset changes. Capability probing, fallback behavior, output-bitrate verification, and NVIDIA/AMD/Intel quality testing are needed before enabling them. |

This does **not** complete all five findings and is **not** a guarantee of artifact-free
capture. It deliberately does not raise bitrate again, change profiles, add B-frames,
increase queue memory, or replace the rolling-buffer architecture.

## Evidence and verification

- Rust library/test build: passed (`cargo test --lib --locked --no-run`).
- TypeScript: passed (`npm run typecheck`).
- 29 distinct standalone tests passed: 13 capture/encode/audio-placement/remux
  checks, 9 bitrate checks, and 7 buffer checks.
- Synthetic Windows Media Foundation test: three generated 320×180 segments,
  45 frames each, with fractional-millisecond timing. The patched remux retained
  all **135 compressed samples byte-for-byte**. No desktop/game capture involved.
- Important limitation: the old rounded placement also retained 135 samples in
  this synthetic scenario. The arithmetic test reproduces a false overlap, but
  the real-file test does not establish that this caused the reported incident.
- The full application test executable compiled but exited before tests with
  `0xc0000139 / STATUS_ENTRYPOINT_NOT_FOUND`. An isolated harness importing the
  production encode/remux modules ran successfully without loading Tauri.
- Production frontend build was blocked by esbuild filesystem access while loading
  Vite configuration. Alternate loaders hit the existing config's `__dirname`
  assumption. The Vite configuration was not changed to work around this.
- Queue and active-settings tests compile in the full suite but were not executed
  because of the application test executable's startup failure.
- `git diff --check`: passed.

The standalone Windows harness is `src-tauri/checks/ir_pipeline.rs`; its companion
module imports the same production export code, not a mock. It can be compiled
with `rustc --test` using the already-built windows 0.61, tracing, mp4, and tempfile
dependencies. On a working application test host, run the equivalent integration
test with:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib --locked ir_remux_preserves_every_compressed_sample_across_fractional_boundaries -- --ignored --nocapture
```

## Before enabling this in a release

1. Supply an original affected local MP4 and bad timestamp, GPU/driver, selected
   resolution/FPS, refresh rate, and whether High was changed during gameplay.
2. Compare source segments, saved clip, and cloud output. Inspect decode errors,
   frame timestamps, keyframes, and short-window video bitrate at the bad moment.
3. Run gameplay under high load with preview on/off and webcam/audio enabled.
   Check rotation latency, dropped-frame counts, and performance headroom.
4. Exercise repeated saves, rollover/pruning, simultaneous recording, game switches,
   setting changes, microphone/game/webcam synchronization, and disk-pressure handling.
5. Keep the current profile and architecture as the fallback while separately
   validating higher-quality encoder settings and dependency-safe boundary repair.

The current blocker to completing the launch-quality request is actual incident
reproduction and hardware validation, not permission to edit the source.
