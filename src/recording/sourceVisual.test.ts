import assert from "node:assert/strict";
import test from "node:test";
import { createSource } from "./scene.ts";
import { cameraForWebcam, parseModeId, parseObsWindow, sanitizeCamera, sanitizeWindowTarget } from "./sourceVisual.ts";

test("obs window strings decode colons and keep the executable name only", () => {
  const parsed = parseObsWindow("Notes#3A draft:Notepad:notepad.exe");
  assert.equal(parsed.title, "Notes: draft");
  assert.equal(parsed.className, "Notepad");
  assert.equal(parsed.exe, "notepad.exe");
  const withPath = parseObsWindow("Game:UnityWndClass:C#3A\\Games\\game.exe");
  assert.equal(withPath.exe, "game.exe");
  const hostile = sanitizeWindowTarget({ title: "ok\u0000", className: "x", exe: "..\\..\\cmd.exe" });
  assert.equal(hostile.title, "ok");
  assert.equal(hostile.exe, "cmd.exe");
});

test("a camera mode id round-trips and a hostile device id is dropped", () => {
  assert.deepEqual(parseModeId("1280x720@30"), { width: 1280, height: 720, fps: 30 });
  assert.equal(parseModeId("nope"), null);
  assert.equal(sanitizeCamera({ deviceId: "../cam", modeId: "1280x720@30" }), null);
  assert.deepEqual(sanitizeCamera({ deviceId: "cam-a", modeId: "640x480@30" }), { deviceId: "cam-a", modeId: "640x480@30" });
});

test("only the first webcam inherits the global camera", () => {
  const first = createSource("webcam", { order: 1 });
  const extra = createSource("webcam", { order: 2, settings: { camera: { deviceId: "cam-b", modeId: "640x480@30" } } });
  const bare = createSource("webcam", { order: 3 });
  const sources = [first, extra, bare];
  const globals = { deviceId: "cam-a", width: 1280, height: 720, fps: 30 };
  assert.equal(cameraForWebcam(first, sources, globals).deviceId, "cam-a");
  assert.equal(cameraForWebcam(extra, sources, globals).deviceId, "cam-b");
  assert.equal(cameraForWebcam(extra, sources, globals).width, 640);
  assert.equal(cameraForWebcam(bare, sources, globals).deviceId, "");
});
