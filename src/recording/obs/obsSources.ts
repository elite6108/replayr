/** How each OBS source kind becomes a Replayr source, or why it cannot yet. */
import type { RecordingSourceType } from "../scene";
import { RECORDABLE_IMAGE_EXTENSIONS } from "../composition";
import { cameraResolution, matchMonitor, type ObsMonitorInfo } from "./obsDevices";
import type { Size } from "./obsGeometry";
import {
  cleanText,
  OBS_LIMITS,
  settingBool,
  settingNumber,
  settingRecord,
  settingString,
  type ObsSource,
} from "./obsSchema";

export type AudioRole = "microphone" | "desktopAudio" | "gameAudio";

export type VisualMapping =
  | {
      ok: true;
      type: RecordingSourceType;
      settings: Record<string, unknown>;
      /** Native pixel size used to place the item. */
      size: Size;
      /** False when that size is a guess, which matters only for unbounded items. */
      sizeKnown: boolean;
      croppable: boolean;
      notes: string[];
      /** Text only: font size in OBS canvas pixels at scale 1. */
      fontPx?: number;
    }
  | { ok: false; reason: string };

export type MappingContext = {
  canvas: Size;
  monitors: ObsMonitorInfo[];
  imageSizes: ReadonlyMap<string, Size | null>;
};

export const DEFAULT_CAMERA_SIZE: Size = { w: 1920, h: 1080 };

const SKIP_REASONS: Record<string, string> = {
  window_capture: "Window capture is not supported yet.",
  browser_source: "Browser sources are not supported yet.",
  ffmpeg_source: "Media files are not supported yet.",
  vlc_source: "VLC playlists are not supported.",
  slideshow: "Image slideshows are not supported.",
  color_source: "Color sources are not supported.",
};

export function audioRole(kind: string): AudioRole | null {
  if (kind === "wasapi_input_capture") return "microphone";
  if (kind === "wasapi_output_capture") return "desktopAudio";
  if (kind === "wasapi_process_output_capture") return "gameAudio";
  return null;
}

export function isContainer(kind: string): boolean {
  return kind === "scene" || kind === "group";
}

/** Readable OBS type for the import report. */
export function kindLabel(kind: string): string {
  const labels: Record<string, string> = {
    monitor_capture: "Display Capture",
    game_capture: "Game Capture",
    window_capture: "Window Capture",
    dshow_input: "Video Capture Device",
    wasapi_input_capture: "Audio Input Capture",
    wasapi_output_capture: "Audio Output Capture",
    wasapi_process_output_capture: "Application Audio Capture",
    image_source: "Image",
    text_gdiplus: "Text (GDI+)",
    text_ft2_source: "Text (FreeType 2)",
    browser_source: "Browser",
    ffmpeg_source: "Media Source",
    vlc_source: "VLC Video Source",
    slideshow: "Image Slideshow",
    color_source: "Color Source",
    scene: "Scene",
    group: "Group",
  };
  return labels[kind] ?? kind;
}

export function mapVisualSource(source: ObsSource, context: MappingContext): VisualMapping {
  switch (source.kind) {
    case "monitor_capture":
      return mapDisplay(source, context);
    case "game_capture":
      return mapGame(source, context);
    case "dshow_input":
      return mapCamera(source);
    case "image_source":
      return mapImage(source, context);
    case "text_gdiplus":
    case "text_ft2_source":
      return mapText(source);
    default:
      return { ok: false, reason: SKIP_REASONS[source.kind] ?? "This OBS source type is not supported." };
  }
}

function mapDisplay(source: ObsSource, context: MappingContext): VisualMapping {
  const match = matchMonitor(source.settings, context.monitors);
  if (!match) {
    return {
      ok: true,
      type: "display",
      settings: { monitorId: null },
      size: context.canvas,
      sizeKnown: false,
      croppable: true,
      notes: ["That display was not found, so it captures your primary display."],
    };
  }
  const known = match.monitor.width > 0 && match.monitor.height > 0;
  return {
    ok: true,
    type: "display",
    settings: { monitorId: match.monitor.id },
    size: known ? { w: match.monitor.width, h: match.monitor.height } : context.canvas,
    sizeKnown: known,
    croppable: true,
    notes: match.exact ? [] : ["Matched the display by its position in the list. Check it is the right one."],
  };
}

function mapGame(source: ObsSource, context: MappingContext): VisualMapping {
  const mode = settingString(source.settings, "capture_mode", 32);
  return {
    ok: true,
    type: "game",
    settings: {},
    size: context.canvas,
    sizeKnown: false,
    croppable: true,
    notes: mode === "window" || mode === "hotkey" ? ["Replayr captures the game it detects instead of a fixed window."] : [],
  };
}

function mapCamera(source: ObsSource): VisualMapping {
  const resolution = cameraResolution(source.settings);
  return {
    ok: true,
    type: "webcam",
    settings: { shape: "rectangle" },
    size: resolution ?? DEFAULT_CAMERA_SIZE,
    sizeKnown: Boolean(resolution),
    croppable: true,
    notes: [],
  };
}

export function obsImagePath(source: ObsSource): string {
  return settingString(source.settings, "file", OBS_LIMITS.pathLength);
}

/** Absolute local drive path, no network shares or device paths. Rust checks again on use. */
export function isLocalImagePath(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path) && !path.includes("\0");
}

function mapImage(source: ObsSource, context: MappingContext): VisualMapping {
  const path = obsImagePath(source);
  if (!path || !isLocalImagePath(path)) {
    return { ok: false, reason: "The image is not a file on this PC." };
  }
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (!(RECORDABLE_IMAGE_EXTENSIONS as readonly string[]).includes(extension)) {
    return { ok: false, reason: "Only PNG and JPEG images can be recorded today." };
  }
  const size = context.imageSizes.get(path);
  if (!size) {
    return { ok: false, reason: "The image file was not found or could not be read." };
  }
  return {
    ok: true,
    type: "image",
    settings: { path, opacity: 1 },
    size,
    sizeKnown: true,
    croppable: true,
    notes: [],
  };
}

function mapText(source: ObsSource): VisualMapping {
  const freetype = source.kind === "text_ft2_source";
  const fromFile = settingBool(source.settings, freetype ? "from_file" : "read_from_file", false);
  const text = cleanText(source.settings.text);
  if (fromFile && !text.trim()) {
    return { ok: false, reason: "Text read from a file is not supported." };
  }
  const font = settingRecord(source.settings, "font");
  const fontPx = settingNumber(font, "size", freetype ? 32 : 36, 1, 1000);
  const color = settingNumber(source.settings, freetype ? "color1" : "color", freetype ? 0xffffffff : 0xffffff, 0, 0xffffffff);
  const alignRaw = settingString(source.settings, "align", 16);
  const align = alignRaw === "center" || alignRaw === "right" ? alignRaw : "left";
  const content = text.trim() ? text : "Text";
  const notes = fromFile ? ["Replayr keeps the last text OBS saved instead of reading the file."] : [];
  return {
    ok: true,
    type: "text",
    settings: { text: content, color: obsColorToHex(color), size: 28, align },
    size: textSize(source, content, fontPx, freetype),
    sizeKnown: true,
    croppable: false,
    notes,
    fontPx,
  };
}

/** OBS text colours are little-endian `0x(AA)BBGGRR`. */
export function obsColorToHex(value: number): string {
  const color = Math.max(0, Math.min(0xffffffff, Math.round(value))) >>> 0;
  const hex = (channel: number) => channel.toString(16).padStart(2, "0");
  return `#${hex(color & 0xff)}${hex((color >>> 8) & 0xff)}${hex((color >>> 16) & 0xff)}`;
}

/** Text has no intrinsic size in the file: use the custom extents, or estimate from the font. */
function textSize(source: ObsSource, text: string, fontPx: number, freetype: boolean): Size {
  if (!freetype && settingBool(source.settings, "extents", false)) {
    const w = settingNumber(source.settings, "extents_cx", 0, 0, OBS_LIMITS.coordinate);
    const h = settingNumber(source.settings, "extents_cy", 0, 0, OBS_LIMITS.coordinate);
    if (w >= 1 && h >= 1) return { w, h };
  }
  const lines = text.split("\n");
  const longest = Math.max(1, ...lines.map((line) => Array.from(line).length));
  return { w: Math.max(1, longest * fontPx * 0.55), h: Math.max(1, lines.length * fontPx * 1.2) };
}
