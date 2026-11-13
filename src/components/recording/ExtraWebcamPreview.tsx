import { useEffect, useMemo, useRef } from "react";
import { createPreviewFeed, useFeedCanvas } from "../../recording/previewPoll";
import type { CameraPreviewHeader } from "../../types/camera";
import { startExtraCameraPreview, stopExtraCameraPreview, waitExtraCameraPreviewFrame } from "../../services/tauri";

/** Preview for a webcam after the first. The first webcam keeps the shared camera preview. */
export function ExtraWebcamPreview({
  sourceId,
  deviceId,
  width,
  height,
  fps,
  mirror,
  active,
}: {
  sourceId: string;
  deviceId: string;
  width: number;
  height: number;
  fps: number;
  mirror: boolean;
  active: boolean;
}) {
  const feed = useMemo(
    () =>
      createPreviewFeed<CameraPreviewHeader>({
        label: `webcam-${sourceId}`,
        wait: (after) => waitExtraCameraPreviewFrame(sourceId, after),
        headerKey: (header) => `${header.width}\0${header.height}\0${header.mirrored}`,
      }),
    [sourceId],
  );
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!active || !deviceId) return;
    void startExtraCameraPreview({ sourceId, deviceId, width, height, fps, mirror }).catch(() => undefined);
    return () => {
      void stopExtraCameraPreview(sourceId);
    };
  }, [active, sourceId, deviceId, width, height, fps, mirror]);

  useFeedCanvas(feed, canvasRef, active && Boolean(deviceId));
  if (!active || !deviceId) {
    return (
      <div className="preview-webcam-placeholder">
        <span>Camera</span>
      </div>
    );
  }
  return <canvas ref={canvasRef} className="preview-capture-canvas" style={mirror ? { transform: "scaleX(-1)" } : undefined} />;
}
