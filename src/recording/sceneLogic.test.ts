import {
  reorderSourceAmong,
  sourcesFrontFirst,
  type RecordingScene,
  type RecordingSource,
} from "./scene";
import { createScene, deleteScene, renameScene, sanitizeLibrary } from "./sceneLibrary";
import { DEFAULT_WEBCAM_SETTINGS, DEFAULT_RECORDING_VISUALS } from "../types/settings";
import type { AppSettings } from "../types/settings";

function source(id: string, order: number): RecordingSource {
  return {
    id,
    type: "image",
    name: id,
    enabled: true,
    locked: false,
    order,
    capability: "preview_only",
    transform: { x: 0, y: 0, w: 1, h: 1 },
    settings: {},
  };
}

function sceneOf(sources: RecordingSource[]): RecordingScene {
  return { id: "scene-test", name: "Test", outputMode: "legacy", sources };
}

export function assertReorderKeepsFrontHighest(): void {
  const start = sceneOf([source("back", 1), source("mid", 2), source("front", 3)]);
  const moved = reorderSourceAmong(start, "back", "front", (item) => item.type === "image");
  const list = sourcesFrontFirst(moved.sources);
  if (list[0]?.id !== "back") throw new Error("dragged source should sit at the front of the list");
  const back = moved.sources.find((item) => item.id === "back");
  const front = moved.sources.find((item) => item.id === "front");
  if ((back?.order ?? 0) <= (front?.order ?? 0)) {
    throw new Error("front-of-list source must keep the highest order");
  }
}

export function assertLibrarySanitizeAndDelete(): void {
  const settings = {
    webcam: DEFAULT_WEBCAM_SETTINGS,
    recordingVisuals: DEFAULT_RECORDING_VISUALS,
    micEnabled: false,
    gameAudioEnabled: false,
    systemAudioEnabled: false,
  } as AppSettings;
  const seeded = sanitizeLibrary({
    version: 2,
    activeId: "bad id",
    scenes: [{ id: "scene-abc", name: "Gameplay\u0000", outputMode: "legacy", sources: [] }],
  });
  if (seeded.scenes[0]?.name.includes("\u0000")) throw new Error("scene names must strip controls");
  if (seeded.activeId !== "scene-abc") throw new Error("valid scene id should remain active");
  const created = createScene(seeded, settings, { name: "  Extra  ", template: null });
  if ("error" in created) throw new Error(created.error);
  if (created.scenes.length !== 2) throw new Error("create should append a scene");
  const renamed = renameScene(created, created.activeId, "My Layout");
  if (renamed.scenes.find((scene) => scene.id === renamed.activeId)?.name !== "My Layout") {
    throw new Error("rename should change only the display name");
  }
  const removed = deleteScene(renamed, renamed.activeId);
  if ("error" in removed) throw new Error(removed.error);
  if (removed.scenes.length !== 1) throw new Error("delete should leave the other scene");
  const last = deleteScene(removed, removed.activeId);
  if (!("error" in last)) throw new Error("deleting the last scene must fail");
}

assertReorderKeepsFrontHighest();
assertLibrarySanitizeAndDelete();
