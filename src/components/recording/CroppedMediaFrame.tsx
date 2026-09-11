import type { CSSProperties, ReactNode } from "react";
import { croppedAspect, uvFillStyle } from "../../recording/cropPreview";
import type { SourceCrop } from "../../recording/scene";

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
