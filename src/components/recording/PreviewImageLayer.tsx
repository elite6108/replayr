import { useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { imageSettingsOf, type RecordingSource } from "../../recording/scene";
import { CroppedMediaFrame } from "./CroppedMediaFrame";

export function PreviewImageLayer({ source }: { source: RecordingSource }) {
  const { path, opacity } = imageSettingsOf(source);
  const src = fileSrc(path);
  const [aspect, setAspect] = useState(1);
  if (!src) {
    return (
      <div className="preview-image-placeholder">
        <span>Image</span>
      </div>
    );
  }
  return (
    <CroppedMediaFrame crop={source.crop} sourceAspect={aspect} fit="contain">
      {(mediaStyle) => (
        <img
          className="preview-image"
          src={src}
          alt=""
          draggable={false}
          style={{ ...mediaStyle, opacity, objectFit: "fill" }}
          onLoad={(event) => {
            const { naturalWidth, naturalHeight } = event.currentTarget;
            if (naturalWidth > 0 && naturalHeight > 0) {
              setAspect(naturalWidth / naturalHeight);
            }
          }}
        />
      )}
    </CroppedMediaFrame>
  );
}

function fileSrc(path: string): string {
  if (!path) return "";
  try {
    return convertFileSrc(path);
  } catch {
    return "";
  }
}
