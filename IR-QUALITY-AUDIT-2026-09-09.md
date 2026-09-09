# Instant Replay quality audit and bitrate-restart fix

Date: 2026-09-09. Test branch: `fix/ir-capture-integrity`.
Base: latest fetched main, `8980f9c39dbc4f3241683e84fbe485a145448b28` (0.1.36).

## Outcome

The stale-bitrate bug is confirmed and fixed on this test branch. Previously,
changing bitrate while the same game remained running saved the preference but
left the capture session and subsequent two-second encoders using the original
startup bitrate. Version 0.1.36 warned about pending settings but did not apply
them automatically.

Per the user's requested behavior, changing the bitrate now restarts Instant
Replay with the new settings and clears the old rolling buffer. The UI explains
this through an information icon, restart status, and a completion message.
Saved clips are not deleted. The application running on the PC is not replaced
by this source-code push.

**This is not a claim that every fast-motion artifact is fixed or that the app
has passed launch certification.** The supplied clip contains visible block
artifacts. A new gameplay capture from this branch is still required to confirm
the visual outcome. The diagnostic and synthetic tests below do not replace
that test.

## Evidence from the supplied clip

Analyzed locally: `clip-1788928257.mp4`. The user confirmed an RTX 5060, Replayr
0.1.36, a change to custom 50,000 kbps while the game was running, and a clean
image in the game itself. No user video or screenshots were uploaded to GitHub.

| Measurement | Result |
| --- | --- |
| Container duration | 181.269 seconds |
| Video | H.264 Constrained Baseline, level 4.2, 1920 × 1080, 8-bit 4:2:0 |
| Decoded video frames | 10,837 |
| Actual average frame rate | 59.787 frames/sec |
| Average video payload bitrate | 28.132 Mbps |
| Median / largest PTS step | 16.667 / 33.333 ms |
| PTS gaps above 50 ms / non-increasing PTS | 0 / 0 |
| Decoder exceptions / corrupt-frame flags | 0 / 0 |
| IDR frames | 200 |
| Parsed reference-frame counter discontinuities | 0 |
| Audio | AAC, approximately 192 kbps, 48 kHz |

Enlarging a frame around 139 seconds reveals substantial block-shaped smearing
in the scene. A valid H.264 stream can still contain poor reconstructed images;
successful decoding does not disprove those visible artifacts. Conversely,
these measurements do not support asserting that this particular clip suffered
large capture stalls or missing reference frames at segment joins.

The 28.132 Mbps measurement **does not establish which bitrate was selected or
acknowledged at recording time**. The file has no settings-change history. The
confirmed code defect makes a stale target plausible, but it is not proof that
every artifact in this file was caused by that defect.

Because the problem is already present in the local file, cloud processing is
not needed to explain its existence. Uploading cannot recover detail already
lost before or during local encoding.

## What changed

1. **Automatic bitrate application.** Same-game IR now detects an actual preset
   or active custom-value change and uses the existing stop/start lifecycle to
   create a fresh encoder and an empty buffer. It does not attempt a speculative
   in-place codec format change. Newly created segments all inherit the new
   target. Resolution/FPS changes alone do not trigger this automatic restart;
   any saved settings naturally apply when capture is next restarted.
2. **Save and recording protection.** Lifecycle operations are serialized with
   clip exports. A save already in progress completes before a settings restart.
   An active manual recording is never stopped by the bitrate change; a pending
   bitrate applies after that recording successfully finishes. Retained/pinned
   footage from an unfinished save blocks automatic clearing. Duplicate/busy
   save attempts return an explicit retry message.
3. **Fresh state after waiting.** Settings-triggered work reads the current game
   after obtaining the lifecycle lock, not a detection snapshot taken before a
   potentially lengthy clip save. The new capture loads saved settings again.
4. **Truthful diagnostics.** The UI separately shows requested bitrate, running
   writer target, codec readback when exposed, actual encoder dimensions/FPS,
   and the most recently finalized segment's approximate file bitrate. File
   bitrate includes MP4 overhead and is not a guarantee of image quality or an
   exact video-payload measurement. Queue-drop and rotation diagnostics remain
   available. Periodic status reads do not write recording settings.
5. **Clear UX.** Bitrate controls have a keyboard-accessible information icon
   explaining that unsaved buffer history is cleared. Custom input commits on
   Enter/blur, not every digit. Restart progress and completion are shown, and
   the buffer clock resets through the existing replay-status events.

The H.264 profile, encoder rate-control policy, frame-writing algorithm,
preview image pipeline, remux/export algorithm, audio mixing, webcam layout,
cloud upload, and composed-recording encoder were not retuned by this patch.
Restarting uses the existing shared gameplay/audio/webcam session lifecycle.
There is necessarily a short capture interruption and loss of unsaved rolling
history when restarting, as requested; this is not a seamless bitrate update.

## Tests actually performed

- `npm run typecheck`: passed.
- Production frontend build: passed using the existing Vite config with its
  native loader and a process-local `__dirname` shim. The normal bundled-config
  loader encountered the environment's parent-directory access restriction;
  no build configuration was changed to work around it. Existing chunk-size
  and mixed static/dynamic-import warnings remain.
- `cargo test --lib --locked --no-run`: passed; 26 existing warnings remain.
- Expanded standalone Windows harness: **34 tests passed, 0 failed**, including
  the explicit native Media Foundation tests. This imports production modules
  without loading the complete Tauri application.
- Native encoder test: three fresh 1920 × 1080 / 60 FPS writers acknowledged
  **18,000,000**, **50,000,000**, and **42,000,000 bps**, respectively. Each wrote
  120 generated moving-pattern frames. Independent decoding recovered all 120
  frames per file with no corrupt-frame flags.
- Native remux regression: three segments retained all 135 compressed video
  samples byte-for-byte. The old rounded placement also retained 135 samples
  on this test, so this does not prove that timing rounding caused the incident.
- Buffer tests cover pinning, export locking, unfinished-session protection,
  pruning, retained footage, and clip-window timing. Restart-policy tests cover
  all enabled/segmented/manual/changed combinations.
- `git diff --check`: passed.

The full Tauri test executable could not be run successfully on this host
(the earlier run failed at startup with an entry-point error; the retry did not
reach test enumeration). Its compilation is not being counted as execution.
The complete in-app restart/save/webcam interaction, actual game capture after
the patch, cloud playback, and long-duration GPU-load behavior have **not** been
validated end-to-end. No installer was deployed and no release was made.

## Why a large bitrate number is not the whole answer

The local test host reports an NVIDIA GeForce RTX 5060 with driver 596.49.
The tested encoder exposed Baseline profile / level 4.2, rate-control value 0
(CBR), and quality-versus-speed value 33. A GPU being installed, or requesting
hardware transforms, is not by itself proof of the exact encoder implementation;
the sink writer did not expose its encoder CLSID in this probe.

The same synthetic moving pattern produced these independently measured results:

| Confirmed target | Actual video bitrate | Reference comparison, PSNR |
| --- | --- | --- |
| 18 Mbps | 16.972 Mbps | 40.16 dB |
| 42 Mbps | 27.920 Mbps | 41.60 dB |
| 50 Mbps | 28.063 Mbps | 41.67 dB |

These are two-second synthetic clips, not gameplay-quality scores. They show
that a confirmed 50 Mbps target can still yield about 28 Mbps of video for this
input, and that 42 → 50 produced only a small quality change in this case.
Consequently, measuring 28 Mbps in the supplied clip is not sufficient evidence
that its encoder rejected 50 Mbps.

Remaining quality risks to investigate in controlled follow-up tests:

- **Speed-oriented encoding.** The observed quality/speed setting is 33, and
  Baseline cannot use CABAC. A balanced-quality High-profile configuration with
  supported controls may improve compression efficiency, but must be tested
  against GPU load, fallback encoders, output compatibility, and remux behavior.
  Do not enable B frames without auditing timestamp/reordering support.
- **Encoder recreation every two seconds.** Each segment closes one encoder
  and opens another, restarting rate-control history and adding work on the
  encode thread. This can contribute to uneven quality or queue pressure.
  The supplied clip does not prove that it caused its artifacts. A persistent
  encoder with independently decodable segment boundaries would be a larger,
  separately tested architectural change.
- **Capture versus encoder isolation.** A clean game display does not prove
  that the captured frame sent into the encoder is clean. If the problem remains
  after this patch, compare a lossless pre-encode frame with its encoded frame
  from the same timestamp before changing more settings. This distinguishes
  capture/readback damage from encoder reconstruction artifacts.

Microsoft documents codec readback/control through ICodecAPI, the difference
between target bitrate and quality controls, and the Baseline/CABAC limitation:
[H.264 Video Encoder](https://learn.microsoft.com/en-us/windows/win32/medfound/h-264-video-encoder),
[Mean bitrate property](https://learn.microsoft.com/en-us/windows/win32/codecapi/avenccommonmeanbitrate-property).

## Branch acceptance checklist before launch

1. Build/run this branch. In the same affected game, change to Custom 50,000,
   commit with Enter, and verify one restart notification, a refilled buffer,
   active target 50.0 Mbps, and encoder readback 50.0 Mbps when available.
2. Save a short clip after refill begins, then a full-duration clip after the
   configured buffer length. Repeat the fast turns from the supplied sample.
3. Change bitrate during a clip save: the existing clip must finish and remain
   playable, then the buffer restarts. Change bitrate during manual recording:
   recording must continue uninterrupted until stopped, then IR applies it.
4. Check game/system/microphone audio and webcam timing, preview continuity
   after restart, repeated saves, rapid preset changes, disable/enable IR,
   game exit, and a second game. Inspect queue-drop and rotation diagnostics.
5. Compare local and cloud playback. If blockiness persists with verified
   settings, treat the visual issue as still open and collect the matched
   pre-encode/encoded evidence described above.

Rollback: revert the patch commit on this test branch. Do not merge or deploy
solely on the strength of compilation and synthetic tests.
