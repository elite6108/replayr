import type { CSSProperties, ReactNode } from "react";
import { croppedAspect, uvFillStyle } from "../../recording/cropPreview";
import { isFullCrop, type SourceCrop } from "../../recording/scene";

export function CroppedMediaFrame({
  crop,
  sourceAspect,
  fit,
  children,
}: {
  crop: SourceCrop | null | undefined;
  sourceAspect: number;
  fit: "contain" | "cover";
  children: (mediaStyle: CSSProperties) => ReactNode;
}) {
  // Full-frame crop: fill the canvas directly — no nested letterbox box.
  if (isFullCrop(crop)) {
    return (
      <div className="preview-crop-viewport preview-crop-full">
        <div className="preview-crop-clip preview-crop-clip-full">{children(uvFillStyle(crop))}</div>
      </div>
    );
  }

  const aspect = croppedAspect(sourceAspect, crop);
  return (
    <div className="preview-crop-viewport">
      <div
        className={`preview-crop-fit preview-crop-${fit}`}
        style={{ ["--crop-aspect" as string]: String(aspect) }}
      >
        <div className="preview-crop-clip">{children(uvFillStyle(crop))}</div>
      </div>
    </div>
  );
}
