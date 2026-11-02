export type MomentLoop = { startMs: number; endMs: number };

/** When playback reaches the end of a short, return the time to jump back to. */
export function momentLoopRestart(ms: number, loop: MomentLoop | null): number | null {
  if (!loop) return null;
  if (ms >= loop.endMs - 80) return loop.startMs;
  return null;
}
