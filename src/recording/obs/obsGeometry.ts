/**
 * OBS scene-item placement math, converted to Replayr's model.
 *
 * OBS places an item by its alignment point (`pos` + `align`), sizes it by `scale` or by a
 * bounds box (`bounds_type`, `bounds`, `bounds_align`), and trims it with pixel crop. Replayr
 * stores where the visible picture lands as a canvas rectangle plus a UV crop of the source, so
 * both are computed here in pixels and normalized at the end. Content that falls outside the
 * canvas or a parent scene becomes extra crop, which keeps the picture exactly where OBS drew it.
 */
import type { ObsSceneItem } from "./obsSchema";

export type Size = { w: number; h: number };
export type Rect = { x: number; y: number; w: number; h: number };

/** Where a piece of a source lands: `rect` in some pixel space, showing `uv` of the source. */
export type Placement = { rect: Rect; uv: Rect };

/** Maps a container's local pixels to canvas pixels and limits what stays visible. */
export type Frame = { sx: number; sy: number; ox: number; oy: number; clip: Rect };

export const FULL_UV: Rect = { x: 0, y: 0, w: 1, h: 1 };

const ALIGN_LEFT = 1;
const ALIGN_RIGHT = 2;
const ALIGN_TOP = 4;
const ALIGN_BOTTOM = 8;

const BOUNDS_NONE = 0;
const BOUNDS_STRETCH = 1;
const BOUNDS_SCALE_INNER = 2;
const BOUNDS_SCALE_OUTER = 3;
const BOUNDS_SCALE_TO_WIDTH = 4;
const BOUNDS_SCALE_TO_HEIGHT = 5;
const BOUNDS_MAX_ONLY = 6;

const EPSILON = 1e-6;

export type PlacementNote = "rotated" | "flipped" | "stretched";

export function rootFrame(canvas: Size): Frame {
  return { sx: 1, sy: 1, ox: 0, oy: 0, clip: { x: 0, y: 0, w: canvas.w, h: canvas.h } };
}

/** Offset of an alignment point inside a box of `size` along one axis. */
function alignOffset(align: number, size: number, start: number, end: number): number {
  if (align & start) return 0;
  if (align & end) return size;
  return size / 2;
}

/**
 * Place one scene item in its container's pixel space.
 * Returns null when the cropped source has no area left.
 */
export function placeItem(item: ObsSceneItem, source: Size): { placement: Placement; notes: PlacementNote[] } | null {
  if (!(source.w > 0 && source.h > 0)) return null;
  const notes: PlacementNote[] = [];
  const left = Math.min(item.crop.left, source.w);
  const top = Math.min(item.crop.top, source.h);
  const cw = source.w - left - Math.min(item.crop.right, source.w - left);
  const ch = source.h - top - Math.min(item.crop.bottom, source.h - top);
  if (cw < 1 || ch < 1) return null;
  let uv: Rect = { x: left / source.w, y: top / source.h, w: cw / source.w, h: ch / source.h };

  if (item.scale.x < 0 || item.scale.y < 0) notes.push("flipped");
  const sx = Math.abs(item.scale.x);
  const sy = Math.abs(item.scale.y);

  let boxW: number;
  let boxH: number;
  let content: Rect;
  if (item.boundsType === BOUNDS_NONE) {
    boxW = cw * sx;
    boxH = ch * sy;
    content = { x: 0, y: 0, w: boxW, h: boxH };
  } else {
    boxW = Math.abs(item.bounds.x);
    boxH = Math.abs(item.bounds.y);
    if (boxW < EPSILON || boxH < EPSILON) return null;
    const inner = Math.min(boxW / cw, boxH / ch);
    let w: number;
    let h: number;
    switch (item.boundsType) {
      case BOUNDS_STRETCH:
        w = boxW;
        h = boxH;
        if (Math.abs(boxW / boxH - cw / ch) > 0.01 * (cw / ch)) notes.push("stretched");
        break;
      case BOUNDS_SCALE_OUTER: {
        const outer = Math.max(boxW / cw, boxH / ch);
        w = cw * outer;
        h = ch * outer;
        break;
      }
      case BOUNDS_SCALE_TO_WIDTH:
        w = boxW;
        h = ch * (boxW / cw);
        break;
      case BOUNDS_SCALE_TO_HEIGHT:
        w = cw * (boxH / ch);
        h = boxH;
        break;
      case BOUNDS_MAX_ONLY: {
        const k = Math.min(1, inner);
        w = cw * k;
        h = ch * k;
        break;
      }
      case BOUNDS_SCALE_INNER:
      default:
        w = cw * inner;
        h = ch * inner;
        break;
    }
    content = {
      x: alignOffset(item.boundsAlign, boxW - w, ALIGN_LEFT, ALIGN_RIGHT),
      y: alignOffset(item.boundsAlign, boxH - h, ALIGN_TOP, ALIGN_BOTTOM),
      w,
      h,
    };
    if (item.boundsType === BOUNDS_SCALE_OUTER && item.cropToBounds) {
      const clipped = clipPlacement({ rect: content, uv }, { x: 0, y: 0, w: boxW, h: boxH });
      if (!clipped) return null;
      content = clipped.rect;
      uv = clipped.uv;
    }
  }

  const originX = item.pos.x - alignOffset(item.align, boxW, ALIGN_LEFT, ALIGN_RIGHT);
  const originY = item.pos.y - alignOffset(item.align, boxH, ALIGN_TOP, ALIGN_BOTTOM);
  let rect: Rect = { x: originX + content.x, y: originY + content.y, w: content.w, h: content.h };

  const turn = ((item.rot % 360) + 360) % 360;
  if (turn > EPSILON && Math.abs(turn - 360) > EPSILON) {
    rect = rotateAbout(rect, item.pos, turn);
    if (Math.abs(turn - 180) > EPSILON) notes.push("rotated");
  }
  return { placement: { rect, uv }, notes };
}

/**
 * Turn `rect` about `pivot`. Replayr has no rotation, so the picture stays upright: a half turn
 * lands exactly where OBS draws it, any other angle is centred on where OBS draws it.
 */
function rotateAbout(rect: Rect, pivot: { x: number; y: number }, degrees: number): Rect {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const cx = rect.x + rect.w / 2 - pivot.x;
  const cy = rect.y + rect.h / 2 - pivot.y;
  const centerX = pivot.x + cx * cos - cy * sin;
  const centerY = pivot.y + cx * sin + cy * cos;
  return { x: centerX - rect.w / 2, y: centerY - rect.h / 2, w: rect.w, h: rect.h };
}

/** Intersect a placement with `clip`, trimming the UV by the same proportion. */
export function clipPlacement(placement: Placement, clip: Rect): Placement | null {
  const { rect, uv } = placement;
  const x0 = Math.max(rect.x, clip.x);
  const y0 = Math.max(rect.y, clip.y);
  const x1 = Math.min(rect.x + rect.w, clip.x + clip.w);
  const y1 = Math.min(rect.y + rect.h, clip.y + clip.h);
  if (x1 - x0 < EPSILON || y1 - y0 < EPSILON || rect.w < EPSILON || rect.h < EPSILON) return null;
  return {
    rect: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
    uv: {
      x: uv.x + ((x0 - rect.x) / rect.w) * uv.w,
      y: uv.y + ((y0 - rect.y) / rect.h) * uv.h,
      w: ((x1 - x0) / rect.w) * uv.w,
      h: ((y1 - y0) / rect.h) * uv.h,
    },
  };
}

/** Map a rectangle from a frame's local pixels to canvas pixels. */
export function toCanvas(frame: Frame, rect: Rect): Rect {
  return {
    x: frame.ox + rect.x * frame.sx,
    y: frame.oy + rect.y * frame.sy,
    w: rect.w * frame.sx,
    h: rect.h * frame.sy,
  };
}

/**
 * Frame for the children of a nested scene or group. `placement` is where the (cropped)
 * container lands in the parent frame, and `size` is the container's own pixel size.
 */
export function childFrame(parent: Frame, placement: Placement, size: Size): Frame | null {
  const { rect, uv } = placement;
  const shownW = uv.w * size.w;
  const shownH = uv.h * size.h;
  if (shownW < EPSILON || shownH < EPSILON) return null;
  const kx = rect.w / shownW;
  const ky = rect.h / shownH;
  const local = {
    sx: kx,
    sy: ky,
    ox: rect.x - uv.x * size.w * kx,
    oy: rect.y - uv.y * size.h * ky,
  };
  const canvasRect = toCanvas(parent, rect);
  const clip = intersect(canvasRect, parent.clip);
  if (!clip) return null;
  return {
    sx: parent.sx * local.sx,
    sy: parent.sy * local.sy,
    ox: parent.ox + local.ox * parent.sx,
    oy: parent.oy + local.oy * parent.sy,
    clip,
  };
}

function intersect(a: Rect, b: Rect): Rect | null {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  if (x1 - x0 < EPSILON || y1 - y0 < EPSILON) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Place an item through a frame onto the canvas, cropped to what is actually visible. */
export function placeOnCanvas(frame: Frame, placement: Placement): Placement | null {
  return clipPlacement({ rect: toCanvas(frame, placement.rect), uv: placement.uv }, frame.clip);
}

/** Canvas pixels to 0–1 fractions. */
export function normalize(rect: Rect, canvas: Size): Rect {
  return { x: rect.x / canvas.w, y: rect.y / canvas.h, w: rect.w / canvas.w, h: rect.h / canvas.h };
}

export function isFullUv(uv: Rect): boolean {
  return uv.x <= 1e-4 && uv.y <= 1e-4 && uv.w >= 1 - 1e-4 && uv.h >= 1 - 1e-4;
}
