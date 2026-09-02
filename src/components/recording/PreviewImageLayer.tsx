import { convertFileSrc } from "@tauri-apps/api/core";
import { imageSettingsOf, type RecordingSource } from "../../recording/scene";

export function PreviewImageLayer({ source }: { source: RecordingSource }) {
  const { path, opacity } = imageSettingsOf(source);
  const src = fileSrc(path);
  if (!src) {
    return (
      <div className="preview-image-placeholder">
        <span>Image</span>
      </div>
    );
  }
  return <img className="preview-image" src={src} alt="" draggable={false} style={{ opacity }} />;
}

function fileSrc(path: string): string {
  if (!path) return "";
  try {
    return convertFileSrc(path);
  } catch {
    return "";
  }
}
