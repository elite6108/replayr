import type { ClipSourceLayout } from "../types/clip";
import type { AppSettings, GameplayVisualFilter } from "../types/settings";
import { nearestWebcamPlacement } from "../utils/clips";
import { filterComposedSupported, sourceComposedSupported } from "./registry";
import {
  AUDIO_SOURCE_TYPES,
  desktopCaptureSettingsOf,
  findSourceByType,
  imageSettingsOf,
  isPrimaryCapture,
  overlaySettingsOf,
  primaryCapture,
  textSettingsOf,
  webcamSettingsOf,
  type RecordingScene,
  type RecordingSource,
  type SourceTransform,
} from "./scene";

export type CompositionTransform = {
  x: number;
  y: number;
  w: number;
  h: number;
  opacity: number;
};

export type CaptureCompositionSource = {
  kind: "capture";
  id: string;
  name: string;
  capture: "game" | "display" | "window";
  enabled: boolean;
  order: number;
  transform: CompositionTransform;
  monitorId?: string | null;
};

export type WebcamCompositionSource = {
  kind: "webcam";
  id: string;
  name: string;
  enabled: boolean;
  order: number;
  transform: CompositionTransform;
  deviceId: string;
  width: number;
  height: number;
  fps: number;
  mirror: boolean;
};

export type ImageCompositionSource = {
  kind: "image";
  id: string;
  name: string;
  enabled: boolean;
  order: number;
  transform: CompositionTransform;
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

export type RecordingComposition = {
  canvas: { width: number; height: number; fps: number };
  audio: ComposedAudioRouting;
  sources: Array<
    | CaptureCompositionSource
    | WebcamCompositionSource
    | ImageCompositionSource
    | TextCompositionSource
    | OverlayCompositionSource
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

/** Session-only overlay. Instant Replay clips keep using `settings.webcam.defaultPlacement`. */
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
  if (settings.resolution === "720p") return { width: 1280, height: 720, fps };
  if (settings.resolution === "1080p") return { width: 1920, height: 1080, fps };
  return { width: 0, height: 0, fps };
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
    monitorId: source.type === "display" ? desktopCaptureSettingsOf(source).monitorId : null,
  };
}

function asWebcam(source: RecordingSource, settings: AppSettings): WebcamCompositionSource | null {
  if (source.type !== "webcam") return null;
  return {
    kind: "webcam",
    id: source.id,
    name: source.name,
    enabled: source.enabled,
    order: source.order,
    transform: asTransform(source.transform),
    deviceId: settings.webcam.deviceId,
    width: settings.webcam.width,
    height: settings.webcam.height,
    fps: settings.webcam.fps,
    mirror: settings.webcam.mirrorPreview,
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

export function snapshotRecordingComposition(scene: RecordingScene, settings: AppSettings): RecordingComposition {
  const frozenScene: RecordingScene = {
    id: scene.id,
    name: scene.name,
    outputMode: scene.outputMode,
    sources: scene.sources.map((source) => ({
      ...source,
      transform: source.transform ? { ...source.transform } : null,
      settings: { ...source.settings },
    })),
  };
  return buildRecordingComposition(frozenScene, {
    ...settings,
    webcam: { ...settings.webcam },
    recordingVisuals: {
      filter: settings.recordingVisuals.filter,
      overlays: { ...settings.recordingVisuals.overlays },
    },
  });
}

export function composedStartBlocker(scene: RecordingScene, settings: AppSettings): string | null {
  if (settings.instantReplayEnabled) {
    return "Turn off Instant Replay to use Composed Recording.";
  }
  const capture = primaryCapture(scene);
  if (!capture || !capture.enabled) {
    return "Composed recording needs a Game or Desktop capture source.";
  }
  if (capture.type === "window" || !sourceComposedSupported(capture.type)) {
    return "Window capture is not available in composed recording yet. Use Game or Desktop.";
  }
  const overlay = scene.sources.find((source) => source.type === "replayrOverlay" && source.enabled);
  if (overlay) {
    const filter = overlaySettingsOf(overlay).filter;
    if (!filterComposedSupported(filter)) {
      return "That visual filter is not yet available in composed recording.";
    }
  }
  return null;
}

export function buildRecordingComposition(scene: RecordingScene, settings: AppSettings): RecordingComposition {
  const sources: RecordingComposition["sources"] = [];
  const capture = primaryCapture(scene);
  if (capture && sourceComposedSupported(capture.type)) {
    const payload = asCapture(capture);
    if (payload) sources.push(payload);
  }
  for (const source of scene.sources) {
    if (!sourceComposedSupported(source.type)) continue;
    if (source.type === "webcam") {
      const payload = asWebcam(source, settings);
      if (payload) sources.push(payload);
    } else if (source.type === "image") {
      const payload = asImage(source);
      if (payload) sources.push(payload);
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
    sources,
  };
}
