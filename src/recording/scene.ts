import type {
  AppSettings,
  GameplayVisualFilter,
  RecordingVisualSettings,
  WebcamPlacement,
  WebcamSettings,
  WebcamShape,
} from "../types/settings";
import { DEFAULT_RECORDING_VISUALS, DEFAULT_WEBCAM_SETTINGS } from "../types/settings";

export const RECORDING_SCENE_STORAGE_KEY = "replay.recordingScene";

export type RecordingOutputMode = "legacy" | "composed";

export type RecordingSourceCapability = "recorded" | "sidecar" | "preview_only" | "unsupported";

export type RecordingSourceType =
  | "game"
  | "display"
  | "window"
  | "webcam"
  | "microphone"
  | "desktopAudio"
  | "gameAudio"
  | "image"
  | "text"
  | "replayrOverlay"
  | "browser"
  | "captureCard"
  | "videoFile"
  | "audioFile";

export type SourceTransform = {
  x: number;
  y: number;
  w: number;
  h: number;
};

export type ImageSourceSettings = {
  path: string;
  opacity: number;
};

export type TextSourceSettings = {
  text: string;
  color: string;
  size: number;
  align: "left" | "center" | "right";
};

export type OverlaySourceSettings = {
  filter: GameplayVisualFilter;
  recIndicator: boolean;
  timestamp: boolean;
};

export type WebcamSourceSettings = {
  shape: WebcamShape;
};

export type DesktopCaptureSettings = {
  monitorId: string | null;
};

export type RecordingSource = {
  id: string;
  type: RecordingSourceType;
  name: string;
  enabled: boolean;
  locked: boolean;
  order: number;
  capability: RecordingSourceCapability;
  transform: SourceTransform | null;
  settings: Record<string, unknown>;
};

export type RecordingScene = {
  id: string;
  name: string;
  outputMode: RecordingOutputMode;
  sources: RecordingSource[];
};

export type ScenePresetId = "gameplay" | "gameplayWebcam" | "desktop" | "blank";

export const PRIMARY_CAPTURE_TYPES: readonly RecordingSourceType[] = ["game", "display", "window"];
export const AUDIO_SOURCE_TYPES: readonly RecordingSourceType[] = ["microphone", "desktopAudio", "gameAudio"];
export const UNIQUE_SOURCE_TYPES: readonly RecordingSourceType[] = [
  "game",
  "display",
  "window",
  "webcam",
  "microphone",
  "desktopAudio",
  "gameAudio",
  "replayrOverlay",
];

export const FULL_FRAME: SourceTransform = { x: 0, y: 0, w: 1, h: 1 };

const SCENE_VERSION = 1;
export const MAX_SCENE_NAME = 64;

export function newSourceId(type: RecordingSourceType): string {
  return `${type}-${Math.random().toString(36).slice(2, 10)}`;
}

export function newSceneId(): string {
  return `scene-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function sanitizeSceneName(raw: unknown, fallback = "Scene"): string {
  const stripped = String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, MAX_SCENE_NAME);
  return stripped || fallback;
}

export function sanitizeSceneId(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 64) return null;
  if (!/^scene-[a-zA-Z0-9]+$/.test(raw)) return null;
  return raw;
}

export function isPrimaryCapture(type: RecordingSourceType): boolean {
  return PRIMARY_CAPTURE_TYPES.includes(type);
}

export function isAudioSource(type: RecordingSourceType): boolean {
  return AUDIO_SOURCE_TYPES.includes(type);
}

export function isVisualSource(type: RecordingSourceType): boolean {
  return !isAudioSource(type);
}

export function clampUnit(value: number, min = 0, max = 1): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function clampTransform(transform: SourceTransform): SourceTransform {
  const w = clampUnit(transform.w, 0.06, 1);
  const h = clampUnit(transform.h, 0.06, 1);
  return {
    w,
    h,
    x: clampUnit(transform.x, 0, 1 - w),
    y: clampUnit(transform.y, 0, 1 - h),
  };
}

export function defaultTransform(type: RecordingSourceType, webcam?: Pick<WebcamSettings, "defaultPlacement" | "defaultWidth">): SourceTransform | null {
  if (isAudioSource(type)) return null;
  if (type === "webcam") {
    return placementToTransform(
      webcam?.defaultPlacement ?? DEFAULT_WEBCAM_SETTINGS.defaultPlacement,
      webcam?.defaultWidth ?? DEFAULT_WEBCAM_SETTINGS.defaultWidth,
    );
  }
  if (type === "image") return { x: 0.7, y: 0.68, w: 0.24, h: 0.24 };
  if (type === "text") return { x: 0.04, y: 0.04, w: 0.44, h: 0.1 };
  return { ...FULL_FRAME };
}

export function placementToTransform(placement: WebcamPlacement, width: number): SourceTransform {
  const w = clampUnit(width, 0.12, 0.4);
  const h = clampUnit(w * (9 / 16), 0.08, 0.45);
  const pad = 0.03;
  const left = placement.includes("left");
  const top = placement.includes("top");
  return clampTransform({
    x: left ? pad : 1 - w - pad,
    y: top ? pad : 1 - h - pad,
    w,
    h,
  });
}

export function representableWebcamCorner(transform: SourceTransform): { placement: WebcamPlacement; width: number } | null {
  const width = clampUnit(transform.w, 0.12, 0.4);
  const pad = 0.03;
  const near = (a: number, b: number) => Math.abs(a - b) <= 0.045;
  const left = near(transform.x, pad);
  const right = near(transform.x + transform.w, 1 - pad);
  const top = near(transform.y, pad);
  const bottom = near(transform.y + transform.h, 1 - pad);
  if (left && top) return { placement: "top-left", width };
  if (right && top) return { placement: "top-right", width };
  if (left && bottom) return { placement: "bottom-left", width };
  if (right && bottom) return { placement: "bottom-right", width };
  return null;
}

export function transformFit(transform: SourceTransform): SourceTransform {
  const aspect = transform.w / transform.h;
  if (aspect >= 1) {
    const w = 1;
    const h = clampUnit(1 / aspect, 0.06, 1);
    return clampTransform({ x: 0, y: (1 - h) / 2, w, h });
  }
  const h = 1;
  const w = clampUnit(aspect, 0.06, 1);
  return clampTransform({ x: (1 - w) / 2, y: 0, w, h });
}

export function transformFill(): SourceTransform {
  return { ...FULL_FRAME };
}

export function transformCenter(transform: SourceTransform): SourceTransform {
  return clampTransform({
    ...transform,
    x: (1 - transform.w) / 2,
    y: (1 - transform.h) / 2,
  });
}

export function imageSettingsOf(source: RecordingSource): ImageSourceSettings {
  const path = typeof source.settings.path === "string" ? source.settings.path : "";
  const opacity = typeof source.settings.opacity === "number" ? clampUnit(source.settings.opacity) : 1;
  return { path, opacity };
}

export function textSettingsOf(source: RecordingSource): TextSourceSettings {
  const align = source.settings.align;
  return {
    text: typeof source.settings.text === "string" ? source.settings.text : "Text",
    color: typeof source.settings.color === "string" ? source.settings.color : "#ffffff",
    size: typeof source.settings.size === "number" ? Math.max(10, Math.min(96, source.settings.size)) : 28,
    align: align === "center" || align === "right" ? align : "left",
  };
}

export function overlaySettingsOf(source: RecordingSource): OverlaySourceSettings {
  const filter = source.settings.filter;
  return {
    filter:
      filter === "bodycam" || filter === "dashcam" || filter === "vhs" || filter === "cinematic" || filter === "none"
        ? filter
        : DEFAULT_RECORDING_VISUALS.filter,
    recIndicator: Boolean(source.settings.recIndicator),
    timestamp: Boolean(source.settings.timestamp),
  };
}

export function desktopCaptureSettingsOf(source: RecordingSource): DesktopCaptureSettings {
  const monitorId = typeof source.settings.monitorId === "string" ? source.settings.monitorId.trim() : "";
  return { monitorId: monitorId || null };
}

export function webcamSettingsOf(source: RecordingSource): WebcamSourceSettings {
  const shape = source.settings.shape;
  return {
    shape: shape === "rectangle" || shape === "rounded" || shape === "circle" ? shape : DEFAULT_WEBCAM_SETTINGS.defaultShape,
  };
}

export function overlayToVisuals(source: RecordingSource | undefined, fallback: RecordingVisualSettings): RecordingVisualSettings {
  if (!source) return fallback;
  if (!source.enabled) {
    return { filter: "none", overlays: { recIndicator: false, timestamp: false } };
  }
  const overlay = overlaySettingsOf(source);
  return {
    filter: overlay.filter,
    overlays: { recIndicator: overlay.recIndicator, timestamp: overlay.timestamp },
  };
}

export function visualsToOverlaySettings(visuals: RecordingVisualSettings): OverlaySourceSettings {
  return {
    filter: visuals.filter,
    recIndicator: visuals.overlays.recIndicator,
    timestamp: visuals.overlays.timestamp,
  };
}

export function hasPreviewOnlySources(scene: RecordingScene): boolean {
  return scene.sources.some((source) => source.enabled && source.capability === "preview_only");
}

export function sourcesFrontFirst(sources: RecordingSource[]): RecordingSource[] {
  return [...sources].sort((a, b) => b.order - a.order || a.name.localeCompare(b.name));
}

export function sourcesBackFirst(sources: RecordingSource[]): RecordingSource[] {
  return [...sources].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

export function nextOrder(sources: RecordingSource[]): number {
  return sources.reduce((max, source) => Math.max(max, source.order), 0) + 1;
}

export function findSource(scene: RecordingScene, id: string | null | undefined): RecordingSource | undefined {
  if (!id) return undefined;
  return scene.sources.find((source) => source.id === id);
}

export function findSourceByType(scene: RecordingScene, type: RecordingSourceType): RecordingSource | undefined {
  return scene.sources.find((source) => source.type === type);
}

export function primaryCapture(scene: RecordingScene): RecordingSource | undefined {
  return scene.sources.find((source) => isPrimaryCapture(source.type) && source.enabled)
    ?? scene.sources.find((source) => isPrimaryCapture(source.type));
}

function capabilityFor(type: RecordingSourceType): RecordingSourceCapability {
  if (type === "webcam") return "sidecar";
  if (type === "image" || type === "text" || type === "replayrOverlay") return "preview_only";
  if (type === "window" || type === "browser" || type === "captureCard" || type === "videoFile" || type === "audioFile") {
    return "unsupported";
  }
  return "recorded";
}

function defaultName(type: RecordingSourceType): string {
  switch (type) {
    case "game":
      return "Game Capture";
    case "display":
      return "Desktop Capture";
    case "window":
      return "Window Capture";
    case "webcam":
      return "Webcam";
    case "microphone":
      return "Microphone";
    case "desktopAudio":
      return "Desktop Audio";
    case "gameAudio":
      return "Game Audio";
    case "image":
      return "Image";
    case "text":
      return "Text";
    case "replayrOverlay":
      return "Replayr Overlay";
    case "browser":
      return "Browser";
    case "captureCard":
      return "Capture Card";
    case "videoFile":
      return "Video File";
    case "audioFile":
      return "Audio File";
    default:
      return "Source";
  }
}

export function createSource(
  type: RecordingSourceType,
  options: {
    order: number;
    enabled?: boolean;
    locked?: boolean;
    name?: string;
    transform?: SourceTransform | null;
    settings?: Record<string, unknown>;
    webcam?: Pick<WebcamSettings, "defaultPlacement" | "defaultWidth" | "defaultShape">;
  },
): RecordingSource {
  const capability = capabilityFor(type);
  const settings = { ...(options.settings ?? {}) };
  if (type === "webcam" && settings.shape == null) {
    settings.shape = options.webcam?.defaultShape ?? DEFAULT_WEBCAM_SETTINGS.defaultShape;
  }
  return {
    id: newSourceId(type),
    type,
    name: options.name ?? defaultName(type),
    enabled: options.enabled ?? capability !== "unsupported",
    locked: options.locked ?? isPrimaryCapture(type),
    order: options.order,
    capability,
    transform: options.transform === undefined ? defaultTransform(type, options.webcam) : options.transform,
    settings,
  };
}

export function replacePrimary(scene: RecordingScene, type: "game" | "display" | "window"): RecordingScene {
  const existing = scene.sources.find((source) => isPrimaryCapture(source.type));
  const next = createSource(type, {
    order: existing?.order ?? nextOrder(scene.sources),
    enabled: type !== "window",
    locked: true,
    transform: existing?.transform ?? { ...FULL_FRAME },
  });
  return {
    ...scene,
    sources: [...scene.sources.filter((source) => !isPrimaryCapture(source.type)), next],
  };
}

export function upsertUniqueSource(
  scene: RecordingScene,
  type: RecordingSourceType,
  factory: (order: number, existing?: RecordingSource) => RecordingSource,
): RecordingScene {
  const existing = findSourceByType(scene, type);
  if (existing) {
    return {
      ...scene,
      sources: scene.sources.map((source) => (source.id === existing.id ? factory(existing.order, existing) : source)),
    };
  }
  return { ...scene, sources: [...scene.sources, factory(nextOrder(scene.sources))] };
}

export function updateSource(
  scene: RecordingScene,
  id: string,
  patch: Partial<Omit<RecordingSource, "id" | "type" | "capability">> & { settings?: Record<string, unknown> },
): RecordingScene {
  return {
    ...scene,
    sources: scene.sources.map((source) => {
      if (source.id !== id) return source;
      return {
        ...source,
        ...patch,
        settings: patch.settings ? { ...source.settings, ...patch.settings } : source.settings,
        transform: patch.transform === undefined ? source.transform : patch.transform,
      };
    }),
  };
}

export function removeSource(scene: RecordingScene, id: string): RecordingScene {
  return { ...scene, sources: scene.sources.filter((source) => source.id !== id) };
}

export function setSourceEnabled(scene: RecordingScene, id: string, enabled: boolean): RecordingScene {
  const target = findSource(scene, id);
  if (!target) return scene;
  if (enabled && isPrimaryCapture(target.type)) {
    return {
      ...scene,
      sources: scene.sources.map((source) => {
        if (isPrimaryCapture(source.type)) return { ...source, enabled: source.id === id };
        return source;
      }),
    };
  }
  return updateSource(scene, id, { enabled });
}

export function moveSource(scene: RecordingScene, id: string, direction: "front" | "back"): RecordingScene {
  return moveSourceAmong(scene, id, direction);
}

export function moveSourceAmong(
  scene: RecordingScene,
  id: string,
  direction: "front" | "back",
  match: (source: RecordingSource) => boolean = () => true,
): RecordingScene {
  const ordered = sourcesFrontFirst(scene.sources.filter(match));
  const index = ordered.findIndex((source) => source.id === id);
  if (index < 0) return scene;
  const swapWith = direction === "front" ? index - 1 : index + 1;
  if (swapWith < 0 || swapWith >= ordered.length) return scene;
  const current = ordered[index];
  const other = ordered[swapWith];
  if (!current || !other) return scene;
  return {
    ...scene,
    sources: scene.sources.map((source) => {
      if (source.id === current.id) return { ...source, order: other.order };
      if (source.id === other.id) return { ...source, order: current.order };
      return source;
    }),
  };
}

export function reorderSource(scene: RecordingScene, id: string, beforeId: string | null): RecordingScene {
  return reorderSourceAmong(scene, id, beforeId);
}

export function reorderSourceAmong(
  scene: RecordingScene,
  id: string,
  beforeId: string | null,
  match: (source: RecordingSource) => boolean = () => true,
): RecordingScene {
  const ordered = sourcesFrontFirst(scene.sources.filter(match));
  const from = ordered.findIndex((source) => source.id === id);
  if (from < 0) return scene;
  const [moved] = ordered.splice(from, 1);
  if (!moved) return scene;
  const to = beforeId ? ordered.findIndex((source) => source.id === beforeId) : ordered.length;
  if (to < 0) ordered.push(moved);
  else ordered.splice(to, 0, moved);
  const ranks = ordered.map((source) => source.order).sort((left, right) => right - left);
  return {
    ...scene,
    sources: scene.sources.map((source) => {
      const index = ordered.findIndex((item) => item.id === source.id);
      if (index < 0) return source;
      return { ...source, order: ranks[index] ?? source.order };
    }),
  };
}

export function emptyScene(name = "Scene"): RecordingScene {
  return {
    id: newSceneId(),
    name: sanitizeSceneName(name),
    outputMode: "legacy",
    sources: [],
  };
}

export function sceneFromSettings(settings: AppSettings): RecordingScene {
  const sources: RecordingSource[] = [];
  let order = 1;
  sources.push(
    createSource("game", {
      order: order++,
      enabled: true,
      locked: true,
      transform: { ...FULL_FRAME },
    }),
  );
  if (settings.gameAudioEnabled) {
    sources.push(createSource("gameAudio", { order: order++, enabled: true }));
  }
  if (settings.systemAudioEnabled) {
    sources.push(createSource("desktopAudio", { order: order++, enabled: true }));
  }
  if (settings.micEnabled) {
    sources.push(createSource("microphone", { order: order++, enabled: true }));
  }
  if (settings.webcam.enabled) {
    sources.push(
      createSource("webcam", {
        order: order++,
        enabled: true,
        locked: false,
        webcam: settings.webcam,
        settings: { shape: settings.webcam.defaultShape },
      }),
    );
  }
  const visuals = settings.recordingVisuals ?? DEFAULT_RECORDING_VISUALS;
  if (visuals.filter !== "none" || visuals.overlays.recIndicator || visuals.overlays.timestamp) {
    sources.push(
      createSource("replayrOverlay", {
        order: order++,
        enabled: true,
        locked: true,
        settings: visualsToOverlaySettings(visuals),
      }),
    );
  }
  return {
    id: newSceneId(),
    name: "Gameplay",
    outputMode: "legacy",
    sources,
  };
}

export function presetSceneName(preset: ScenePresetId): string {
  if (preset === "blank") return "Blank";
  if (preset === "desktop") return "Desktop";
  if (preset === "gameplayWebcam") return "Gameplay + Webcam";
  return "Gameplay";
}

export function sceneFromPreset(preset: ScenePresetId, settings: AppSettings): RecordingScene {
  if (preset === "blank") {
    return { ...emptyScene("Blank"), name: "Blank" };
  }
  const sources: RecordingSource[] = [];
  let order = 1;
  const primary = preset === "desktop" ? "display" : "game";
  sources.push(
    createSource(primary, {
      order: order++,
      enabled: true,
      locked: true,
      transform: { ...FULL_FRAME },
    }),
  );
  if (settings.gameAudioEnabled) {
    sources.push(createSource("gameAudio", { order: order++, enabled: true }));
  }
  if (settings.systemAudioEnabled) {
    sources.push(createSource("desktopAudio", { order: order++, enabled: true }));
  }
  if (settings.micEnabled) {
    sources.push(createSource("microphone", { order: order++, enabled: true }));
  }
  if (preset === "gameplayWebcam") {
    sources.push(
      createSource("webcam", {
        order: order++,
        enabled: true,
        webcam: settings.webcam,
        settings: { shape: settings.webcam.defaultShape },
      }),
    );
  }
  const visuals = settings.recordingVisuals ?? DEFAULT_RECORDING_VISUALS;
  if (visuals.filter !== "none" || visuals.overlays.recIndicator || visuals.overlays.timestamp) {
    sources.push(
      createSource("replayrOverlay", {
        order: order++,
        enabled: true,
        locked: true,
        settings: visualsToOverlaySettings(visuals),
      }),
    );
  }
  return {
    id: newSceneId(),
    name: preset === "desktop" ? "Desktop" : preset === "gameplayWebcam" ? "Gameplay + Webcam" : "Gameplay",
    outputMode: "legacy",
    sources,
  };
}

function isSourceType(value: unknown): value is RecordingSourceType {
  return (
    value === "game" ||
    value === "display" ||
    value === "window" ||
    value === "webcam" ||
    value === "microphone" ||
    value === "desktopAudio" ||
    value === "gameAudio" ||
    value === "image" ||
    value === "text" ||
    value === "replayrOverlay" ||
    value === "browser" ||
    value === "captureCard" ||
    value === "videoFile" ||
    value === "audioFile"
  );
}

function sanitizeSource(raw: Partial<RecordingSource>, index: number): RecordingSource | null {
  if (!isSourceType(raw.type)) return null;
  const type = raw.type;
  const capability = capabilityFor(type);
  const transform = raw.transform && typeof raw.transform === "object"
    ? clampTransform({
        x: Number(raw.transform.x),
        y: Number(raw.transform.y),
        w: Number(raw.transform.w),
        h: Number(raw.transform.h),
      })
    : defaultTransform(type);
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : newSourceId(type),
    type,
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name : defaultName(type),
    enabled: raw.enabled !== false && capability !== "unsupported",
    locked: Boolean(raw.locked),
    order: Number.isFinite(raw.order) ? Number(raw.order) : index + 1,
    capability,
    transform: isAudioSource(type) ? null : transform,
    settings: raw.settings && typeof raw.settings === "object" ? { ...raw.settings } : {},
  };
}

export function sanitizeScene(raw: unknown): RecordingScene | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<RecordingScene> & { version?: number };
  const sources = Array.isArray(value.sources)
    ? value.sources
        .map((source, index) => sanitizeSource(source as Partial<RecordingSource>, index))
        .filter((source): source is RecordingSource => Boolean(source))
    : [];
  if (sources.filter((source) => isPrimaryCapture(source.type)).length > 1) {
    const keep = sources.find((source) => isPrimaryCapture(source.type) && source.enabled)
      ?? sources.find((source) => isPrimaryCapture(source.type));
    const cleaned = sources.filter((source) => !isPrimaryCapture(source.type) || source.id === keep?.id);
    return sanitizeScene({ ...value, sources: cleaned });
  }
  return {
    id: sanitizeSceneId(value.id) ?? newSceneId(),
    name: sanitizeSceneName(value.name),
    outputMode: value.outputMode === "composed" ? "composed" : "legacy",
    sources,
  };
}

export function loadStoredScene(): RecordingScene | null {
  try {
    const raw = localStorage.getItem(RECORDING_SCENE_STORAGE_KEY);
    if (!raw) return null;
    return sanitizeScene(JSON.parse(raw));
  } catch {
    return null;
  }
}

let lastPersistedScene: RecordingScene | null = null;

export function persistScene(scene: RecordingScene): void {
  lastPersistedScene = scene;
  try {
    localStorage.setItem(
      RECORDING_SCENE_STORAGE_KEY,
      JSON.stringify({ version: SCENE_VERSION, ...scene }),
    );
  } catch {
    /* private mode */
  }
}

export function loadOrMigrateScene(settings: AppSettings): RecordingScene {
  return lastPersistedScene ?? loadStoredScene() ?? sceneFromSettings(settings);
}

export function applySettingsFlags(scene: RecordingScene, settings: AppSettings): RecordingScene {
  let next = scene;
  const syncEnabled = (type: RecordingSourceType, enabled: boolean, createIfMissing: boolean) => {
    const existing = findSourceByType(next, type);
    if (existing) {
      if (existing.enabled !== enabled) next = updateSource(next, existing.id, { enabled });
      return;
    }
    if (createIfMissing && enabled) {
      next = {
        ...next,
        sources: [
          ...next.sources,
          createSource(type, {
            order: nextOrder(next.sources),
            enabled: true,
            webcam: settings.webcam,
            settings: type === "webcam" ? { shape: settings.webcam.defaultShape } : type === "replayrOverlay" ? visualsToOverlaySettings(settings.recordingVisuals) : {},
          }),
        ],
      };
    }
  };
  syncEnabled("webcam", settings.webcam.enabled, true);
  syncEnabled("microphone", settings.micEnabled, true);
  syncEnabled("gameAudio", settings.gameAudioEnabled, true);
  syncEnabled("desktopAudio", settings.systemAudioEnabled, true);

  const overlay = findSourceByType(next, "replayrOverlay");
  const visuals = settings.recordingVisuals ?? DEFAULT_RECORDING_VISUALS;
  const visualsOn = visuals.filter !== "none" || visuals.overlays.recIndicator || visuals.overlays.timestamp;
  if (overlay) {
    next = updateSource(next, overlay.id, {
      enabled: overlay.enabled,
      settings: visualsToOverlaySettings(visuals),
    });
  } else if (visualsOn) {
    next = {
      ...next,
      sources: [
        ...next.sources,
        createSource("replayrOverlay", {
          order: nextOrder(next.sources),
          enabled: true,
          locked: true,
          settings: visualsToOverlaySettings(visuals),
        }),
      ],
    };
  }

  const webcam = findSourceByType(next, "webcam");
  if (webcam) {
    const shape = settings.webcam.defaultShape;
    if (webcamSettingsOf(webcam).shape !== shape && representableWebcamCorner(webcam.transform ?? placementToTransform(settings.webcam.defaultPlacement, settings.webcam.defaultWidth))) {
      next = updateSource(next, webcam.id, { settings: { shape } });
    }
  }
  return next;
}

export function sceneEquals(a: RecordingScene, b: RecordingScene): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
