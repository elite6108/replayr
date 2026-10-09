import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyTrim,
  buildExportRequest,
  createEditProject,
  outputFrame,
  parseEditProject,
  projectRange,
} from "./editProject.ts";

const clip = { id: "clip-1", slug: "gta", durationMs: 180_000, width: 1920, height: 1080 };

test("9:16 center crop of 1080p is 1080x1920", () => {
  const project = createEditProject(clip);
  project.frame = { aspect: "9:16", pan: 0.5 };
  const frame = outputFrame(project);
  assert.equal(frame.outWidth, 1080);
  assert.equal(frame.outHeight, 1920);
  assert.equal(frame.cropHeight, 1080);
  assert.ok(frame.cropWidth < 1920);
  assert.ok(frame.cropX > 0);
  assert.equal(frame.cropX % 2, 0);
  assert.ok(frame.cropX + frame.cropWidth <= 1920);
});

test("pan 0 keeps the left of a 9:16 crop and pan 1 keeps the right", () => {
  const project = createEditProject(clip);
  const left = outputFrame({ ...project, frame: { aspect: "9:16", pan: 0 } });
  const right = outputFrame({ ...project, frame: { aspect: "9:16", pan: 1 } });
  assert.equal(left.cropX, 0);
  assert.ok(right.cropX > left.cropX);
  assert.equal(right.cropX + right.cropWidth, 1920);
});

test("original 4K fits inside 1080p and a 720p master is not upscaled", () => {
  const fourK = outputFrame(createEditProject({ ...clip, width: 3840, height: 2160 }));
  assert.equal(fourK.outWidth, 1920);
  assert.equal(fourK.outHeight, 1080);
  const small = outputFrame(createEditProject({ ...clip, width: 1280, height: 720 }));
  assert.equal(small.outWidth, 1280);
  assert.equal(small.outHeight, 720);
});

test("trim stays inside the clip and keeps at least one second", () => {
  const project = applyTrim(createEditProject(clip), 12_000, 12_400);
  const range = projectRange(project);
  assert.equal(range.endMs - range.startMs, 1000);
  const clamped = projectRange(applyTrim(createEditProject(clip), -50, 999_999));
  assert.equal(clamped.startMs, 0);
  assert.equal(clamped.endMs, 180_000);
});

test("parse rejects another clip, a bad version, and more than one section", () => {
  const project = createEditProject(clip);
  assert.equal(parseEditProject(project, "other"), null);
  assert.equal(parseEditProject({ ...project, version: 2 }, clip.id), null);
  assert.equal(parseEditProject({ ...project, segments: [...project.segments, ...project.segments] }, clip.id), null);
  const restored = parseEditProject(applyTrim(project, 1000, 5000), clip.id);
  assert.equal(projectRange(restored!).startMs, 1000);
});

test("watermark export refuses to render without the mark asset", () => {
  const project = createEditProject(clip);
  assert.throws(() => buildExportRequest(project, "in.mp4", "out.mp4", true, null), /watermark/);
  const request = buildExportRequest(project, "in.mp4", "out.mp4", false, null);
  assert.equal(request.watermark, false);
  assert.equal(request.watermarkPath, null);
});
