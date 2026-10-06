import assert from "node:assert/strict";
import {
  canvasFromAspect,
  containOnCanvas,
  croppedSourceAspect,
  fitInsidePreservingAspect,
  gestureFinish,
  previewCanvasSize,
  samePreviewStatus,
} from "./previewCanvas.ts";

const ultrawide = fitInsidePreservingAspect(3440, 1440, 1920, 1080);
assert.ok(ultrawide.width <= 1920 && ultrawide.height <= 1080);
assert.ok(Math.abs(ultrawide.width / ultrawide.height - 3440 / 1440) < 0.02);

const portrait = canvasFromAspect(9 / 16, "1080p");
assert.equal(portrait.provisional, true);
assert.ok(portrait.width < portrait.height);
assert.ok(Math.abs(portrait.width / portrait.height - 9 / 16) < 0.02);

const negotiated = previewCanvasSize({
  outputWidth: 2560,
  outputHeight: 1080,
  sourceWidth: 1280,
  sourceHeight: 540,
  resolution: "1080p",
});
assert.deepEqual(
  { width: negotiated.width, height: negotiated.height, provisional: negotiated.provisional },
  { width: 2560, height: 1080, provisional: false },
);

const unknown = previewCanvasSize({ resolution: "720p" });
assert.equal(unknown.provisional, true);
assert.deepEqual({ width: unknown.width, height: unknown.height }, { width: 1280, height: 720 });

assert.equal(samePreviewStatus(
  { live: true, label: "Game", source: "game", width: 1920, height: 1080 },
  { live: true, label: "Game", source: "game", width: 1920, height: 1080 },
), true);
assert.equal(samePreviewStatus(
  { live: true, label: "Game", source: "game", width: 1920, height: 1080 },
  { live: true, label: "Game", source: "composed", width: 1920, height: 1080 },
), false);

const fitted = containOnCanvas(croppedSourceAspect(16 / 9, 0.5, 1), 16 / 9);
assert.ok(fitted.w < 1 && fitted.h === 1);

assert.equal(gestureFinish("up", "scene-a", "scene-a"), "commit");
assert.equal(gestureFinish("unmount", "scene-a", "scene-a"), "commit");
assert.equal(gestureFinish("cancel", "scene-a", "scene-a"), "cancel");
assert.equal(gestureFinish("up", "scene-a", "scene-b"), "ignore");
assert.equal(gestureFinish("cancel", "scene-a", "scene-b"), "ignore");

console.log("previewCanvas tests passed");
