# Replayr marketing screenshots

Real desktop React UI from this repo (Vite harness + Tauri mocks). No invented gameplay video — the Record preview is the product’s dark fallback when Windows capture is not running. Explore uses the live public feed from replayr.tv.

Captured at 1600×1000, 2× scale. Windows-oriented chrome; shot on Linux.

## File map

| File | Screen | Suggested X use |
| --- | --- | --- |
| `record-preview.png` | Record → Recordings. Sources + scene picker, layout preview, Inspector, vertical audio faders, Start Recording, Instant Replay ON (1 min / Save Clip / Ctrl+F10). | **Record** — studio layout, mixer, capture controls |
| `instant-replay.png` | Record → Clips. Rolling buffer UI: Instant Replay ON, 1 min buffer, Save Clip + Ctrl+F10, live mixer (read-only), clip scene sources. Footer: “Output matches Instant Replay · Layout, burn on save”. | **Instant Replay** — hotkey save + buffer |
| `local-library.png` | My Library → This PC. On-device clips before / after upload (Untitled clip, Recording, Cloud badges, favorites). | **Library** — local clips on this PC |
| `share-privacy.png` | My Library → Cloud. Visibility on each clip: Public / Unlisted / Private. Storage meter. Share link is copy-to-clipboard (`replayr.tv/c/{slug}`), not shown as a raw URL. | **Share** — privacy controls |
| `social-explore-or-following.png` | Explore (For You / Trending / Following). Live public clips from replayr.tv. | **Social** — Explore |
| `overlay-pack-or-scene.png` | Record → Recordings with Replayr Overlay selected. Scene picker (Gameplay, 4 saved). Inspector: filters, REC indicator, timestamp. There is no Overlay Packs product. | **Record** — scene / overlay (optional) |

## Gaps

- **Layout:** The studio is Sources \| Preview \| Inspector with a mixer dock, not a full-width preview stacked above a three-pane deck. This is the current UI.
- **Preview plate:** No WGC/game frame on this VM. The app uses a dark plate (not a fake gameplay clip). REC + timestamp + webcam placeholder are real overlay chrome.
- **Overlay Packs:** Do not exist. Shot 6 is the scene + Replayr Overlay inspector instead.
- **Following list:** Not a populated people list. Explore includes a Following chip; the Following page needs a social graph.
- **Share URL:** Cards expose Private / Unlisted / Public. The link is copied, not printed (avoids leaking clip URLs).
- **Native Tauri:** These are the React desktop shell, not a packaged Windows WebView2 window.
- **Sensitive data:** No JWTs, API bases, env, or private playback URLs.

## Regenerate

```bash
npm install
npm install --prefix scripts/marketing-screenshots
node scripts/marketing-screenshots/capture.mjs
```

Uses system Chrome. Does not change product behavior.
