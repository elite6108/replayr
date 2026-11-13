import assert from "node:assert/strict";
import test from "node:test";
import { buildObsImport, collectImagePaths, MAX_NESTING, type ObsEnvironment } from "./obsImport.ts";
import { parseObsCollection, parseObsCollectionText, OBS_LIMITS } from "./obsSchema.ts";
import { placeItem } from "./obsGeometry.ts";
import { obsColorToHex } from "./obsSources.ts";
import { matchCamera, matchMonitor } from "./obsDevices.ts";
import { appendScenes, MAX_SCENE_LIBRARY, type RecordingSceneLibrary } from "../sceneLibrary.ts";
import { emptyScene, type RecordingScene, type RecordingSource } from "../scene.ts";

const MONITOR_INTERFACE = "\\\\?\\DISPLAY#GSM5B09#5&2d1e4c5&0&UID4353#{e6f07b5f-ee97-4a90-b076-33f57bf4eaa7}";
const CAMERA_OBS_ID = "Logitech BRIO:\\\\?\\usb#vid_046d&pid_085e&mi_00#7&1a2b3c&0&0000#{65e8773d-8f56-11d0-a3b9-00a0c9223196}\\global";
const CAMERA_MF_ID = "\\\\?\\usb#vid_046d&pid_085e&mi_00#7&1a2b3c&0&0000#{e5323777-f976-4f5b-9b55-b94699c46e44}\\global";

function env(overrides: Partial<ObsEnvironment> = {}): ObsEnvironment {
  return {
    canvas: { w: 1920, h: 1080 },
    monitors: [
      { id: "\\\\.\\DISPLAY1", interfaceId: MONITOR_INTERFACE, width: 2560, height: 1440 },
      { id: "\\\\.\\DISPLAY2", interfaceId: "", width: 1920, height: 1080 },
    ],
    cameras: [{ id: CAMERA_MF_ID, name: "Logitech BRIO" }],
    audioDevices: [{ id: "{0.0.1.00000000}.{mic-guid}", name: "Shure MV7", direction: "capture", isDefault: false }],
    imageSizes: new Map([["C:\\Overlays\\frame.png", { w: 1920, h: 1080 }]]),
    ...overrides,
  };
}

type ItemInput = Record<string, unknown> & { name: string };

function item(name: string, extra: Record<string, unknown> = {}): ItemInput {
  return { name, visible: true, locked: false, pos: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, align: 5, bounds_type: 0, ...extra };
}

function scene(name: string, items: ItemInput[]) {
  return { id: "scene", name, settings: { items } };
}

function collection(sources: unknown[], extra: Record<string, unknown> = {}) {
  return { name: "Streaming", sources, ...extra };
}

function plan(raw: unknown, environment = env()) {
  const parsed = parseObsCollection(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  return buildObsImport(parsed.collection, environment);
}

function sourceOf(sceneValue: RecordingScene, type: RecordingSource["type"]): RecordingSource {
  const found = sceneValue.sources.find((source) => source.type === type);
  assert.ok(found, `expected a ${type} source`);
  return found;
}

function close(actual: number, expected: number, message?: string) {
  assert.ok(Math.abs(actual - expected) < 1e-4, `${message ?? "value"}: ${actual} != ${expected}`);
}

test("a typical streaming scene imports with exact placement", () => {
  const result = plan(
    collection(
      [
        scene("Main", [
          item("Display"),
          item("Cam", { pos: { x: 1880, y: 1040 }, scale: { x: 0.25, y: 0.25 }, align: 10 }),
          item("Logo", { pos: { x: 40, y: 40 }, scale: { x: 0.1, y: 0.1 } }),
        ]),
        { id: "monitor_capture", name: "Display", settings: { monitor_id: MONITOR_INTERFACE } },
        { id: "dshow_input", name: "Cam", settings: { video_device_id: CAMERA_OBS_ID, res_type: 1, resolution: "1920x1080" } },
        { id: "image_source", name: "Logo", settings: { file: "C:\\Overlays\\frame.png" } },
      ],
      {
        scene_order: [{ name: "Main" }],
        DesktopAudioDevice1: { id: "wasapi_output_capture", name: "Desktop Audio", settings: { device_id: "default" }, volume: 0.5 },
        AuxAudioDevice1: { id: "wasapi_input_capture", name: "Mic/Aux", settings: { device_id: "{0.0.1.00000000}.{mic-guid}" }, volume: 1.5 },
      },
    ),
  );

  assert.equal(result.collection, "Streaming");
  assert.equal(result.scenes.length, 1);
  const main = result.scenes[0]!;
  assert.equal(main.name, "Main");
  assert.equal(main.scene.outputMode, "composed");

  const display = sourceOf(main.scene, "display");
  assert.equal(display.settings.monitorId, "\\\\.\\DISPLAY1");
  close(display.transform!.x, 0);
  close(display.transform!.y, 0);
  // A 2560x1440 monitor at scale 1 on a 1920x1080 canvas is clipped to the canvas.
  close(display.transform!.w, 1);
  close(display.transform!.h, 1);
  close(display.crop!.w, 0.75);
  close(display.crop!.h, 0.75);

  const webcam = sourceOf(main.scene, "webcam");
  close(webcam.transform!.w, 0.25);
  close(webcam.transform!.h, 0.25);
  close(webcam.transform!.x, (1880 - 480) / 1920);
  close(webcam.transform!.y, (1040 - 270) / 1080);
  assert.equal(webcam.settings.shape, "rectangle");

  const logo = sourceOf(main.scene, "image");
  close(logo.transform!.x, 40 / 1920);
  close(logo.transform!.w, 0.1);
  assert.equal(logo.settings.path, "C:\\Overlays\\frame.png");

  assert.ok(main.scene.sources.some((source) => source.type === "microphone" && source.enabled));
  assert.ok(main.scene.sources.some((source) => source.type === "desktopAudio" && source.enabled));
  assert.ok(main.entries.every((entry) => entry.status === "imported"), JSON.stringify(main.entries));

  assert.deepEqual(result.devices.microphone, { id: "{0.0.1.00000000}.{mic-guid}", name: "Shure MV7", gain: 1.5 });
  assert.equal(result.devices.desktopGain, 0.5);
  assert.equal(result.devices.webcam?.id, CAMERA_MF_ID);
  assert.deepEqual(result.globalEntries.map((entry) => entry.status), ["imported", "imported"]);
});

test("visual order is bottom to top and hidden items stay hidden", () => {
  const result = plan(
    collection([
      scene("S", [item("Game"), item("Title", { visible: false })]),
      { id: "game_capture", name: "Game", settings: {} },
      { id: "text_gdiplus_v3", name: "Title", settings: { text: "Hello", color: 0x0000ff, font: { size: 72 } } },
    ]),
  );
  const imported = result.scenes[0]!.scene;
  const game = sourceOf(imported, "game");
  const text = sourceOf(imported, "text");
  assert.ok(text.order > game.order);
  assert.equal(text.enabled, false);
  assert.equal(text.settings.color, "#ff0000");
  assert.equal(text.settings.text, "Hello");
  assert.equal(text.settings.size, 72);
  assert.equal(game.locked, true);
});

test("bounds fit, alignment and crop follow OBS", () => {
  const placed = placeItem(
    {
      sourceName: "x",
      sourceUuid: null,
      visible: true,
      locked: false,
      rot: 0,
      pos: { x: 960, y: 540 },
      scale: { x: 1, y: 1 },
      align: 0,
      boundsType: 2,
      boundsAlign: 0,
      bounds: { x: 800, y: 800 },
      crop: { left: 0, top: 0, right: 960, bottom: 0 },
      cropToBounds: false,
    },
    { w: 1920, h: 1080 },
  );
  assert.ok(placed);
  // 960x1080 after crop, fitted inside 800x800 → 711.1x800, centred in the box around the centre.
  close(placed.placement.rect.w, 800 * (960 / 1080));
  close(placed.placement.rect.h, 800);
  close(placed.placement.rect.x, 960 - placed.placement.rect.w / 2);
  close(placed.placement.rect.y, 140);
  close(placed.placement.uv.w, 0.5);
});

test("a half turn lands where OBS draws it and other angles are reported", () => {
  const base = {
    sourceName: "x",
    sourceUuid: null,
    visible: true,
    locked: false,
    pos: { x: 100, y: 100 },
    scale: { x: 1, y: 1 },
    align: 5,
    boundsType: 0,
    boundsAlign: 0,
    bounds: { x: 0, y: 0 },
    crop: { left: 0, top: 0, right: 0, bottom: 0 },
    cropToBounds: false,
  };
  const half = placeItem({ ...base, rot: 180 }, { w: 200, h: 100 })!;
  close(half.placement.rect.x, -100);
  close(half.placement.rect.y, 0);
  assert.deepEqual(half.notes, []);
  const quarter = placeItem({ ...base, rot: 90 }, { w: 200, h: 100 })!;
  assert.deepEqual(quarter.notes, ["rotated"]);
});

test("content hanging off the canvas becomes crop", () => {
  const result = plan(
    collection([
      scene("S", [item("Cam", { pos: { x: -480, y: 0 }, scale: { x: 0.5, y: 0.5 } })]),
      { id: "dshow_input", name: "Cam", settings: { res_type: 1, resolution: "1920x1080" } },
    ]),
  );
  const webcam = sourceOf(result.scenes[0]!.scene, "webcam");
  close(webcam.transform!.x, 0);
  close(webcam.transform!.w, 0.25);
  close(webcam.crop!.x, 0.5);
  close(webcam.crop!.w, 0.5);
});

test("nested scenes and groups are flattened with their transforms", () => {
  const result = plan(
    collection([
      scene("Outer", [item("Inner", { pos: { x: 960, y: 0 }, scale: { x: 0.5, y: 0.5 } }), item("Grp", { pos: { x: 0, y: 540 } })]),
      scene("Inner", [item("Display")]),
      { id: "group", name: "Grp", settings: { cx: 400, cy: 200, items: [item("Logo", { pos: { x: 100, y: 50 }, scale: { x: 0.1, y: 0.1 } })] } },
      { id: "monitor_capture", name: "Display", settings: { monitor_id: MONITOR_INTERFACE } },
      { id: "image_source", name: "Logo", settings: { file: "C:\\Overlays\\frame.png" } },
    ]),
  );
  const outer = result.scenes.find((entry) => entry.name === "Outer")!.scene;
  const display = sourceOf(outer, "display");
  close(display.transform!.x, 0.5);
  close(display.transform!.y, 0);
  close(display.transform!.w, 0.5);
  close(display.transform!.h, 0.5);
  const logo = sourceOf(outer, "image");
  close(logo.transform!.x, 100 / 1920);
  close(logo.transform!.y, (540 + 50) / 1080);
  close(logo.transform!.w, 0.1);
});

test("a scene that contains itself or nests too deep cannot loop", () => {
  const chain = Array.from({ length: MAX_NESTING + 3 }, (_, index) =>
    scene(`L${index}`, index < MAX_NESTING + 2 ? [item(`L${index + 1}`)] : [item("Game")]),
  );
  const result = plan(
    collection([
      scene("Loop", [item("Loop"), item("Game")]),
      ...chain,
      { id: "game_capture", name: "Game", settings: {} },
    ]),
  );
  const loop = result.scenes.find((entry) => entry.name === "Loop")!;
  assert.ok(loop.entries.some((entry) => entry.status === "skipped" && entry.notes[0] === "It contains itself."));
  assert.ok(loop.scene.sources.some((source) => source.type === "game"));
  const deep = result.scenes.find((entry) => entry.name === "L0")!;
  assert.ok(deep.entries.some((entry) => entry.notes[0] === "It is nested too deeply."));
});

test("a scene keeps one game, extra displays, windows and webcams", () => {
  const result = plan(
    collection([
      scene("S", [item("Hidden Game", { visible: false }), item("Display"), item("Cam A"), item("Cam B"), item("Window"), item("Web")]),
      { id: "game_capture", name: "Hidden Game", settings: {} },
      { id: "monitor_capture", name: "Display", settings: {} },
      { id: "dshow_input", name: "Cam A", settings: {} },
      { id: "dshow_input", name: "Cam B", settings: {} },
      { id: "window_capture", name: "Window", settings: { window: "Notes:Notepad:notepad.exe" } },
      { id: "browser_source", name: "Web", settings: { url: "https://example.com" } },
    ]),
  );
  const planScene = result.scenes[0]!;
  const game = planScene.scene.sources.find((source) => source.type === "game");
  const display = planScene.scene.sources.find((source) => source.type === "display");
  assert.equal(game?.enabled, false);
  assert.equal(display?.enabled, true);
  assert.equal(planScene.scene.sources.filter((source) => source.type === "webcam").length, 2);
  const window = planScene.scene.sources.find((source) => source.type === "window");
  assert.equal((window?.settings.window as { exe?: string } | undefined)?.exe, "notepad.exe");
  const web = planScene.scene.sources.find((source) => source.type === "browser");
  assert.equal(web?.settings.url, "https://example.com/");
  const skipped = planScene.entries.filter((entry) => entry.status === "skipped").map((entry) => entry.name);
  assert.deepEqual(skipped, []);
});

test("a local video, audio file, and https page can be imported", () => {
  const result = plan(
    collection([
      scene("S", [item("Clip"), item("Bed"), item("Page"), item("Script"), item("Share")]),
      { id: "ffmpeg_source", name: "Clip", settings: { local_file: "C:\\clips\\intro.mp4", looping: true, restart_on_activate: true } },
      { id: "ffmpeg_source", name: "Bed", settings: { local_file: "D:\\music\\bed.mp3", looping: false } },
      { id: "browser_source", name: "Page", settings: { url: "https://Example.com/watch" } },
      { id: "browser_source", name: "Script", settings: { url: "javascript:alert(1)" } },
      { id: "ffmpeg_source", name: "Share", settings: { local_file: "\\\\server\\share\\intro.mp4" } },
    ]),
  );
  const sources = result.scenes[0]!.scene.sources;
  assert.equal(sources.find((source) => source.name === "Clip")?.type, "videoFile");
  assert.equal(sources.find((source) => source.name === "Clip")?.settings.loop, true);
  assert.equal(sources.find((source) => source.name === "Bed")?.type, "audioFile");
  assert.equal(sources.find((source) => source.name === "Page")?.settings.url, "https://example.com/watch");
  const skipped = result.scenes[0]!.entries.filter((entry) => entry.status === "skipped").map((entry) => entry.name);
  assert.deepEqual(skipped.sort(), ["Script", "Share"]);
});

test("images must be local PNG, JPEG, GIF, or WebP files that exist", () => {
  const raw = collection([
    scene("S", [item("Ok"), item("Gif"), item("Missing"), item("Share")]),
    { id: "image_source", name: "Ok", settings: { file: "C:\\Overlays\\frame.png" } },
    { id: "image_source", name: "Gif", settings: { file: "C:\\Overlays\\anim.gif" } },
    { id: "image_source", name: "Missing", settings: { file: "C:\\Overlays\\gone.png" } },
    { id: "image_source", name: "Share", settings: { file: "\\\\server\\share\\logo.png" } },
  ]);
  const parsed = parseObsCollection(raw);
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  assert.deepEqual(collectImagePaths(parsed.collection).sort(), ["C:\\Overlays\\anim.gif", "C:\\Overlays\\frame.png", "C:\\Overlays\\gone.png"]);
  const result = buildObsImport(parsed.collection, env());
  const entries = result.scenes[0]!.entries;
  assert.equal(entries.find((entry) => entry.name === "Ok")?.status, "imported");
  for (const name of ["Gif", "Missing", "Share"]) {
    assert.equal(entries.find((entry) => entry.name === name)?.status, "skipped", name);
  }
  assert.equal(result.scenes[0]!.scene.sources.filter((source) => source.type === "image").length, 1);
});

test("hostile input is clamped, cleaned and capped", () => {
  assert.equal(parseObsCollectionText("not json").ok, false);
  assert.equal(parseObsCollection([]).ok, false);
  assert.equal(parseObsCollection({ sources: {} }).ok, false);
  const tooMany = { sources: Array.from({ length: OBS_LIMITS.sources + 1 }, (_, index) => ({ id: "color_source", name: `c${index}` })) };
  assert.equal(parseObsCollection(tooMany).ok, false);

  const hostile = JSON.parse(
    JSON.stringify({
      name: "x".repeat(500),
      sources: [
        {
          id: "scene",
          name: "Evil\u0007Scene" + "!".repeat(300),
          settings: {
            items: [
              { name: "Cam", pos: { x: 1e308, y: "NaN" }, scale: { x: -1e9, y: null }, align: 999, bounds_type: -5, crop_left: -50 },
              ...Array.from({ length: OBS_LIMITS.itemsPerScene + 50 }, () => ({ name: "Cam" })),
            ],
          },
        },
        { id: "dshow_input", name: "Cam", settings: { __proto__: { polluted: true }, res_type: 1, resolution: "99999x1" } },
        { id: 42, name: "bad" },
        null,
        "string",
      ],
    }),
  );
  const parsed = parseObsCollection(hostile);
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  assert.equal(parsed.collection.name.length, 64);
  const sceneSource = parsed.collection.sources.find((source) => source.kind === "scene")!;
  assert.equal(sceneSource.items.length, OBS_LIMITS.itemsPerScene);
  assert.ok(!sceneSource.name.includes("\u0007"));
  const first = sceneSource.items[0]!;
  assert.ok(Number.isFinite(first.pos.x) && Number.isFinite(first.pos.y));
  assert.ok(first.align >= 0 && first.align <= 15);
  assert.ok(first.boundsType >= 0 && first.boundsType <= 6);
  assert.equal(first.crop.left, 0);

  const result = buildObsImport(parsed.collection, env());
  const imported = result.scenes[0]!.scene;
  assert.ok(imported.name.length <= 64);
  for (const source of imported.sources) {
    if (!source.transform) continue;
    for (const value of Object.values(source.transform)) assert.ok(Number.isFinite(value) && value >= 0 && value <= 1);
  }
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("text colours decode from OBS byte order", () => {
  assert.equal(obsColorToHex(0xffffff), "#ffffff");
  assert.equal(obsColorToHex(0xff0000ff), "#ff0000");
  assert.equal(obsColorToHex(0x00ff00), "#00ff00");
  assert.equal(obsColorToHex(-5), "#000000");
});

test("devices match by interface id, instance path or name", () => {
  const monitors = env().monitors;
  assert.equal(matchMonitor({ monitor_id: MONITOR_INTERFACE.toLowerCase() }, monitors)?.monitor.id, "\\\\.\\DISPLAY1");
  assert.equal(matchMonitor({ monitor: 1 }, monitors)?.exact, false);
  assert.equal(matchMonitor({ monitor_id: "nope" }, monitors), null);
  assert.equal(matchCamera({ video_device_id: CAMERA_OBS_ID }, env().cameras)?.id, CAMERA_MF_ID);
  assert.equal(matchCamera({ video_device_id: "Logitech BRIO:" }, env().cameras)?.id, CAMERA_MF_ID);
  assert.equal(matchCamera({ video_device_id: "Other Cam:\\\\?\\usb#x#{g}" }, env().cameras), null);
});

test("missing devices are reported and keep the current choice", () => {
  const result = plan(
    collection([
      scene("S", [item("Mic"), item("Cam")]),
      { id: "wasapi_input_capture", name: "Mic", settings: { device_id: "{gone}" } },
      { id: "dshow_input", name: "Cam", settings: { video_device_id: "Old Cam:\\\\?\\usb#vid_1#{x}\\global" } },
    ]),
  );
  assert.equal(result.devices.microphone, null);
  assert.equal(result.devices.webcam, null);
  assert.equal(result.devices.notes.length, 2);
});

function library(names: string[]): RecordingSceneLibrary {
  const scenes = names.map((name) => emptyScene(name));
  return { version: 2, activeId: scenes[0]!.id, scenes };
}

test("imported scenes are appended with fresh ids and unique names", () => {
  const existing = library(["Main", "Main (OBS)"]);
  const incoming = [emptyScene("Main"), emptyScene("Other")];
  const before = JSON.stringify(existing);
  const result = appendScenes(existing, incoming);
  assert.equal(JSON.stringify(existing), before);
  assert.equal(result.added, 2);
  assert.equal(result.dropped, 0);
  const names = result.library.scenes.map((sceneValue) => sceneValue.name);
  assert.deepEqual(names, ["Main", "Main (OBS)", "Main (OBS 2)", "Other"]);
  assert.equal(result.library.activeId, result.library.scenes[2]!.id);
  assert.notEqual(result.library.scenes[2]!.id, incoming[0]!.id);
});

test("imports stop at the scene limit", () => {
  const existing = library(Array.from({ length: MAX_SCENE_LIBRARY - 1 }, (_, index) => `S${index}`));
  const result = appendScenes(existing, [emptyScene("A"), emptyScene("B")]);
  assert.equal(result.added, 1);
  assert.equal(result.dropped, 1);
  assert.equal(result.library.scenes.length, MAX_SCENE_LIBRARY);
  const full = appendScenes(result.library, [emptyScene("C")]);
  assert.equal(full.added, 0);
  assert.equal(full.library, result.library);
});

test("long names keep the OBS suffix", () => {
  const long = "N".repeat(64);
  const result = appendScenes(library([long]), [emptyScene(long)]);
  const added = result.library.scenes[1]!.name;
  assert.ok(added.endsWith("(OBS)"), added);
  assert.ok(added.length <= 64);
});
