import assert from "node:assert/strict";
import test from "node:test";
import { clampCaptureColumnWidth } from "./captureColumns";

test("a dragged capture column stays inside its limits", () => {
  assert.equal(clampCaptureColumnWidth("scenes", 40), 168);
  assert.equal(clampCaptureColumnWidth("scenes", 900), 480);
  assert.equal(clampCaptureColumnWidth("sources", 300.4), 300);
  assert.equal(clampCaptureColumnWidth("mixer", Number.NaN), 320);
  assert.equal(clampCaptureColumnWidth("controls", 10), 260);
  assert.equal(clampCaptureColumnWidth("controls", 900), 640);
});
