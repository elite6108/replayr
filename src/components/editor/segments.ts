/**
 * Pure model for the editor's kept time ranges. Segments are always sorted,
 * non-overlapping and at least `minMs` long. No React, no I/O.
 */

export type Segment = { id: string; startMs: number; endMs: number };
export type SegmentEdge = "start" | "end";

let counter = 0;
export function newSegmentId(): string {
  counter += 1;
  return `seg-${Date.now().toString(36)}-${counter}`;
}

function round(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

export function singleSegment(startMs: number, endMs: number, id = newSegmentId()): Segment[] {
  return [{ id, startMs: round(startMs), endMs: round(endMs) }];
}

export function totalMs(segments: Segment[]): number {
  return segments.reduce((sum, segment) => sum + Math.max(0, segment.endMs - segment.startMs), 0);
}

export function segmentsToRanges(segments: Segment[]): Array<[number, number]> {
  return segments.map((segment) => [segment.startMs, segment.endMs]);
}

export function outerRange(segments: Segment[]): { startMs: number; endMs: number } {
  if (segments.length === 0) return { startMs: 0, endMs: 0 };
  return { startMs: segments[0]!.startMs, endMs: segments[segments.length - 1]!.endMs };
}

export function segmentAt(segments: Segment[], ms: number): Segment | null {
  return segments.find((segment) => ms >= segment.startMs && ms <= segment.endMs) ?? null;
}

/** Returns the first segment that starts at or after `ms`, used to skip gaps during playback. */
export function nextSegmentAfter(segments: Segment[], ms: number): Segment | null {
  return segments.find((segment) => segment.startMs > ms) ?? null;
}

/**
 * Splits the segment containing `atMs` into two. Returns the input unchanged when
 * the cut would leave either side shorter than `minMs` or no segment contains `atMs`.
 */
export function splitAt(segments: Segment[], atMs: number, minMs: number): Segment[] {
  const at = round(atMs);
  const index = segments.findIndex((segment) => at > segment.startMs && at < segment.endMs);
  if (index < 0) return segments;
  const target = segments[index]!;
  if (at - target.startMs < minMs || target.endMs - at < minMs) return segments;
  const left: Segment = { ...target, endMs: at };
  const right: Segment = { id: newSegmentId(), startMs: at, endMs: target.endMs };
  return [...segments.slice(0, index), left, right, ...segments.slice(index + 1)];
}

/** Removes a segment. The last remaining segment can never be removed. */
export function removeSegment(segments: Segment[], id: string): Segment[] {
  if (segments.length <= 1) return segments;
  const next = segments.filter((segment) => segment.id !== id);
  return next.length === segments.length ? segments : next;
}

/** Joins `id` with the segment that follows it, spanning the gap between them. */
export function mergeWithNext(segments: Segment[], id: string): Segment[] {
  const index = segments.findIndex((segment) => segment.id === id);
  if (index < 0 || index >= segments.length - 1) return segments;
  const current = segments[index]!;
  const following = segments[index + 1]!;
  const merged: Segment = { ...current, endMs: following.endMs };
  return [...segments.slice(0, index), merged, ...segments.slice(index + 2)];
}

/** Rejoins neighbours whose edges touch exactly. */
export function mergeAdjacent(segments: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const segment of segments) {
    const last = out[out.length - 1];
    if (last && last.endMs === segment.startMs) {
      out[out.length - 1] = { ...last, endMs: segment.endMs };
    } else {
      out.push(segment);
    }
  }
  return out.length === segments.length ? segments : out;
}

/**
 * Moves one edge of a segment, bounded by the clip, the neighbouring segments and
 * `minMs`. Returns the clamped millisecond value that was applied.
 */
export function clampSegmentEdge(
  segments: Segment[],
  id: string,
  edge: SegmentEdge,
  ms: number,
  minMs: number,
  durationMs: number,
): { segments: Segment[]; ms: number } {
  const index = segments.findIndex((segment) => segment.id === id);
  if (index < 0) return { segments, ms: round(ms) };
  const target = segments[index]!;
  const previous = segments[index - 1];
  const following = segments[index + 1];
  let next: number;
  if (edge === "start") {
    const low = previous ? previous.endMs : 0;
    const high = target.endMs - minMs;
    next = Math.max(low, Math.min(round(ms), high));
  } else {
    const low = target.startMs + minMs;
    const high = following ? following.startMs : round(durationMs);
    next = Math.max(low, Math.min(round(ms), high));
  }
  if (next === (edge === "start" ? target.startMs : target.endMs)) return { segments, ms: next };
  const updated: Segment = edge === "start" ? { ...target, startMs: next } : { ...target, endMs: next };
  return { segments: [...segments.slice(0, index), updated, ...segments.slice(index + 1)], ms: next };
}

/**
 * Applies a new outer In/Out pair. With one segment this is a plain trim; with
 * several it moves the first start and last end while respecting their neighbours.
 */
export function setOuterRange(
  segments: Segment[],
  startMs: number,
  endMs: number,
  minMs: number,
  durationMs: number,
): Segment[] {
  if (segments.length <= 1) {
    const id = segments[0]?.id ?? newSegmentId();
    return singleSegment(startMs, endMs, id);
  }
  const first = segments[0]!;
  const last = segments[segments.length - 1]!;
  let next = clampSegmentEdge(segments, first.id, "start", startMs, minMs, durationMs).segments;
  next = clampSegmentEdge(next, last.id, "end", endMs, minMs, durationMs).segments;
  return next;
}

/**
 * Maps between source time (what `segments` store) and the displayed timeline.
 * With one segment it is the identity over the whole clip. With several, the
 * removed footage is collapsed so kept sections sit back to back.
 */
export type TimelinePiece = { id: string; startMs: number; endMs: number; offsetMs: number };
export type TimelineSeam = { atMs: number; beforeId: string; afterId: string };
export type TimelineMap = {
  collapsed: boolean;
  domainMs: number;
  pieces: TimelinePiece[];
  seams: TimelineSeam[];
  toTimeline(sourceMs: number): number;
  toSource(timelineMs: number): number;
};

export function timelineMap(segments: Segment[], durationMs: number): TimelineMap {
  const duration = Math.max(0, round(durationMs));
  if (segments.length <= 1) {
    const id = segments[0]?.id ?? "clip";
    const identity = (ms: number) => Math.max(0, Math.min(duration, Number.isFinite(ms) ? ms : 0));
    return {
      collapsed: false,
      domainMs: duration,
      pieces: [{ id, startMs: 0, endMs: duration, offsetMs: 0 }],
      seams: [],
      toTimeline: identity,
      toSource: identity,
    };
  }
  const pieces: TimelinePiece[] = [];
  const seams: TimelineSeam[] = [];
  let offset = 0;
  segments.forEach((segment, index) => {
    pieces.push({ id: segment.id, startMs: segment.startMs, endMs: segment.endMs, offsetMs: offset });
    offset += Math.max(0, segment.endMs - segment.startMs);
    const following = segments[index + 1];
    if (following) seams.push({ atMs: offset, beforeId: segment.id, afterId: following.id });
  });
  const domainMs = offset;
  return {
    collapsed: true,
    domainMs,
    pieces,
    seams,
    toTimeline(sourceMs) {
      if (!Number.isFinite(sourceMs) || sourceMs <= pieces[0]!.startMs) return 0;
      for (const piece of pieces) {
        if (sourceMs < piece.startMs) return piece.offsetMs; // inside the gap before this piece
        if (sourceMs <= piece.endMs) return piece.offsetMs + (sourceMs - piece.startMs);
      }
      return domainMs;
    },
    toSource(timelineMs) {
      if (!Number.isFinite(timelineMs) || timelineMs <= 0) return pieces[0]!.startMs;
      if (timelineMs >= domainMs) return pieces[pieces.length - 1]!.endMs;
      for (const piece of pieces) {
        const length = piece.endMs - piece.startMs;
        if (timelineMs < piece.offsetMs + length) return piece.startMs + (timelineMs - piece.offsetMs);
      }
      return pieces[pieces.length - 1]!.endMs;
    },
  };
}

/** Zoom window helpers. `zoom` is 1 (whole clip) and up; `viewStartMs` is the left edge. */
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 16;

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return MIN_ZOOM;
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
}

export function viewSpanMs(durationMs: number, zoom: number): number {
  return durationMs / clampZoom(zoom);
}

export function clampViewStart(viewStartMs: number, durationMs: number, zoom: number): number {
  const span = viewSpanMs(durationMs, zoom);
  const max = Math.max(0, durationMs - span);
  if (!Number.isFinite(viewStartMs)) return 0;
  return Math.max(0, Math.min(viewStartMs, max));
}

/**
 * New view start so the time under the cursor (`anchorMs` at `anchorFrac` of the
 * visible width) stays put while zoom changes.
 */
export function zoomAround(
  anchorMs: number,
  anchorFrac: number,
  durationMs: number,
  nextZoom: number,
): number {
  const span = viewSpanMs(durationMs, nextZoom);
  return clampViewStart(anchorMs - anchorFrac * span, durationMs, nextZoom);
}

export function pctInView(ms: number, viewStartMs: number, viewEndMs: number): number {
  const span = viewEndMs - viewStartMs;
  if (span <= 0) return 0;
  return ((ms - viewStartMs) / span) * 100;
}
