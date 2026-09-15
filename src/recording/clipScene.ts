import type { AppSettings } from "../types/settings";
import { snapshotRecordingComposition, type RecordingComposition } from "./composition";
import {
  createSource,
  findSourceByType,
  FULL_CROP,
  FULL_FRAME,
  imageSettingsOf,
  newSceneId,
  overlaySettingsOf,
  primaryCapture,
  textSettingsOf,
  type RecordingScene,
} from "./scene";
import { activeSceneOf, sanitizeLibrary, type RecordingSceneLibrary } from "./sceneLibrary";

export const CLIP_SCENE_LIBRARY_KEY = "replay.clipSceneLibrary";
export const MAX_CLIP_SETTINGS_JSON_BYTES = 200 * 1024;

type ClipPersistJob = {
  library: RecordingSceneLibrary;
  composition: RecordingComposition;
};

let persistTimer: number | null = null;
let pendingJob: ClipPersistJob | null = null;
let persistWriter: ((job: ClipPersistJob) => Promise<void>) | null = null;

export function bindClipSceneWriter(writer: ((job: ClipPersistJob) => Promise<void>) | null): void {
  persistWriter = writer;
}

export function scheduleClipScenePersist(library: RecordingSceneLibrary, settings: AppSettings): void {
  const clean = sanitizeLibrary(library);
  pendingJob = {
    library: clean,
    composition: snapshotRecordingComposition(activeSceneOf(clean), settings),
  };
  if (typeof window === "undefined") return;
  if (persistTimer != null) window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    void flushClipSceneSettings();
  }, 400);
}

export async function flushClipSceneSettings(): Promise<void> {
  if (typeof window !== "undefined" && persistTimer != null) {
    window.clearTimeout(persistTimer);
    persistTimer = null;
  }
  const job = pendingJob;
  pendingJob = null;
  if (!job || !persistWriter) return;
  const encoded = JSON.stringify({
    clipSceneLibrary: job.library,
    clipComposition: job.composition,
  });
  if (encoded.length > MAX_CLIP_SETTINGS_JSON_BYTES) {
    console.warn("clip scene is too large to persist to settings");
    return;
  }
  await persistWriter(job);
}

export function persistClipLibraryLocal(library: RecordingSceneLibrary): void {
  const clean = sanitizeLibrary(library);
  try {
    localStorage.setItem(CLIP_SCENE_LIBRARY_KEY, JSON.stringify(clean));
  } catch {
    /* private mode */
  }
}

export function loadStoredClipLibrary(): RecordingSceneLibrary | null {
  try {
    const raw = localStorage.getItem(CLIP_SCENE_LIBRARY_KEY);
    if (!raw) return null;
    return sanitizeStoredClipLibrary(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

export function sanitizeStoredClipLibrary(raw: unknown): RecordingSceneLibrary | null {
  if (raw == null) return null;
  const clean = sanitizeLibrary(raw);
  if (!clean.scenes.length) return null;
  return {
    ...clean,
    scenes: clean.scenes.map((scene) => ({ ...scene, outputMode: "legacy" as const })),
  };
}

export function seedClipLibrary(settings: AppSettings): RecordingSceneLibrary {
  const scene = seedClipScene(settings);
  return sanitizeLibrary({
    version: 2,
    activeId: scene.id,
    scenes: [scene],
  });
}

export function loadClipLibrary(settings: AppSettings): RecordingSceneLibrary {
  const local = loadStoredClipLibrary();
  if (local) return local;
  const fromSettings = sanitizeStoredClipLibrary(settings.clipSceneLibrary);
  if (fromSettings) {
    persistClipLibraryLocal(fromSettings);
    return fromSettings;
  }
  const seeded = seedClipLibrary(settings);
  persistClipLibraryLocal(seeded);
  return seeded;
}

export function seedClipScene(settings: AppSettings): RecordingScene {
  const sources = [
    createSource("game", {
      order: 1,
      enabled: true,
      locked: true,
      transform: { ...FULL_FRAME },
    }),
  ];
  if (settings.gameAudioEnabled) {
    sources.push(createSource("gameAudio", { order: 2, enabled: true }));
  }
  if (settings.systemAudioEnabled) {
    sources.push(createSource("desktopAudio", { order: 3, enabled: true }));
  }
  if (settings.micEnabled) {
    sources.push(createSource("microphone", { order: 4, enabled: true }));
  }
  if (settings.webcam.enabled) {
    sources.push(
      createSource("webcam", {
        order: 5,
        enabled: true,
        webcam: settings.webcam,
        settings: { shape: settings.webcam.defaultShape },
      }),
    );
  }
  const visuals = settings.recordingVisuals;
  if (visuals.filter !== "none" || visuals.overlays.timestamp) {
    sources.push(
      createSource("replayrOverlay", {
        order: 6,
        enabled: true,
        locked: true,
        settings: {
          filter: visuals.filter,
          recIndicator: false,
          timestamp: visuals.overlays.timestamp,
        },
      }),
    );
  }
  return {
    id: newSceneId(),
    name: "Clip Layout",
    outputMode: "legacy",
    sources,
  };
}

/** True when Save Clip must re-encode gameplay to burn layout overlays. Webcam stays a sidecar. */
export function clipSceneNeedsCompose(scene: RecordingScene): boolean {
  const capture = primaryCapture(scene);
  if (capture?.enabled) {
    const transform = capture.transform ?? FULL_FRAME;
    if (!isFullFrame(transform)) return true;
    const crop = capture.crop ?? FULL_CROP;
    if (!isFullCrop(crop)) return true;
  }
  for (const source of scene.sources) {
    if (!source.enabled) continue;
    if (source.type === "image" && imageSettingsOf(source).path.trim()) return true;
    if (source.type === "text" && textSettingsOf(source).text.trim()) return true;
    if (source.type === "replayrOverlay") {
      const overlay = overlaySettingsOf(source);
      if (overlay.filter !== "none" || overlay.recIndicator || overlay.timestamp) return true;
    }
  }
  return false;
}

export function clipSceneHasWebcam(scene: RecordingScene): boolean {
  return Boolean(findSourceByType(scene, "webcam")?.enabled);
}

/** Recording-tab settings the clip studio must never write. */
export const CLIP_FORBIDDEN_SETTING_KEYS = [
  "micEnabled",
  "gameAudioEnabled",
  "systemAudioEnabled",
  "recordingVisuals",
  "instantReplayEnabled",
] as const;

export function isForbiddenClipSettingKey(key: string): boolean {
  return (CLIP_FORBIDDEN_SETTING_KEYS as readonly string[]).includes(key);
}

function isFullFrame(transform: { x: number; y: number; w: number; h: number }): boolean {
  return transform.x <= 1e-4 && transform.y <= 1e-4 && transform.w >= 1 - 1e-4 && transform.h >= 1 - 1e-4;
}

function isFullCrop(crop: { x: number; y: number; w: number; h: number }): boolean {
  return crop.x <= 1e-4 && crop.y <= 1e-4 && crop.w >= 1 - 1e-4 && crop.h >= 1 - 1e-4;
}
