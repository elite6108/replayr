import { clampZoom } from "./segments";

export const BASE_FILMSTRIP_TILES = 12;
export const MAX_FILMSTRIP_TILES = 192;

const FILMSTRIP_DENSITIES = [12, 18, 24, 36, 48, 72, 96, 144, 192] as const;

/** Chooses the cached density whose tile width is closest to the base timeline tile width. */
export function filmstripDensityForZoom(zoom: number): number {
  const target = BASE_FILMSTRIP_TILES * clampZoom(zoom);
  return FILMSTRIP_DENSITIES.reduce((best, candidate) =>
    Math.abs(Math.log(candidate / target)) < Math.abs(Math.log(best / target)) ? candidate : best,
  );
}

/**
 * Evenly resamples available thumbnails to the requested visual tile count.
 * Missing detail is temporarily repeated; surplus detail is sampled down.
 */
export function resampleFilmstripFrames<T>(frames: readonly T[], count: number): T[] {
  if (frames.length === 0 || count <= 0) return [];
  const target = Math.max(1, Math.round(count));
  if (frames.length === target) return [...frames];
  return Array.from({ length: target }, (_, index) => {
    const sourceIndex = Math.min(frames.length - 1, Math.floor((index * frames.length) / target));
    return frames[sourceIndex]!;
  });
}
