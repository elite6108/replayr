import type { ClipSourceLayout } from "../types/clip";
import type { AppSettings, GameplayVisualFilter } from "../types/settings";
import { nearestWebcamPlacement } from "../utils/clips";
import { filterComposedSupported, sourceComposedSupported } from "./registry";
import { sanitizePageUrl } from "./browserSource";
import { extraMicrophonePlans } from "./sourceAudio";
import { cameraForWebcam, windowTargetOf, type WindowTarget } from "./sourceVisual";
import {
  AUDIO_SOURCE_TYPES,
  clampCrop,
  desktopCaptureSettingsOf,
  findSourceByType,
  FULL_CROP,
  browserSettingsOf,
  imageSettingsOf,
  mediaSettingsOf,
  isNeutralPicture,
  isPrimaryCapture,
  overlaySettingsOf,
  pictureSettingsOf,
  primaryCapture,
  textSettingsOf,
  webcamSettingsOf,
  type PictureSettings,
  type RecordingScene,
  type RecordingSource,
  type SourceCrop,
  type SourceTransform,
} from "./scene";

export type CompositionTransform = {
  x: number;
  y: number;
  w: number;
  h: number;
  opacity: number;
};

export type CompositionCrop = {
  x: number;
  y: number;
  w: number;
  h: number;
};

export type CaptureCompositionSource = {
  kind: "capture";
  id: string;
  name: string;
  capture: "game" | "display" | "window";
  enabled: boolean;
  order: number;
  transform: CompositionTransform;
  crop: CompositionCrop;
  monitorId?: string | null;
  picture?: PictureSettings;
  window?: WindowTarget;
};

export type WebcamCompositionSource = {
  kind: "webcam";
  id: string;
  name: string;
  enabled: boolean;
  order: number;
  transform: CompositionTransform;
  crop: CompositionCrop;
  deviceId: string;
  width: number;
  height: number;
  fps: number;
  mirror: boolean;
  shape?: "rectangle" | "rounded" | "circle";
  picture?: PictureSettings;
};

export type ImageCompositionSource = {
  kind: "image";
  id: string;
  name: string;
  enabled: boolean;
  order: number;
  transform: CompositionTransform;
  crop: CompositionCrop;
  path: string;
};

export type TextCompositionSource = {
  kind: "text";
  id: string;
  name: string;
  enabled: boolean;
  order: number;
  transform: CompositionTransform;
  text: string;
  color: string;
  size: number;
  align: "left" | "center" | "right";
};

export type MediaCompositionSource = {
  kind: "videoFile" | "audioFile";
  id: string;
  name: string;
  enabled: boolean;
  order: number;
  transform: CompositionTransform;
  crop: CompositionCrop;
  path: string;
  loop: boolean;
  restart: boolean;
  gain: number;
};

export type BrowserCompositionSource = {
  kind: "browser";
  id: string;
  name: string;
  enabled: boolean;
  order: number;
  transform: CompositionTransform;
  crop: CompositionCrop;
  url: string;
};

export type CaptureCardCompositionSource = {
  kind: "captureCard";
  id: string;
  name: string;
  enabled: boolean;
  order: number;
  transform: CompositionTransform;
  crop: CompositionCrop;
  deviceId: string;
  width: number;
  height: number;
  fps: number;
  mirror: boolean;
  shape?: "rectangle" | "rounded" | "circle";
  picture?: PictureSettings;
};

export type OverlayCompositionSource = {
  kind: "replayrOverlay";
  id: string;
  name: string;
  enabled: boolean;
  order: number;
  filter: GameplayVisualFilter;
  recIndicator: boolean;
  timestamp: boolean;
};

export type ComposedAudioSourceRoute = {
  present: boolean;
  muted: boolean;
};

export type ComposedAudioRouting = {
  microphone: ComposedAudioSourceRoute;
  gameAudio: ComposedAudioSourceRoute;
  desktopAudio: ComposedAudioSourceRoute;
};

/** Microphones after the first. The first stays on the engine's existing capture. */
export type ExtraMicrophoneRoute = {
  id: string;
  deviceId: string;
  gain: number;
  enabled: boolean;
};

export type RecordingComposition = {
  canvas: { width: number; height: number; fps: number };
  audio: ComposedAudioRouting;
  extraMicrophones: ExtraMicrophoneRoute[];
  sources: Array<
    | CaptureCompositionSource
    | WebcamCompositionSource
    | ImageCompositionSource
    | TextCompositionSource
    | OverlayCompositionSource
    | MediaCompositionSource
    | BrowserCompositionSource
    | CaptureCardCompositionSource
  >;
};

function audioRoute(scene: RecordingScene, type: (typeof AUDIO_SOURCE_TYPES)[number]): ComposedAudioSourceRoute {
  const source = findSourceByType(scene, type);
  return {
    present: Boolean(source),
    muted: Boolean(source && !source.enabled),
  };
}

export function composedAudioRoutingFromScene(scene: RecordingScene): ComposedAudioRouting {
  return {
    microphone: audioRoute(scene, "microphone"),
    gameAudio: audioRoute(scene, "gameAudio"),
    desktopAudio: audioRoute(scene, "desktopAudio"),
  };
}

export function isAudioRouted(route: ComposedAudioSourceRoute): boolean {
  return route.present && !route.muted;
}

/** Webcam sidecar layout from a studio scene. Used by session recordings and clip saves. */
export function sessionWebcamLayoutFromScene(scene: RecordingScene): ClipSourceLayout | null {
  const webcam = findSourceByType(scene, "webcam");
  if (!webcam?.enabled) return null;
  const transform = webcam.transform;
  if (!transform) return null;
  const x = Number(transform.x);
  const y = Number(transform.y);
  const w = Number(transform.w);
  const h = Number(transform.h);
  if (![x, y, w, h].every(Number.isFinite)) return null;
  return {
    placement: nearestWebcamPlacement(x, y, w, h),
    shape: webcamSettingsOf(webcam).shape,
    width: w,
    x,
    y,
  };
}

export function canvasFromSettings(settings: AppSettings): { width: number; height: number; fps: number } {
  const fps = Math.max(24, Math.min(60, settings.fps));
  // Composed session resolves the real output after the first frame in Rust.
  // These values are IPC hints / preview canvas only.
  switch (settings.resolution) {
    case "720p":
      return { width: 1280, height: 720, fps };
    case "1080p":
      return { width: 1920, height: 1080, fps };
    case "1440p":
      return { width: 2560, height: 1440, fps };
    case "4k":
      return { width: 3840, height: 2160, fps };
    case "native":
      return { width: 0, height: 0, fps };
    case "auto":
    default:
      // Auto: safe 1080p-capped canvas hint (matches Rust resolve).
      return { width: 1920, height: 1080, fps };
  }
}

function asTransform(transform: SourceTransform | null | undefined, opacity = 1): CompositionTransform {
  const x = Number(transform?.x);
  const y = Number(transform?.y);
  const w = Number(transform?.w);
  const h = Number(transform?.h);
  return {
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0,
    w: Number.isFinite(w) ? w : 1,
    h: Number.isFinite(h) ? h : 1,
    opacity: Number.isFinite(opacity) ? Math.min(1, Math.max(0, opacity)) : 1,
  };
}

function asCrop(crop: SourceCrop | null | undefined): CompositionCrop {
  return clampCrop(crop ?? FULL_CROP);
}

function asCapture(source: RecordingSource): CaptureCompositionSource | null {
  if (!isPrimaryCapture(source.type)) return null;
  return {
    kind: "capture",
    id: source.id,
    name: source.name,
    capture: source.type === "display" ? "display" : source.type === "window" ? "window" : "game",
    enabled: source.enabled,
    order: source.order,
    transform: asTransform(source.transform),
    crop: asCrop(source.crop),
    monitorId: source.type === "display" ? desktopCaptureSettingsOf(source).monitorId : null,
    picture: asPicture(source),
    window: source.type === "window" ? windowTargetOf(source) : undefined,
  };
}

function asPicture(source: RecordingSource): PictureSettings | undefined {
  const picture = pictureSettingsOf(source);
  return isNeutralPicture(picture) ? undefined : picture;
}

function asWebcam(
  source: RecordingSource,
  sources: readonly RecordingSource[],
  settings: AppSettings,
  mirror: boolean,
): WebcamCompositionSource | null {
  if (source.type !== "webcam") return null;
  const camera = cameraForWebcam(source, sources, settings.webcam);
  const first = sources.find((item) => item.type === "webcam");
  if (!camera.deviceId && first?.id !== source.id) return null;
  return {
    kind: "webcam",
    id: source.id,
    name: source.name,
    enabled: source.enabled,
    order: source.order,
    transform: asTransform(source.transform),
    crop: asCrop(source.crop),
    deviceId: camera.deviceId,
    width: camera.width,
    height: camera.height,
    fps: camera.fps,
    mirror,
    shape: webcamSettingsOf(source).shape,
    picture: asPicture(source),
  };
}

function asMedia(source: RecordingSource): MediaCompositionSource | null {
  if (source.type !== "videoFile" && source.type !== "audioFile") return null;
  const settings = mediaSettingsOf(source);
  if (!settings.path) return null;
  return {
    kind: source.type,
    id: source.id,
    name: source.name,
    enabled: source.enabled,
    order: source.order,
    transform: asTransform(source.transform),
    crop: asCrop(source.crop),
    path: settings.path,
    loop: settings.loop,
    restart: settings.restart,
    gain: settings.gain,
  };
}

function asBrowser(source: RecordingSource): BrowserCompositionSource | null {
  if (source.type !== "browser") return null;
  const url = sanitizePageUrl(browserSettingsOf(source).url);
  if (!url) return null;
  return {
    kind: "browser",
    id: source.id,
    name: source.name,
    enabled: source.enabled,
    order: source.order,
    transform: asTransform(source.transform),
    crop: asCrop(source.crop),
    url,
  };
}

function asCaptureCard(
  source: RecordingSource,
  sources: readonly RecordingSource[],
  settings: AppSettings,
): CaptureCardCompositionSource | null {
  if (source.type !== "captureCard") return null;
  const camera = cameraForWebcam(source, sources, settings.webcam);
  if (!camera.deviceId) return null;
  return {
    kind: "captureCard",
    id: source.id,
    name: source.name,
    enabled: source.enabled,
    order: source.order,
    transform: asTransform(source.transform),
    crop: asCrop(source.crop),
    deviceId: camera.deviceId,
    width: camera.width,
    height: camera.height,
    fps: camera.fps,
    mirror: false,
    shape: webcamSettingsOf(source).shape,
    picture: asPicture(source),
  };
}

function asImage(source: RecordingSource): ImageCompositionSource | null {
  if (source.type !== "image") return null;
  const settings = imageSettingsOf(source);
  return {
    kind: "image",
    id: source.id,
    name: source.name,
    enabled: source.enabled,
    order: source.order,
    transform: asTransform(source.transform, settings.opacity),
    crop: asCrop(source.crop),
    path: settings.path,
  };
}

function asText(source: RecordingSource): TextCompositionSource | null {
  if (source.type !== "text") return null;
  const settings = textSettingsOf(source);
  return {
    kind: "text",
    id: source.id,
    name: source.name,
    enabled: source.enabled,
    order: source.order,
    transform: asTransform(source.transform),
    text: settings.text,
    color: settings.color,
    size: settings.size,
    align: settings.align,
  };
}

function asOverlay(source: RecordingSource): OverlayCompositionSource | null {
  if (source.type !== "replayrOverlay") return null;
  const settings = overlaySettingsOf(source);
  return {
    kind: "replayrOverlay",
    id: source.id,
    name: source.name,
    enabled: source.enabled,
    order: source.order,
    filter: settings.filter,
    recIndicator: settings.recIndicator,
    timestamp: settings.timestamp,
  };
}

export function snapshotRecordingComposition(
  scene: RecordingScene,
  settings: AppSettings,
  mirror = settings.webcam.mirrorPreview,
): RecordingComposition {
  const frozenScene: RecordingScene = {
    id: scene.id,
    name: scene.name,
    outputMode: scene.outputMode,
    sources: scene.sources.map((source) => ({
      ...source,
      transform: source.transform ? { ...source.transform } : null,
      crop: source.crop ? { ...source.crop } : null,
      settings: { ...source.settings },
    })),
  };
  return buildRecordingComposition(
    frozenScene,
    {
      ...settings,
      webcam: { ...settings.webcam },
      recordingVisuals: {
        filter: settings.recordingVisuals.filter,
        overlays: { ...settings.recordingVisuals.overlays },
      },
    },
    mirror,
  );
}

export const RECORD_NEEDS_IR_OFF = "Turn off Instant Replay to record.";

export const RECORDABLE_IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"] as const;

export function isRecordableImagePath(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return (RECORDABLE_IMAGE_EXTENSIONS as readonly string[]).includes(ext);
}

export function composedStartBlocker(scene: RecordingScene, settings: AppSettings): string | null {
  if (settings.instantReplayEnabled) {
    return RECORD_NEEDS_IR_OFF;
  }
  const capture = primaryCapture(scene);
  if (!capture || !capture.enabled) {
    return "Add a Game, Desktop, or Window capture to record.";
  }
  if (capture.type === "window" && !windowTargetOf(capture).title && !windowTargetOf(capture).className && !windowTargetOf(capture).exe) {
    return "Choose a window to record.";
  }
  if (!sourceComposedSupported(capture.type)) {
    return "That capture cannot be recorded yet.";
  }
  const overlay = scene.sources.find((source) => source.type === "replayrOverlay" && source.enabled);
  if (overlay) {
    const filter = overlaySettingsOf(overlay).filter;
    if (!filterComposedSupported(filter)) {
      return "That visual filter cannot be recorded yet. Choose another filter.";
    }
  }
  const badImage = scene.sources.find((source) => {
    if (source.type !== "image" || !source.enabled) return false;
    const path = imageSettingsOf(source).path;
    return Boolean(path) && !isRecordableImagePath(path);
  });
  if (badImage) {
    return `${badImage.name} is not a PNG, JPEG, GIF, or WebP. Replace it or hide it to record.`;
  }
  return null;
}

export function buildRecordingComposition(
  scene: RecordingScene,
  settings: AppSettings,
  mirror = settings.webcam.mirrorPreview,
): RecordingComposition {
  const sources: RecordingComposition["sources"] = [];
  const capture = primaryCapture(scene);
  if (capture && sourceComposedSupported(capture.type)) {
    const payload = asCapture(capture);
    if (payload) sources.push(payload);
  }
  const seenCameras = new Set<string>();
  for (const source of scene.sources) {
    if (!sourceComposedSupported(source.type)) continue;
    if (isPrimaryCapture(source.type)) {
      if (!source.enabled || source.id === capture?.id || source.type === "game") continue;
      const payload = asCapture(source);
      if (payload) sources.push(payload);
    } else if (source.type === "webcam") {
      const payload = asWebcam(source, scene.sources, settings, mirror);
      if (!payload) continue;
      const key = payload.deviceId.toLowerCase();
      if (key && seenCameras.has(key)) continue;
      if (key) seenCameras.add(key);
      sources.push(payload);
    } else if (source.type === "image") {
      const payload = asImage(source);
      if (payload) sources.push(payload);
    } else if (source.type === "videoFile" || source.type === "audioFile") {
      const payload = asMedia(source);
      if (payload) sources.push(payload);
    } else if (source.type === "browser") {
      if (!settings.browserSourcesEnabled) continue;
      const payload = asBrowser(source);
      if (payload) sources.push(payload);
    } else if (source.type === "captureCard") {
      const payload = asCaptureCard(source, scene.sources, settings);
      if (payload) {
        const key = payload.deviceId.toLowerCase();
        if (key && seenCameras.has(key)) continue;
        if (key) seenCameras.add(key);
        sources.push(payload);
      }
    } else if (source.type === "text") {
      const payload = asText(source);
      if (payload) sources.push(payload);
    } else if (source.type === "replayrOverlay") {
      const payload = asOverlay(source);
      if (payload) sources.push(payload);
    }
  }
  return {
    canvas: canvasFromSettings(settings),
    audio: composedAudioRoutingFromScene(scene),
    extraMicrophones: extraMicrophonePlans(scene.sources),
    sources,
  };
}
