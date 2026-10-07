// Run with: node --test src/components/editor/segments.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clampSegmentEdge,
  clampViewStart,
  mergeWithNext,
  removeSegment,
  setOuterRange,
  singleSegment,
  splitAt,
  timelineMap,
  totalMs,
  zoomAround,
} from "./segments.ts";

const MIN = 1000;

test("timelineMap is the identity with one segment", () => {
  const map = timelineMap(singleSegment(2_000, 8_000, "a"), 10_000);
  assert.equal(map.collapsed, false);
  assert.equal(map.domainMs, 10_000);
  assert.equal(map.toTimeline(5_000), 5_000);
  assert.equal(map.toSource(5_000), 5_000);
  assert.equal(map.seams.length, 0);
});

test("timelineMap collapses removed footage", () => {
  const map = timelineMap(
    [
      { id: "a", startMs: 0, endMs: 60_000 },
      { id: "b", startMs: 120_000, endMs: 180_000 },
    ],
    180_000,
  );
  assert.equal(map.collapsed, true);
  assert.equal(map.domainMs, 120_000);
  assert.deepEqual(map.seams, [{ atMs: 60_000, beforeId: "a", afterId: "b" }]);
  assert.equal(map.toTimeline(30_000), 30_000);
  assert.equal(map.toTimeline(150_000), 90_000);
  assert.equal(map.toTimeline(90_000), 60_000, "gap maps to the seam before it");
  assert.equal(map.toSource(90_000), 150_000);
  assert.equal(map.toSource(60_000), 120_000, "seam resolves to the start of the next section");
  assert.equal(map.toSource(-5), 0);
  assert.equal(map.toSource(999_999), 180_000);
  for (const ms of [0, 10_000, 59_999, 60_000, 100_000, 120_000]) {
    assert.equal(map.toTimeline(map.toSource(ms)), ms);
  }
});

test("splitAt divides a segment at the playhead", () => {
  const base = singleSegment(0, 10_000, "a");
  const split = splitAt(base, 4_000, MIN);
  assert.equal(split.length, 2);
  assert.deepEqual([split[0]!.startMs, split[0]!.endMs], [0, 4_000]);
  assert.deepEqual([split[1]!.startMs, split[1]!.endMs], [4_000, 10_000]);
  assert.equal(split[0]!.id, "a");
});

test("splitAt refuses cuts that leave a side shorter than the minimum", () => {
  const base = singleSegment(0, 10_000, "a");
  assert.equal(splitAt(base, 500, MIN), base);
  assert.equal(splitAt(base, 9_700, MIN), base);
  assert.equal(splitAt(base, 12_000, MIN), base);
});

test("removeSegment drops a section but never the last one", () => {
  const split = splitAt(singleSegment(0, 10_000, "a"), 5_000, MIN);
  const removed = removeSegment(split, split[1]!.id);
  assert.equal(removed.length, 1);
  assert.equal(removed[0]!.id, "a");
  assert.equal(removeSegment(removed, "a"), removed);
});

test("mergeWithNext spans the gap between two sections", () => {
  let segments = splitAt(singleSegment(0, 10_000, "a"), 3_000, MIN);
  segments = splitAt(segments, 7_000, MIN);
  const middle = segments[1]!;
  const withGap = removeSegment(segments, middle.id);
  assert.equal(totalMs(withGap), 6_000);
  const merged = mergeWithNext(withGap, "a");
  assert.equal(merged.length, 1);
  assert.deepEqual([merged[0]!.startMs, merged[0]!.endMs], [0, 10_000]);
});

test("clampSegmentEdge respects neighbours, the clip and the minimum length", () => {
  const segments = splitAt(singleSegment(0, 10_000, "a"), 5_000, MIN);
  const right = segments[1]!;
  const pulledLeft = clampSegmentEdge(segments, right.id, "start", 1_000, MIN, 10_000);
  assert.equal(pulledLeft.ms, 5_000);
  const pushedRight = clampSegmentEdge(segments, right.id, "end", 20_000, MIN, 10_000);
  assert.equal(pushedRight.ms, 10_000);
  const tooShort = clampSegmentEdge(segments, right.id, "end", 5_200, MIN, 10_000);
  assert.equal(tooShort.ms, 6_000);
});

test("setOuterRange behaves like a plain trim with one segment", () => {
  const next = setOuterRange(singleSegment(0, 10_000, "a"), 2_000, 8_000, MIN, 10_000);
  assert.equal(next.length, 1);
  assert.deepEqual([next[0]!.startMs, next[0]!.endMs], [2_000, 8_000]);
  assert.equal(next[0]!.id, "a");
});

test("zoom window stays inside the clip and anchors under the cursor", () => {
  assert.equal(clampViewStart(-500, 60_000, 2), 0);
  assert.equal(clampViewStart(50_000, 60_000, 2), 30_000);
  // Cursor at 30 s sitting at the middle of the view; zooming to 2x keeps it centred.
  assert.equal(zoomAround(30_000, 0.5, 60_000, 2), 15_000);
  assert.equal(zoomAround(30_000, 0.5, 60_000, 1), 0);
});
