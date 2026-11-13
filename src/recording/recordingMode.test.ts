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
  const layered = desktopScene(null);
  layered.sources.push(
    createSource("display", { order: 2, enabled: true, transform: { x: 0.62, y: 0.08, w: 0.34, h: 0.34 }, settings: { monitorId: String.raw`\\.\DISPLAY2` } }),
    createSource("window", { order: 3, enabled: true, transform: { x: 0.62, y: 0.16, w: 0.34, h: 0.34 }, settings: { window: { title: "Notes", className: "Notepad", exe: "notepad.exe" } } }),
    createSource("webcam", { order: 4, enabled: true }),
    createSource("webcam", { order: 5, enabled: true, settings: { camera: { deviceId: "cam-b", modeId: "640x480@30" } } }),
  );
  const built = buildRecordingComposition(layered, settings({ webcam: { ...settings().webcam, deviceId: "cam-a" } }));
  const captures = built.sources.filter((source) => source.kind === "capture");
  assert(captures.length === 3, "the base display stays first and the extra display and window follow");
  assert(captures[0]?.kind === "capture" && captures[0].capture === "display" && !captures[0].monitorId, "base stays the first display");
  assert(captures[2]?.kind === "capture" && captures[2].capture === "window" && captures[2].window?.exe === "notepad.exe", "window identity is sent");
  const cameras = built.sources.filter((source) => source.kind === "webcam");
  assert(cameras.length === 2 && cameras[0]?.kind === "webcam" && cameras[0].deviceId === "cam-a", "first webcam keeps the shared camera");
  assert(cameras[1]?.kind === "webcam" && cameras[1].deviceId === "cam-b", "second webcam keeps its own camera");
  const emptyWindow = desktopScene(null);
  emptyWindow.sources[0] = createSource("window", { order: 1, enabled: true, transform: { ...FULL_FRAME } });
  assert(composedStartBlocker(emptyWindow, settings()) === "Choose a window to record.", "a window needs a target");
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
  assert(composedStartBlocker(withWebp, settings()) === null, "webp images can be recorded");
  const withBmp = desktopScene(null);
  withBmp.sources.push(createSource("image", { order: 2, enabled: true, settings: { path: "C:\\art\\logo.bmp", opacity: 1 } }));
  assert(composedStartBlocker(withBmp, settings())?.includes("WebP"), "other image types stay blocked");
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
