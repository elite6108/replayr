import { WebcamPreview } from "../sources/WebcamPreview";
import type { CameraStatus } from "../../types/camera";
import type { WebcamSettings } from "../../types/settings";
import { cameraPreviewAllowed } from "../../recording/visualFilters";
import { webcamOverlayStyle } from "../../utils/clips";

export function PreviewWebcamLayer({
  webcam,
  camera,
}: {
  webcam: WebcamSettings;
  camera: CameraStatus;
}) {
  if (!webcam.enabled) return null;

  const allowed = cameraPreviewAllowed(camera);
  const disconnected =
    camera.availability === "disconnected" ||
    camera.availability === "permissionDenied" ||
    camera.availability === "failed" ||
    camera.availability === "unsupported";
  const live = Boolean(webcam.deviceId) && allowed && !disconnected;
  const layout = {
    placement: webcam.defaultPlacement,
    shape: webcam.defaultShape,
    width: webcam.defaultWidth,
    x: null,
    y: null,
  };

  return (
    <div
      className={`preview-webcam editor-webcam place-${webcam.defaultPlacement} shape-${webcam.defaultShape}`}
      style={webcamOverlayStyle(layout)}
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
