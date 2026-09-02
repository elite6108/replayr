/**
 * Shared Live Output Preview ↔ composed MP4 semantics.
 *
 * Frontend (CSS) and Rust (VideoProcessor) implement these rules independently.
 * They must agree. See `src-tauri/src/recording_compositor/transforms.rs`.
 *
 * Coordinate space
 * - Origin is the top-left of the output canvas.
 * - `x`, `y`, `w`, `h` are normalized 0–1 fractions of canvas width/height.
 * - Hidden (`enabled === false`) sources are omitted from preview and the payload.
 * - `locked` does not affect rendering.
 *
 * Fit
 * - Game / Desktop capture: object-fit contain (letterbox inside dest).
 * - Webcam: object-fit cover (center-crop inside dest).
 * - Image: object-fit contain inside dest.
 * - Text: fills dest; alignment is left/center/right inside the box.
 *
 * Opacity
 * - Image opacity comes from image settings (0–1).
 * - Other visual sources use transform opacity when present, otherwise 1.
 * - Stream alpha is multiplied with per-pixel straight alpha.
 *
 * Z-order
 * - Higher `order` is visually in front among scene sources.
 *
 * Fixed pipeline (not ordinary source order)
 * 1. BASE CAPTURE
 * 2. BASE FILTER (color treatment on capture only)
 * 3. SCENE SOURCES sorted by `order` (webcam, image, text)
 * 4. FILTER CHROME (vignette / letterbox / scanlines / frame)
 * 5. DYNAMIC HUD (REC / timestamp / role label)
 *
 * Snapshot
 * - Start Recording freezes the composition. Layout edits apply to the next recording.
 */

export const COMPOSED_PIPELINE = [
  "baseCapture",
  "baseFilter",
  "sceneSources",
  "filterChrome",
  "dynamicHud",
] as const;

export const COMPOSED_FIT = {
  capture: "contain",
  webcam: "cover",
  image: "contain",
  text: "fill",
} as const;
