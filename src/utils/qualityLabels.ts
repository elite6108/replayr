import type { AppSettings } from "../types/settings";

export const QUALITY_OPTIONS: { value: AppSettings["bitrate"]; label: string }[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "custom", label: "Custom" },
];

export function qualityLabel(bitrate: AppSettings["bitrate"]): string {
  return QUALITY_OPTIONS.find((option) => option.value === bitrate)?.label ?? "Medium";
}

/** Every encoder path caps at 60, so an older saved 120 is shown as 60. */
export function displayFps(fps: number): 30 | 60 {
  return fps <= 30 ? 30 : 60;
}
