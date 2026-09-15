import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect } from "react";
import { screenshotImageUrl } from "../../branding";
import type { Screenshot } from "../../types/screenshot";
import { formatClipDate } from "../../utils/format";

export function ScreenshotViewer({
  shot,
  onClose,
  onDownload,
}: {
  shot: Screenshot;
  onClose: () => void;
  onDownload: () => void;
}) {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const src = shot.filePath
    ? convertFileSrc(shot.filePath)
    : shot.slug
      ? screenshotImageUrl(shot.slug)
      : shot.thumbPath
        ? convertFileSrc(shot.thumbPath)
        : "";

  return (
    <div className="player-overlay" role="dialog" aria-modal="true" aria-label="Screenshot">
      <button type="button" className="player-backdrop" aria-label="Close screenshot" onClick={onClose} />
      <div className="screenshot-viewer">
        {src ? <img src={src} alt="" width={shot.width} height={shot.height} /> : <p className="muted">Image unavailable</p>}
        <div className="screenshot-viewer-bar">
          <span className="muted">
            {shot.width}×{shot.height}
            {formatClipDate(shot.createdAt) ? ` · ${formatClipDate(shot.createdAt)}` : ""}
          </span>
          <div className="row">
            <button type="button" className="btn primary" onClick={onDownload}>
              Download
            </button>
            <button type="button" className="btn" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
