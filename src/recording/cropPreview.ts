import type { CSSProperties } from "react";
import { isFullCrop, type SourceCrop } from "./scene";

/**
 * CSS that maps a UV crop window onto a media element so the crop fills its
 * parent box 1:1. Parent must use overflow:hidden.
 */
export function uvFillStyle(crop: SourceCrop | null | undefined): CSSProperties {
  if (!crop || isFullCrop(crop)) {
    return {
      position: "absolute",
      inset: 0,
      width: "100%",
      height: "100%",
    };
  }
  const w = Math.max(crop.w, 1e-4);
  const h = Math.max(crop.h, 1e-4);
  return {
    position: "absolute",
    left: `${(-crop.x / w) * 100}%`,
    top: `${(-crop.y / h) * 100}%`,
    width: `${(1 / w) * 100}%`,
    height: `${(1 / h) * 100}%`,
    maxWidth: "none",
    maxHeight: "none",
  };
}

/** Cropped region aspect from native source aspect and UV crop. */
export function croppedAspect(sourceAspect: number, crop: SourceCrop | null | undefined): number {
  const base = Number.isFinite(sourceAspect) && sourceAspect > 0 ? sourceAspect : 16 / 9;
  if (!crop || isFullCrop(crop)) return base;
  return base * (crop.w / Math.max(crop.h, 1e-4));
}
