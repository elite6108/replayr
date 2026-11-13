/** Per-source camera and window identity. The first webcam with no stored camera keeps the global one. */

import type { RecordingSource, RecordingSourceType } from "./scene";

export const MAX_WEBCAMS = 4;
export const MAX_DISPLAYS = 4;
export const MAX_WINDOWS = 4;

const MAX_TEXT = 240;
const MAX_DEVICE = 256;

export type CameraChoice = {
  deviceId: string;
  modeId: string;
};

export type WindowTarget = {
  title: string;
  className: string;
  exe: string;
};

export type CameraGlobals = {
  deviceId: string;
  width: number;
  height: number;
  fps: number;
};

const EMPTY_WINDOW: WindowTarget = { title: "", className: "", exe: "" };

export function modeIdOf(width: number, height: number, fps: number): string {
  return `${Math.round(width)}x${Math.round(height)}@${Math.round(fps)}`;
}

export function parseModeId(modeId: string): { width: number; height: number; fps: number } | null {
  const match = /^(\d{1,5})x(\d{1,5})@(\d{1,3})$/.exec(modeId);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  const fps = Number(match[3]);
  if (width < 160 || width > 7680 || height < 120 || height > 4320 || fps < 1 || fps > 240) return null;
  return { width, height, fps };
}

export function sanitizeCamera(raw: unknown): CameraChoice | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const deviceId = cleanDevice(value.deviceId);
  if (!deviceId) return null;
  const mode = typeof value.modeId === "string" ? parseModeId(value.modeId) : null;
  return { deviceId, modeId: mode ? modeIdOf(mode.width, mode.height, mode.fps) : "" };
}

/** Explicit camera on the source wins. Only the first webcam falls back to the global camera. */
export function cameraForWebcam(source: RecordingSource, sources: readonly RecordingSource[], globals: CameraGlobals): CameraGlobals {
  const explicit = sanitizeCamera(source.settings.camera);
  if (explicit) {
    const mode = parseModeId(explicit.modeId);
    return {
      deviceId: explicit.deviceId,
      width: mode?.width ?? globals.width,
      height: mode?.height ?? globals.height,
      fps: mode?.fps ?? globals.fps,
    };
  }
  const first = sources.find((item) => item.type === "webcam");
  if (first?.id === source.id) return { ...globals };
  return { deviceId: "", width: globals.width, height: globals.height, fps: globals.fps };
}

export function windowTargetOf(source: RecordingSource): WindowTarget {
  return sanitizeWindowTarget(source.settings.window);
}

export function sanitizeWindowTarget(raw: unknown): WindowTarget {
  if (!raw || typeof raw !== "object") return { ...EMPTY_WINDOW };
  const value = raw as Record<string, unknown>;
  return {
    title: cleanText(value.title),
    className: cleanText(value.className),
    exe: cleanExe(value.exe),
  };
}

/** OBS stores `title:class:exe`, with `:` encoded as `#3A` and `#` as `#22`. */
export function parseObsWindow(raw: string): WindowTarget {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 1024) return { ...EMPTY_WINDOW };
  const parts = trimmed.split(":");
  if (parts.length < 3) return sanitizeWindowTarget({ title: trimmed, className: "", exe: "" });
  const exe = decodeObs(parts[parts.length - 1] ?? "");
  const className = decodeObs(parts[parts.length - 2] ?? "");
  const title = decodeObs(parts.slice(0, -2).join(":"));
  return sanitizeWindowTarget({ title, className, exe });
}

export function sanitizeVisualSettings(type: RecordingSourceType, settings: unknown): Record<string, unknown> {
  const next = settings && typeof settings === "object" ? { ...(settings as Record<string, unknown>) } : {};
  if (type === "webcam") {
    const camera = sanitizeCamera(next.camera);
    if (camera) next.camera = camera;
    else delete next.camera;
  }
  if (type === "window") next.window = sanitizeWindowTarget(next.window);
  return next;
}

export function cornerTransform(index: number): { x: number; y: number; w: number; h: number } {
  const y = Math.min(0.56, 0.08 + Math.max(0, index) * 0.08);
  return { x: 0.62, y, w: 0.34, h: 0.34 };
}

function decodeObs(value: string): string {
  return value.replaceAll("#3A", ":").replaceAll("#22", "#");
}

function cleanText(value: unknown): string {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, MAX_TEXT);
}

function cleanExe(value: unknown): string {
  const text = cleanText(value);
  const file = text.split(/[/\\]/).pop() ?? "";
  if (!file || file === "." || file === ".." || file.includes("..")) return "";
  return file;
}

function cleanDevice(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_DEVICE);
  if (!text || text.includes("..")) return "";
  return text;
}
