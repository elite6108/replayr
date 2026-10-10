import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BASE_FILMSTRIP_TILES,
  MAX_FILMSTRIP_TILES,
  filmstripDensityForZoom,
  resampleFilmstripFrames,
} from "./filmstrip.ts";

test("filmstrip density tracks zoom using bounded cache buckets", () => {
  assert.equal(filmstripDensityForZoom(1), BASE_FILMSTRIP_TILES);
  assert.equal(filmstripDensityForZoom(2), 24);
  assert.equal(filmstripDensityForZoom(4), 48);
  assert.equal(filmstripDensityForZoom(8), 96);
  assert.equal(filmstripDensityForZoom(16), MAX_FILMSTRIP_TILES);
  assert.equal(filmstripDensityForZoom(Number.NaN), BASE_FILMSTRIP_TILES);
});

test("resampling repeats sparse frames evenly", () => {
  assert.deepEqual(resampleFilmstripFrames(["a", "b"], 6), ["a", "a", "a", "b", "b", "b"]);
});

test("resampling selects evenly from denser frames", () => {
  assert.deepEqual(resampleFilmstripFrames(["a", "b", "c", "d", "e", "f"], 3), ["a", "c", "e"]);
  assert.deepEqual(resampleFilmstripFrames([], 12), []);
  assert.deepEqual(resampleFilmstripFrames(["a"], 0), []);
});
