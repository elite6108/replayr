import { useEffect, useState } from "react";
import { getCameraPreviewFrame, startCameraPreview, stopCameraPreview } from "../../services/tauri";
import type { CameraPreviewFrame } from "../../types/camera";

interface WebcamPreviewProps {
  active: boolean;
  deviceId: string;
  width: number;
  height: number;
  fps: number;
  mirror: boolean;
  disconnected: boolean;
  message: string;
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
}: WebcamPreviewProps) {
  const [frame, setFrame] = useState<CameraPreviewFrame | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!active || !deviceId || disconnected) {
      setFrame(null);
      void stopCameraPreview();
      return;
    }
    let cancelled = false;
    setError("");
    void startCameraPreview({ deviceId, width, height, fps, mirror })
      .then(() => {
        if (cancelled) void stopCameraPreview();
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : "Could not open the camera.");
          setFrame(null);
        }
      });
    return () => {
      cancelled = true;
      void stopCameraPreview();
    };
  }, [active, deviceId, width, height, fps, mirror, disconnected]);

  useEffect(() => {
    if (!active || !deviceId || disconnected) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void getCameraPreviewFrame()
        .then((next) => {
          if (!cancelled && next?.pngBase64) setFrame(next);
        })
        .catch(() => undefined);
    }, 90);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [active, deviceId, disconnected]);

  const src = frame ? `data:image/png;base64,${frame.pngBase64}` : "";
  const label = disconnected ? message || "Camera disconnected" : error || "LIVE CAMERA";

  return (
    <div className={`webcam-preview ${src ? "live" : ""}`} aria-label="Webcam preview">
      {src ? <img src={src} alt="" /> : <span>{label}</span>}
    </div>
  );
}
