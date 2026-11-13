import assert from "node:assert/strict";
import test from "node:test";
import { SOURCE_REGISTRY, sourceListedInAddMenu } from "./registry";

const captureGroups = ["capture", "media", "overlay", "audio"] as const;

test("capture add source lists browser, capture card, video, and audio file", () => {
  const listed = SOURCE_REGISTRY.filter((entry) => sourceListedInAddMenu(entry, "recording", captureGroups)).map((entry) => entry.type);
  for (const type of ["browser", "captureCard", "videoFile", "audioFile"] as const) {
    assert.ok(listed.includes(type), type);
  }
});

test("clip add source keeps recording-only sources hidden", () => {
  const listed = SOURCE_REGISTRY.filter((entry) => sourceListedInAddMenu(entry, "clip")).map((entry) => entry.type);
  for (const type of ["browser", "captureCard", "videoFile", "audioFile"] as const) {
    assert.equal(listed.includes(type), false, type);
  }
  assert.ok(listed.includes("image"));
});
