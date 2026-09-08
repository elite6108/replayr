import { useEffect, useRef, useState } from "react";
import { getCameraPreviewFrame, startCameraPreview, stopCameraPreview } from "../../services/tauri";
import type { CameraPreviewFrame } from "../../types/camera";
import {
  createPreviewDiag,
  decodePngDataUrl,
  logPreviewDiag,
  startPreviewPollLoop,
} from "../../recording/previewPoll";

const WEBCAM_PREVIEW_POLL_MS = 33;

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
  const [displaySrc, setDisplaySrc] = useState("");
  const [error, setError] = useState("");
  const lastFrameId = useRef(0);
  const diag = useRef(createPreviewDiag());

  useEffect(() => {
    if (!active || !deviceId || disconnected) {
      setDisplaySrc("");
      lastFrameId.current = 0;
      void stopCameraPreview();
      return;
    }
    let cancelled = false;
    setError("");
    void startCameraPreview({ deviceId, width, height, fps, mirror }).catch((caught: unknown) => {
      if (!cancelled) {
        setError(caught instanceof Error ? caught.message : "Could not open the camera.");
        setDisplaySrc("");
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
    const stop = startPreviewPollLoop({
      intervalMs: WEBCAM_PREVIEW_POLL_MS,
      cancelled: () => cancelled,
      pull: async () => {
        const nextRaw = await getCameraPreviewFrame();
        if (cancelled || !nextRaw?.pngBase64) return;
        const next = normalizeCameraFrame(nextRaw);
        diag.current.offered += 1;
        const frameId = next.frameId || 0;
        if (frameId !== 0 && frameId === lastFrameId.current) {
          diag.current.duplicatesSkipped += 1;
          logPreviewDiag("webcam", diag.current, { width: next.width, height: next.height });
          return;
        }
        const url = await decodePngDataUrl(next.pngBase64);
        if (cancelled) return;
        lastFrameId.current = frameId;
        setDisplaySrc(url);
        diag.current.rendered += 1;
        logPreviewDiag("webcam", diag.current, { width: next.width, height: next.height, frameId });
      },
    });
    return () => {
      cancelled = true;
      stop();
    };
  }, [active, deviceId, disconnected]);

  const label = disconnected ? message || "Camera disconnected" : error || "LIVE CAMERA";

  return (
    <div className={`webcam-preview ${displaySrc ? "live" : ""}`} aria-label="Webcam preview">
      {displaySrc ? <img src={displaySrc} alt="" /> : <span>{label}</span>}
    </div>
  );
}

function normalizeCameraFrame(
  frame: CameraPreviewFrame & { png_base64?: string; frame_id?: number },
): CameraPreviewFrame {
  return {
    ...frame,
    pngBase64: frame.pngBase64 || frame.png_base64 || "",
    frameId: Number(frame.frameId ?? frame.frame_id ?? 0),
  };
}
