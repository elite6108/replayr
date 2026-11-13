/**
 * Strict reader for OBS Studio scene collection JSON.
 *
 * The file is untrusted: every field is read through a guard, numbers must be finite and are
 * clamped, strings are length-limited with control characters removed, and the amount of work is
 * capped. Raw `settings` objects are kept only for guarded reads below; they are never spread or
 * merged into Replayr state.
 */

export const OBS_LIMITS = {
  sources: 1000,
  scenes: 64,
  itemsPerScene: 200,
  nameLength: 256,
  textLength: 2000,
  pathLength: 1024,
  coordinate: 100_000,
  scale: 1000,
} as const;

export type ObsVec2 = { x: number; y: number };

export type ObsCrop = { left: number; top: number; right: number; bottom: number };

export type ObsSceneItem = {
  /** Name of the source this item shows. OBS links items to sources by name (and uuid on 28+). */
  sourceName: string;
  sourceUuid: string | null;
  visible: boolean;
  locked: boolean;
  /** Degrees, clockwise. */
  rot: number;
  pos: ObsVec2;
  scale: ObsVec2;
  align: number;
  boundsType: number;
  boundsAlign: number;
  bounds: ObsVec2;
  crop: ObsCrop;
  cropToBounds: boolean;
};

export type ObsSource = {
  /** OBS source id without a version suffix, such as `monitor_capture` or `text_gdiplus`. */
  kind: string;
  name: string;
  uuid: string | null;
  settings: Readonly<Record<string, unknown>>;
  /** Linear volume multiplier. */
  volume: number;
  muted: boolean;
  /** Scene and group children, bottom first. Empty for everything else. */
  items: ObsSceneItem[];
};

export type ObsCollection = {
  name: string;
  /** Scene names in the order OBS lists them. */
  sceneOrder: string[];
  sources: ObsSource[];
  /** Global audio devices (Desktop Audio and Mic/Aux) that play in every scene. */
  globalAudio: ObsSource[];
};

export type ObsParseResult = { ok: true; collection: ObsCollection } | { ok: false; error: string };

const GLOBAL_AUDIO_KEYS = [
  "DesktopAudioDevice1",
  "DesktopAudioDevice2",
  "AuxAudioDevice1",
  "AuxAudioDevice2",
  "AuxAudioDevice3",
  "AuxAudioDevice4",
] as const;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Remove control characters, trim and cut to `max` characters. */
export function cleanString(value: unknown, max: number = OBS_LIMITS.nameLength): string {
  if (typeof value !== "string") return "";
  return Array.from(value.replace(/[\u0000-\u001f\u007f]/g, "")).slice(0, max).join("").trim();
}

/** Like `cleanString` but keeps line breaks, for text sources. */
export function cleanText(value: unknown, max: number = OBS_LIMITS.textLength): string {
  if (typeof value !== "string") return "";
  const normalized = value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "");
  return Array.from(normalized).slice(0, max).join("");
}

export function finite(value: unknown, fallback: number, min = -Infinity, max = Infinity): number {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

export function integer(value: unknown, fallback: number, min: number, max: number): number {
  return Math.round(finite(value, fallback, min, max));
}

export function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function settingString(settings: Readonly<Record<string, unknown>>, key: string, max: number = OBS_LIMITS.nameLength): string {
  return cleanString(settings[key], max);
}

export function settingNumber(
  settings: Readonly<Record<string, unknown>>,
  key: string,
  fallback: number,
  min = -Infinity,
  max = Infinity,
): number {
  return finite(settings[key], fallback, min, max);
}

export function settingBool(settings: Readonly<Record<string, unknown>>, key: string, fallback: boolean): boolean {
  return bool(settings[key], fallback);
}

export function settingRecord(settings: Readonly<Record<string, unknown>>, key: string): Readonly<Record<string, unknown>> {
  const value = settings[key];
  return isRecord(value) ? value : {};
}

/** `text_gdiplus_v3` → `text_gdiplus`. */
export function baseKind(raw: unknown): string {
  return cleanString(raw, 64).replace(/_v\d+$/, "").toLowerCase();
}

function vec2(raw: unknown, fallback: ObsVec2, limit: number): ObsVec2 {
  const value = isRecord(raw) ? raw : {};
  return {
    x: finite(value.x, fallback.x, -limit, limit),
    y: finite(value.y, fallback.y, -limit, limit),
  };
}

function cropPixels(value: unknown): number {
  return finite(value, 0, 0, OBS_LIMITS.coordinate);
}

function parseItem(raw: unknown): ObsSceneItem | null {
  if (!isRecord(raw)) return null;
  const sourceName = cleanString(raw.name);
  const sourceUuid = cleanString(raw.source_uuid, 64) || null;
  if (!sourceName && !sourceUuid) return null;
  return {
    sourceName,
    sourceUuid,
    visible: bool(raw.visible, true),
    locked: bool(raw.locked, false),
    rot: finite(raw.rot, 0, -36_000, 36_000),
    pos: vec2(raw.pos, { x: 0, y: 0 }, OBS_LIMITS.coordinate),
    scale: vec2(raw.scale, { x: 1, y: 1 }, OBS_LIMITS.scale),
    align: integer(raw.align, 5, 0, 15),
    boundsType: integer(raw.bounds_type, 0, 0, 6),
    boundsAlign: integer(raw.bounds_align, 0, 0, 15),
    bounds: vec2(raw.bounds, { x: 0, y: 0 }, OBS_LIMITS.coordinate),
    crop: {
      left: cropPixels(raw.crop_left),
      top: cropPixels(raw.crop_top),
      right: cropPixels(raw.crop_right),
      bottom: cropPixels(raw.crop_bottom),
    },
    cropToBounds: bool(raw.bounds_crop, false),
  };
}

function parseSource(raw: unknown): ObsSource | null {
  if (!isRecord(raw)) return null;
  const kind = baseKind(raw.id) || baseKind(raw.versioned_id);
  const name = cleanString(raw.name);
  if (!kind || !name) return null;
  const settings = isRecord(raw.settings) ? raw.settings : {};
  const isContainer = kind === "scene" || kind === "group";
  const rawItems = isContainer && Array.isArray(settings.items) ? settings.items : [];
  const items = rawItems
    .slice(0, OBS_LIMITS.itemsPerScene)
    .map(parseItem)
    .filter((item): item is ObsSceneItem => item !== null);
  return {
    kind,
    name,
    uuid: cleanString(raw.uuid, 64) || null,
    settings,
    volume: finite(raw.volume, 1, 0, 20),
    muted: bool(raw.muted, false),
    items,
  };
}

/** Parse untrusted collection JSON (already decoded with `JSON.parse`). */
export function parseObsCollection(raw: unknown, fallbackName = "OBS"): ObsParseResult {
  if (!isRecord(raw) || !Array.isArray(raw.sources)) {
    return { ok: false, error: "That file is not an OBS scene collection." };
  }
  if (raw.sources.length > OBS_LIMITS.sources) {
    return { ok: false, error: `That collection has more than ${OBS_LIMITS.sources} sources, which is more than Replayr can import.` };
  }
  const sources = raw.sources.map(parseSource).filter((source): source is ObsSource => source !== null);
  const globalAudio = GLOBAL_AUDIO_KEYS.map((key) => parseSource(raw[key])).filter(
    (source): source is ObsSource => source !== null,
  );
  const sceneNames = new Set(sources.filter((source) => source.kind === "scene").map((source) => source.name));
  const listed = Array.isArray(raw.scene_order)
    ? raw.scene_order.map((entry) => cleanString(isRecord(entry) ? entry.name : entry)).filter((name) => sceneNames.has(name))
    : [];
  const sceneOrder = uniqueStrings([...listed, ...sceneNames]).slice(0, OBS_LIMITS.scenes);
  return {
    ok: true,
    collection: {
      name: cleanString(raw.name, 64) || cleanString(fallbackName, 64) || "OBS",
      sceneOrder,
      sources,
      globalAudio,
    },
  };
}

/** Parse collection text, rejecting anything that is not JSON. */
export function parseObsCollectionText(text: string, fallbackName?: string): ObsParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "That file is not an OBS scene collection." };
  }
  return parseObsCollection(raw, fallbackName);
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}
