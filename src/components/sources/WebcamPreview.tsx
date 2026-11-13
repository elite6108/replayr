import { useEffect, useRef, useState, type CSSProperties } from "react";
import { startCameraPreview, stopCameraPreview } from "../../services/tauri";
import { useSettingsStore } from "../../stores/settingsStore";
import { cameraPreviewFeed, useFeedCanvas } from "../../recording/previewPoll";

interface WebcamPreviewProps {
  active: boolean;
  deviceId: string;
  width: number;
  height: number;
  fps: number;
  mirror: boolean;
  disconnected: boolean;
  message: string;
  /** Picture adjustments as a CSS filter, so the preview matches the recording. */
  filter?: string;
}

export function WebcamPreview({
  active,
  deviceId,
  width,
  height,
  fps,
  mirror,
  disconnected,
  message,
  filter,
}: WebcamPreviewProps) {
  const smoothness = useSettingsStore((state) => state.settings.webcam.previewSmoothness);
  const [live, setLive] = useState(false);
  const [error, setError] = useState("");
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const running = active && Boolean(deviceId) && !disconnected;

  useEffect(() => {
    if (!running) {
      setLive(false);
      void stopCameraPreview();
      return;
    }
    let cancelled = false;
    setError("");
    cameraPreviewFeed.reset();
    void startCameraPreview({ deviceId, width, height, fps, mirror, smoothness }).catch((caught: unknown) => {
      if (!cancelled) {
        setError(caught instanceof Error ? caught.message : "Could not open the camera.");
        setLive(false);
      }
    });
    return () => {
      cancelled = true;
      void stopCameraPreview();
    };
  }, [running, deviceId, width, height, fps, mirror, smoothness]);

  useEffect(() => {
    if (!running) return;
    const sync = () => setLive(Boolean(cameraPreviewFeed.state().bitmap));
    const unsubscribe = cameraPreviewFeed.subscribe(sync);
    sync();
    return unsubscribe;
  }, [running]);

  useFeedCanvas(cameraPreviewFeed, canvasRef, running && live);

  const label = disconnected ? message || "Camera disconnected" : error || "LIVE CAMERA";
  const style: CSSProperties | undefined = filter ? { filter } : undefined;

  return (
    <div className={`webcam-preview ${live ? "live" : ""}`} aria-label="Webcam preview">
      {live ? <canvas ref={canvasRef} style={style} /> : <span>{label}</span>}
    </div>
  );
}
