export type CapturePreviewMode = "game" | "desktop";
export type CapturePreviewState = "live" | "waiting" | "desktop" | "unavailable";

export interface CapturePreviewFrame {
  pngBase64: string | null;
  width: number;
  height: number;
  state: CapturePreviewState;
  label: string;
  source: "tap" | "standalone" | "none";
}
