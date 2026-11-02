import assert from "node:assert/strict";
import test from "node:test";
import { momentLoopRestart } from "./momentLoop.ts";

test("a short loops back to its start at the end", () => {
  const loop = { startMs: 12_000, endMs: 40_000 };
  assert.equal(momentLoopRestart(20_000, loop), null);
  assert.equal(momentLoopRestart(39_920, loop), 12_000);
  assert.equal(momentLoopRestart(39_920, null), null);
});
