import type { CSSProperties } from "react";
import { WebcamPreview } from "../sources/WebcamPreview";
import type { CameraStatus } from "../../types/camera";
import type { WebcamSettings } from "../../types/settings";
import { cameraPreviewAllowed } from "../../recording/visualFilters";
import type { SourceTransform } from "../../recording/scene";
import { webcamSettingsOf, type RecordingSource } from "../../recording/scene";
import { webcamOverlayStyle } from "../../utils/clips";

export function PreviewWebcamLayer({
  webcam,
  camera,
  source,
  framed,
}: {
  webcam: WebcamSettings;
  camera: CameraStatus;
  source?: RecordingSource;
  framed?: boolean;
}) {
  if (!webcam.enabled) return null;

  const allowed = cameraPreviewAllowed(camera);
  const disconnected =
    camera.availability === "disconnected" ||
    camera.availability === "permissionDenied" ||
    camera.availability === "failed" ||
    camera.availability === "unsupported";
  const live = Boolean(webcam.deviceId) && allowed && !disconnected;
  const shape = source ? webcamSettingsOf(source).shape : webcam.defaultShape;
  const transform = source?.transform ?? null;
  const layout = {
    placement: webcam.defaultPlacement,
    shape,
    width: webcam.defaultWidth,
    x: null as number | null,
    y: null as number | null,
  };

  const style = framed
    ? { inset: 0, width: "100%", height: "100%", left: 0, top: 0, right: 0, bottom: 0 }
    : transform
      ? transformStyle(transform)
      : webcamOverlayStyle(layout);

  return (
    <div
      className={`preview-webcam editor-webcam shape-${shape}${framed || transform ? " free" : ` place-${webcam.defaultPlacement}`}`}
      style={style}
    >
      {live ? (
        <WebcamPreview
          active
          deviceId={webcam.deviceId}
          width={webcam.width}
          height={webcam.height}
          fps={webcam.fps}
          mirror={webcam.mirrorPreview}
          disconnected={false}
          message=""
        />
      ) : (
        <div className="preview-webcam-placeholder">
          <span>{allowed ? "Camera" : "Camera: In use"}</span>
        </div>
      )}
    </div>
  );
}

function transformStyle(transform: SourceTransform): CSSProperties {
  return {
    left: `${transform.x * 100}%`,
    top: `${transform.y * 100}%`,
    width: `${transform.w * 100}%`,
    height: `${transform.h * 100}%`,
    right: "auto",
    bottom: "auto",
  };
}
