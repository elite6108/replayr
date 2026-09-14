import {
  CLIP_LIBRARY_VERSION,
  DEFAULT_CLIP_STUDIO,
  type AppSettings,
  type ClipStudioSettings,
  type SerializedClipRect,
  type SerializedClipScene,
  type SerializedClipSource,
} from "../types/settings";
import {
  FULL_CROP,
  FULL_FRAME,
  capabilityFor,
  createSource,
  newSceneId,
  nextOrder,
  placementToTransform,
  type RecordingScene,
  type RecordingSource,
  type RecordingSourceType,
  type SourceCrop,
  type SourceTransform,
} from "./scene";
import { LIBRARY_VERSION, sanitizeLibrary, type RecordingSceneLibrary } from "./sceneLibrary";

/**
 * The Clips studio's library lives on the settings document, not in localStorage, because Save
 * Clip is reachable from the F10 hotkey and the tray with no frontend payload. This module is
 * the only place that converts between the persisted shape and the in-memory `RecordingScene`
 * the studio components already understand.
 *
 * Clip scenes carry no `outputMode` (they are always "layout, burn on save") and no
 * `capability` (re-derived from `type`), matching the Rust structs in src-tauri/src/settings.rs.
 */

const CLIP_SCENE_NAME = "Clip";

function toRect(rect: SourceTransform | SourceCrop | null): SerializedClipRect | null {
  if (!rect) return null;
  return { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
}

function fromRect(rect: SerializedClipRect | null | undefined): SourceTransform | null {
  if (!rect || typeof rect !== "object") return null;
  const { x, y, w, h } = rect;
  if (![x, y, w, h].every((value) => typeof value === "number" && Number.isFinite(value))) return null;
  return { x, y, w, h };
}

function toSerializedSource(source: RecordingSource): SerializedClipSource {
  return {
    id: source.id,
    type: source.type,
    name: source.name,
    enabled: source.enabled,
    locked: source.locked,
    order: source.order,
    transform: toRect(source.transform),
    crop: toRect(source.crop),
    settings: { ...source.settings },
  };
}

function fromSerializedSource(raw: SerializedClipSource): RecordingSource {
  const type = raw.type as RecordingSourceType;
  return {
    id: raw.id,
    type,
    name: raw.name,
    enabled: raw.enabled,
    locked: raw.locked,
    order: raw.order,
    // Never persisted: derived from `type` so a capability change ships with the app, not with
    // whatever happened to be written into a user's settings months ago.
    capability: capabilityFor(type),
    transform: fromRect(raw.transform),
    crop: fromRect(raw.crop),
    settings: { ...(raw.settings ?? {}) },
  };
}

export function clipLibraryToSettings(library: RecordingSceneLibrary): ClipStudioSettings {
  const clean = sanitizeLibrary(library);
  return {
    version: CLIP_LIBRARY_VERSION,
    activeId: clean.activeId,
    scenes: clean.scenes.map((scene) => ({
      id: scene.id,
      name: scene.name,
      sources: scene.sources.map(toSerializedSource),
    })),
  };
}

export function clipLibraryFromSettings(settings: AppSettings): RecordingSceneLibrary {
  const studio = settings.clipStudio ?? DEFAULT_CLIP_STUDIO;
  const scenes: RecordingScene[] = (Array.isArray(studio.scenes) ? studio.scenes : []).map(
    (scene: SerializedClipScene) => ({
      id: scene.id,
      name: scene.name,
      // Clip scenes have no output mode; "legacy" is the inert value the shared types expect.
      outputMode: "legacy" as const,
      sources: (Array.isArray(scene.sources) ? scene.sources : []).map(fromSerializedSource),
    }),
  );
  return sanitizeLibrary({ version: LIBRARY_VERSION, activeId: studio.activeId, scenes });
}

/** Client-side mirror of `ClipStudioSettings::sanitize`, wired into the settings store. */
export function sanitizeClipStudio(raw: unknown): ClipStudioSettings {
  const value = raw && typeof raw === "object" ? (raw as Partial<ClipStudioSettings>) : {};
  if (!Array.isArray(value.scenes) || value.scenes.length === 0) {
    return { ...DEFAULT_CLIP_STUDIO, scenes: [] };
  }
  const scenes: RecordingScene[] = value.scenes.map((scene) => ({
    id: String(scene?.id ?? ""),
    name: String(scene?.name ?? CLIP_SCENE_NAME),
    outputMode: "legacy" as const,
    sources: (Array.isArray(scene?.sources) ? scene.sources : []).map(fromSerializedSource),
  }));
  return clipLibraryToSettings(
    sanitizeLibrary({ version: LIBRARY_VERSION, activeId: value.activeId, scenes }),
  );
}

/**
 * First-run clip scene, seeded from the settings the user already has so nobody loses their
 * webcam corner or their filter the first time they open the Clips tab.
 *
 * REC is forced off: a clip is a highlight, not a session recording, so a burned-in REC dot is
 * opt-in rather than inherited.
 */
export function seedClipLibrary(settings: AppSettings): RecordingSceneLibrary {
  const sources: RecordingSource[] = [
    createSource("game", {
      order: 1,
      enabled: true,
      locked: true,
      transform: { ...FULL_FRAME },
      crop: { ...FULL_CROP },
    }),
  ];

  if (settings.webcam.enabled) {
    sources.push(
      createSource("webcam", {
        order: nextOrder(sources),
        enabled: true,
        transform: placementToTransform(settings.webcam.defaultPlacement, settings.webcam.defaultWidth),
        settings: { shape: settings.webcam.defaultShape },
      }),
    );
  }

  const visuals = settings.recordingVisuals;
  if (visuals.filter !== "none" || visuals.overlays.timestamp) {
    sources.push(
      createSource("replayrOverlay", {
        order: nextOrder(sources),
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

  const scene: RecordingScene = {
    id: newSceneId(),
    name: CLIP_SCENE_NAME,
    outputMode: "legacy",
    sources,
  };
  return sanitizeLibrary({ version: LIBRARY_VERSION, activeId: scene.id, scenes: [scene] });
}
