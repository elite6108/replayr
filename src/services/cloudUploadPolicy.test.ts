import assert from "node:assert/strict";
import test from "node:test";
import { shouldAutoUpload } from "./cloudUploadPolicy.ts";
import { isUnsentCloudOnly, shouldReleaseLocalCopy } from "./cloudRelease.ts";
import type { LocalClip } from "../types/clip.ts";
import type { AppSettings } from "../types/settings.ts";

function clip(overrides: Partial<LocalClip> = {}): LocalClip {
  return {
    localId: "clip-1",
    cloudClipId: null,
    filePath: "C:/clips/clip-1.mp4",
    thumbnailPath: null,
    gameId: null,
    createdAt: "2026-11-02T00:00:00Z",
    durationMs: 1000,
    width: 1920,
    height: 1080,
    fps: 60,
    fileSize: 10,
    uploadStatus: "local",
    favorite: false,
    title: "Clip",
    description: null,
    tags: [],
    captureKind: "clip",
    sourceClipId: null,
    sourceStartMs: null,
    sourceEndMs: null,
    releaseLocal: false,
    ...overrides,
  };
}

function settings(autoUpload: AppSettings["autoUpload"]): AppSettings {
  return { autoUpload } as AppSettings;
}

test("a signed-out cloud-only clip stays on this PC", () => {
  assert.equal(shouldAutoUpload(clip({ releaseLocal: true }), settings("all"), false), false);
});

test("a signed-in cloud-only clip uploads even when automatic upload is off", () => {
  assert.equal(shouldAutoUpload(clip({ releaseLocal: true }), settings("off"), true), true);
  assert.equal(shouldAutoUpload(clip({ releaseLocal: true, favorite: false }), settings("favorites"), true), true);
});

test("keep-local clips still follow the upload rules", () => {
  assert.equal(shouldAutoUpload(clip(), settings("off"), true), false);
  assert.equal(shouldAutoUpload(clip({ favorite: false }), settings("favorites"), true), false);
  assert.equal(shouldAutoUpload(clip({ favorite: true }), settings("favorites"), true), true);
});

test("a finished upload is not started again", () => {
  assert.equal(
    shouldAutoUpload(clip({ releaseLocal: true, uploadStatus: "completed", cloudClipId: "cloud-1" }), settings("all"), true),
    false,
  );
});

test("the local copy is removed only after that clip's cloud copy is ready", () => {
  assert.equal(shouldReleaseLocalCopy(clip({ releaseLocal: true, uploadStatus: "completed" })), false);
  assert.equal(
    shouldReleaseLocalCopy(clip({ releaseLocal: true, uploadStatus: "failed", cloudClipId: "cloud-1" })),
    false,
  );
  assert.equal(shouldReleaseLocalCopy(clip({ releaseLocal: false, uploadStatus: "completed", cloudClipId: "cloud-1" })), false);
  assert.equal(shouldReleaseLocalCopy(clip({ releaseLocal: true, uploadStatus: "completed", cloudClipId: "cloud-1" })), true);
});

test("only a cloud-only clip that has not started uploading is picked up later", () => {
  assert.equal(isUnsentCloudOnly(clip({ releaseLocal: true })), true);
  assert.equal(isUnsentCloudOnly(clip({ releaseLocal: true, uploadStatus: "failed" })), false);
  assert.equal(isUnsentCloudOnly(clip()), false);
});
