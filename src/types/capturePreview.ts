export type CapturePreviewMode = "game" | "desktop" | "window";
export type CapturePreviewState = "live" | "waiting" | "desktop" | "unavailable";

export interface CapturePreviewFrame {
  /** Base64 image bytes (JPEG for live output preview; field name kept for IPC compat). */
  pngBase64: string | null;
  width: number;
  height: number;
  state: CapturePreviewState;
  label: string;
  source: "tap" | "standalone" | "composed" | "none";
  /** Monotonic encode id; unchanged means frontend must skip decode/setState. */
  frameId: number;
  /** Preview transport MIME. Defaults to image/jpeg. */
  mimeType?: string;
}

/** Metadata ahead of the JPEG bytes on the binary preview channel. */
export interface CapturePreviewHeader {
  width: number;
  height: number;
  state: CapturePreviewState;
  label: string;
  source: CapturePreviewFrame["source"];
  frameId: number;
  mimeType: string;
}
