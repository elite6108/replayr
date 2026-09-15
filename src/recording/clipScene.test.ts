import { DEFAULT_RECORDING_VISUALS, DEFAULT_WEBCAM_SETTINGS, type AppSettings } from "../types/settings";
import { clipSceneNeedsCompose, isForbiddenClipSettingKey, seedClipLibrary, seedClipScene } from "./clipScene";
import { createSource, FULL_FRAME, type RecordingScene } from "./scene";

function settingsStub(): AppSettings {
  return {
    webcam: { ...DEFAULT_WEBCAM_SETTINGS, enabled: true, defaultPlacement: "top-left", defaultWidth: 0.2 },
    recordingVisuals: { filter: "vhs", overlays: { recIndicator: true, timestamp: true } },
    micEnabled: true,
    gameAudioEnabled: true,
    systemAudioEnabled: false,
  } as AppSettings;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function assertClipSeedKeepsRecOff(): void {
  const scene = seedClipScene(settingsStub());
  const overlay = scene.sources.find((source) => source.type === "replayrOverlay");
  assert(overlay, "seed should copy an existing visual filter");
  assert(overlay.settings.recIndicator === false, "clip seed must not copy the REC indicator");
  assert(overlay.settings.timestamp === true, "timestamp may carry over");
  assert(scene.outputMode === "legacy", "clip scenes are never composed-session mode");
}

export function assertIdentitySceneSkipsCompose(): void {
  const scene: RecordingScene = {
    id: "scene-testidentity",
    name: "Identity",
    outputMode: "legacy",
    sources: [
      createSource("game", { order: 1, enabled: true, locked: true, transform: { ...FULL_FRAME } }),
      createSource("webcam", { order: 2, enabled: true, webcam: DEFAULT_WEBCAM_SETTINGS }),
    ],
  };
  assert(!clipSceneNeedsCompose(scene), "full-frame gameplay plus webcam sidecar must not re-encode");
}

export function assertTextTriggersCompose(): void {
  const scene: RecordingScene = {
    id: "scene-testtext",
    name: "Text",
    outputMode: "legacy",
    sources: [
      createSource("game", { order: 1, enabled: true, transform: { ...FULL_FRAME } }),
      createSource("text", { order: 2, enabled: true, settings: { text: "CLIP", color: "#fff", size: 24, align: "left" } }),
    ],
  };
  assert(clipSceneNeedsCompose(scene), "an enabled text box must burn on save");
}

export function assertForbiddenKeysStayIsolated(): void {
  for (const key of ["micEnabled", "gameAudioEnabled", "systemAudioEnabled", "recordingVisuals", "instantReplayEnabled"]) {
    assert(isForbiddenClipSettingKey(key), `${key} must stay off the clip persist path`);
  }
  assert(!isForbiddenClipSettingKey("webcam"), "shared camera device writes are allowed");
}

export function assertSeededLibrarySanitizes(): void {
  const library = seedClipLibrary(settingsStub());
  assert(library.scenes.length === 1, "fresh clip library has one layout");
  assert(library.activeId === library.scenes[0]?.id, "active scene must match");
}

assertClipSeedKeepsRecOff();
assertIdentitySceneSkipsCompose();
assertTextTriggersCompose();
assertForbiddenKeysStayIsolated();
assertSeededLibrarySanitizes();
