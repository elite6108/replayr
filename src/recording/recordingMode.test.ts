import { DEFAULT_SETTINGS, type AppSettings } from "../types/settings";
import { seedClipScene } from "./clipScene";
import { buildRecordingComposition, composedStartBlocker, RECORD_NEEDS_IR_OFF } from "./composition";
import { displayPosition, displayTitle, type DisplayInfo } from "./display/displayTypes";
import { createSource, FULL_FRAME, type RecordingScene } from "./scene";
import { asRecordingLibrary } from "./sceneLibrary";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function settings(patch: Partial<AppSettings> = {}): AppSettings {
  return { ...DEFAULT_SETTINGS, instantReplayEnabled: false, ...patch };
}

function desktopScene(monitorId: string | null): RecordingScene {
  return {
    id: "scene-desktop",
    name: "Desktop",
    outputMode: "legacy",
    sources: [
      createSource("display", {
        order: 1,
        enabled: true,
        transform: { ...FULL_FRAME },
        settings: monitorId ? { monitorId } : {},
      }),
    ],
  };
}

export function assertRecordingLibraryIsComposed(): void {
  const library = asRecordingLibrary({ version: 2, activeId: "scene-desktop", scenes: [desktopScene(null)] });
  assert(library.scenes.every((scene) => scene.outputMode === "composed"), "Recordings scenes must load as composed");
}

export function assertClipSceneStaysLegacy(): void {
  assert(seedClipScene(settings()).outputMode === "legacy", "clip scenes keep their own output path");
}

export function assertMonitorReachesComposition(): void {
  const composition = buildRecordingComposition(desktopScene(String.raw`\\.\DISPLAY2`), settings());
  const capture = composition.sources.find((source) => source.kind === "capture");
  assert(capture && capture.kind === "capture", "desktop scene must send a capture source");
  assert(capture.monitorId === String.raw`\\.\DISPLAY2`, `picked display must reach Rust, got ${capture.monitorId}`);
  const primary = buildRecordingComposition(desktopScene(null), settings());
  const primaryCapture = primary.sources.find((source) => source.kind === "capture");
  assert(primaryCapture && primaryCapture.kind === "capture" && !primaryCapture.monitorId, "Primary sends no id");
}

export function assertInstantReplayBlocksRecording(): void {
  assert(
    composedStartBlocker(desktopScene(null), settings({ instantReplayEnabled: true })) === RECORD_NEEDS_IR_OFF,
    "Instant Replay must block recording with the turn-off message",
  );
  assert(composedStartBlocker(desktopScene(null), settings()) === null, "desktop scene should be recordable");
  const withWebp = desktopScene(null);
  withWebp.sources.push(
    createSource("image", { order: 2, enabled: true, settings: { path: "C:\\art\\logo.webp", opacity: 1 } }),
  );
  assert(composedStartBlocker(withWebp, settings())?.includes("PNG or JPEG"), "webp images must be rejected clearly");
}

export function assertDisplayLabels(): void {
  const left: DisplayInfo = { id: String.raw`\\.\DISPLAY2`, name: "Generic PnP Monitor", width: 1920, height: 1080, refreshRate: 60, isPrimary: false, x: -1920, y: 0 };
  const main: DisplayInfo = { id: String.raw`\\.\DISPLAY1`, name: "DELL U2720Q", width: 2560, height: 1440, refreshRate: 144, isPrimary: true, x: 0, y: 0 };
  assert(displayTitle(left) === "Display 2", `generic names fall back to the number, got ${displayTitle(left)}`);
  assert(displayTitle(main) === "Display 1 · DELL U2720Q", `named monitors keep their name, got ${displayTitle(main)}`);
  assert(displayPosition(left, [main, left]) === "Left of primary", "position helps tell monitors apart");
  assert(displayPosition(main, [main, left]) === null, "primary needs no position");
}

assertRecordingLibraryIsComposed();
assertClipSceneStaysLegacy();
assertMonitorReachesComposition();
assertInstantReplayBlocksRecording();
assertDisplayLabels();
console.log("recordingMode tests passed");
