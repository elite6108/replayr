import { useEffect, useMemo, useRef } from "react";
import { createPreviewFeed, useFeedCanvas } from "../../recording/previewPoll";
import { desktopCaptureSettingsOf, type RecordingSource } from "../../recording/scene";
import { windowTargetOf } from "../../recording/sourceVisual";
import { startLayerPreview, stopLayerPreview, waitLayerPreviewFrame } from "../../services/tauri";

type LayerHeader = { width: number; height: number; frameId: number; mimeType: string };

/** Preview for a display or window that is not the base capture. */
export function ExtraLayerPreview({ source, active }: { source: RecordingSource; active: boolean }) {
  const sourceId = source.id;
  const feed = useMemo(
    () =>
      createPreviewFeed<LayerHeader>({
        label: `layer-${sourceId}`,
        wait: (after) => waitLayerPreviewFrame(sourceId, after),
        headerKey: (header) => `${header.width}\0${header.height}`,
      }),
    [sourceId],
  );
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const monitorId = source.type === "display" ? desktopCaptureSettingsOf(source).monitorId : null;
  const target = source.type === "window" ? windowTargetOf(source) : { title: "", className: "", exe: "" };
  const kind = source.type === "window" ? "window" : "display";

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void startLayerPreview({ sourceId, kind, monitorId, window: target }).catch(() => {
      if (!cancelled) undefined;
    });
    return () => {
      cancelled = true;
      void stopLayerPreview(sourceId);
    };
  }, [active, sourceId, kind, monitorId, target.title, target.className, target.exe]);

  useFeedCanvas(feed, canvasRef, active);
  if (!active) return null;
  return <canvas ref={canvasRef} className="preview-capture-canvas" />;
}
