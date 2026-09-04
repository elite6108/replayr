import type { AppSettings } from "../types/settings";
import {
  emptyScene,
  loadStoredScene,
  newSceneId,
  newSourceId,
  persistScene,
  presetSceneName,
  sanitizeScene,
  sanitizeSceneId,
  sanitizeSceneName,
  sceneFromPreset,
  sceneFromSettings,
  type RecordingScene,
  type ScenePresetId,
} from "./scene";

export const RECORDING_SCENE_LIBRARY_KEY = "replay.recordingSceneLibrary";
export const MAX_SCENE_LIBRARY = 32;
export const LIBRARY_VERSION = 2;

const FACTORY_PRESETS: ScenePresetId[] = ["gameplay", "gameplayWebcam", "desktop", "blank"];

export type RecordingSceneLibrary = {
  version: typeof LIBRARY_VERSION;
  activeId: string;
  scenes: RecordingScene[];
};

export function activeSceneOf(library: RecordingSceneLibrary): RecordingScene {
  return library.scenes.find((scene) => scene.id === library.activeId) ?? library.scenes[0] ?? emptyScene();
}

export function replaceActive(library: RecordingSceneLibrary, scene: RecordingScene): RecordingSceneLibrary {
  const sanitized = sanitizeScene(scene) ?? emptyScene(scene.name);
  const hasActive = library.scenes.some((item) => item.id === library.activeId);
  if (!hasActive) {
    return sanitizeLibrary({
      version: LIBRARY_VERSION,
      activeId: sanitized.id,
      scenes: [...library.scenes, sanitized],
    });
  }
  return sanitizeLibrary({
    ...library,
    scenes: library.scenes.map((item) => (item.id === library.activeId ? { ...sanitized, id: item.id } : item)),
  });
}

export function persistLibrary(library: RecordingSceneLibrary): void {
  const clean = sanitizeLibrary(library);
  try {
    localStorage.setItem(RECORDING_SCENE_LIBRARY_KEY, JSON.stringify(clean));
  } catch {
    /* private mode */
  }
  persistScene(activeSceneOf(clean));
}

export function loadOrMigrateLibrary(settings: AppSettings): RecordingSceneLibrary {
  const stored = loadStoredLibrary();
  if (stored) return stored;
  const migrated = loadStoredScene();
  if (migrated) {
    const seeded = seedMissingFactories(
      { version: LIBRARY_VERSION, activeId: migrated.id, scenes: [migrated] },
      settings,
    );
    persistLibrary(seeded);
    return seeded;
  }
  const created = seedMissingFactories(
    { version: LIBRARY_VERSION, activeId: "", scenes: [] },
    settings,
  );
  persistLibrary(created);
  return created;
}

export function loadActiveScene(settings: AppSettings): RecordingScene {
  return activeSceneOf(loadOrMigrateLibrary(settings));
}

export function nextSceneName(library: RecordingSceneLibrary): string {
  const used = new Set(library.scenes.map((scene) => scene.name.toLowerCase()));
  if (!used.has("scene")) return "Scene";
  for (let index = 2; index < MAX_SCENE_LIBRARY + 8; index += 1) {
    const name = `Scene ${index}`;
    if (!used.has(name.toLowerCase())) return name;
  }
  return "Scene";
}

export function createScene(
  library: RecordingSceneLibrary,
  settings: AppSettings,
  options: { name?: string; template?: ScenePresetId | null },
): RecordingSceneLibrary | { error: string } {
  if (library.scenes.length >= MAX_SCENE_LIBRARY) {
    return { error: `You can keep up to ${MAX_SCENE_LIBRARY} scenes.` };
  }
  const name = sanitizeSceneName(options.name, nextSceneName(library));
  const created = options.template
    ? sceneFromPreset(options.template, settings)
    : emptyScene(name);
  created.name = options.template ? name : created.name;
  created.outputMode = activeSceneOf(library).outputMode;
  return sanitizeLibrary({
    version: LIBRARY_VERSION,
    activeId: created.id,
    scenes: [...library.scenes, created],
  });
}

export function renameScene(library: RecordingSceneLibrary, id: string, name: string): RecordingSceneLibrary {
  const nextName = sanitizeSceneName(name);
  return sanitizeLibrary({
    ...library,
    scenes: library.scenes.map((scene) => (scene.id === id ? { ...scene, name: nextName } : scene)),
  });
}

export function deleteScene(library: RecordingSceneLibrary, id: string): RecordingSceneLibrary | { error: string } {
  if (library.scenes.length <= 1) {
    return { error: "Keep at least one scene." };
  }
  const scenes = library.scenes.filter((scene) => scene.id !== id);
  if (scenes.length === library.scenes.length) return library;
  const activeId = library.activeId === id ? (scenes[0]?.id ?? "") : library.activeId;
  return sanitizeLibrary({ version: LIBRARY_VERSION, activeId, scenes });
}

export function duplicateScene(library: RecordingSceneLibrary, id: string): RecordingSceneLibrary | { error: string } {
  if (library.scenes.length >= MAX_SCENE_LIBRARY) {
    return { error: `You can keep up to ${MAX_SCENE_LIBRARY} scenes.` };
  }
  const source = library.scenes.find((scene) => scene.id === id);
  if (!source) return library;
  const copy: RecordingScene = {
    ...source,
    id: newSceneId(),
    name: uniqueCopyName(library, source.name),
    sources: source.sources.map((item) => ({
      ...item,
      id: newSourceId(item.type),
      settings: { ...item.settings },
      transform: item.transform ? { ...item.transform } : null,
    })),
  };
  return sanitizeLibrary({
    version: LIBRARY_VERSION,
    activeId: copy.id,
    scenes: [...library.scenes, copy],
  });
}

export function switchScene(library: RecordingSceneLibrary, id: string): RecordingSceneLibrary {
  if (!library.scenes.some((scene) => scene.id === id)) return library;
  return { ...library, activeId: id };
}

export function sanitizeLibrary(raw: unknown): RecordingSceneLibrary {
  const value = raw && typeof raw === "object" ? (raw as Partial<RecordingSceneLibrary>) : {};
  const scenes = (Array.isArray(value.scenes) ? value.scenes : [])
    .map((scene) => sanitizeScene(scene))
    .filter((scene): scene is RecordingScene => Boolean(scene))
    .slice(0, MAX_SCENE_LIBRARY);
  const unique: RecordingScene[] = [];
  const seen = new Set<string>();
  for (const scene of scenes) {
    const id = sanitizeSceneId(scene.id) ?? newSceneId();
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push({ ...scene, id, name: sanitizeSceneName(scene.name) });
  }
  if (!unique.length) {
    const fallback = emptyScene();
    return { version: LIBRARY_VERSION, activeId: fallback.id, scenes: [fallback] };
  }
  const activeId = unique.some((scene) => scene.id === value.activeId) ? (value.activeId as string) : unique[0]!.id;
  return { version: LIBRARY_VERSION, activeId, scenes: unique };
}

function loadStoredLibrary(): RecordingSceneLibrary | null {
  try {
    const raw = localStorage.getItem(RECORDING_SCENE_LIBRARY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    const clean = sanitizeLibrary(parsed);
    return clean.scenes.length ? clean : null;
  } catch {
    return null;
  }
}

function seedMissingFactories(library: RecordingSceneLibrary, settings: AppSettings): RecordingSceneLibrary {
  const names = new Set(library.scenes.map((scene) => scene.name.toLowerCase()));
  const scenes = [...library.scenes];
  for (const preset of FACTORY_PRESETS) {
    if (scenes.length >= MAX_SCENE_LIBRARY) break;
    const name = presetSceneName(preset);
    if (names.has(name.toLowerCase())) continue;
    const created = sceneFromPreset(preset, settings);
    created.name = name;
    scenes.push(created);
    names.add(name.toLowerCase());
  }
  if (!scenes.length) {
    const created = sceneFromSettings(settings);
    scenes.push(created);
  }
  const activeId = scenes.some((scene) => scene.id === library.activeId) ? library.activeId : scenes[0]!.id;
  return sanitizeLibrary({ version: LIBRARY_VERSION, activeId, scenes });
}

function uniqueCopyName(library: RecordingSceneLibrary, name: string): string {
  const base = sanitizeSceneName(`Copy of ${name}`);
  const used = new Set(library.scenes.map((scene) => scene.name.toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let index = 2; index < 100; index += 1) {
    const next = sanitizeSceneName(`${base} ${index}`);
    if (!used.has(next.toLowerCase())) return next;
  }
  return sanitizeSceneName(`${base} ${Date.now().toString(36)}`);
}
