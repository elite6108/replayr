import assert from "node:assert/strict";
import test from "node:test";
import { browserPreviewBounds } from "./browserPreview";

test("browser preview bounds follow the source box and leave a drag border", () => {
  const host = { left: 10, top: 20, width: 1000, height: 500 };
  const transform = { x: 0.1, y: 0.2, w: 0.4, h: 0.5 };
  assert.deepEqual(browserPreviewBounds(host, transform, 2, 0), { x: 220, y: 240, width: 800, height: 500 });
  assert.deepEqual(browserPreviewBounds(host, transform, 2, 8), { x: 236, y: 256, width: 768, height: 468 });
  assert.equal(browserPreviewBounds(host, { x: 0, y: 0, w: 0.001, h: 0.5 }, 1, 8), null);
});
