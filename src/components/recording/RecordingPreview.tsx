import { useState } from "react";
import type { CameraStatus } from "../../types/camera";
import type { PreviewBackgroundMode, RecordingVisualSettings, WebcamSettings } from "../../types/settings";
import { cameraPreviewLabel } from "../../recording/visualFilters";
import { PreviewCanvas } from "./PreviewCanvas";
import { PreviewFilterLayer } from "./PreviewFilterLayer";
import { PreviewOverlayLayer } from "./PreviewOverlayLayer";
import { PreviewWebcamLayer } from "./PreviewWebcamLayer";

export function RecordingPreview({
  webcam,
  visuals,
  camera,
  quiet,
}: {
  webcam: WebcamSettings;
  visuals: RecordingVisualSettings;
  camera: CameraStatus;
  quiet: boolean;
}) {
  const [background, setBackground] = useState<PreviewBackgroundMode>("mock");
  const [safeZone, setSafeZone] = useState(false);
  const cameraLabel = cameraPreviewLabel(webcam.enabled, webcam.deviceId, camera);

  return (
    <section className="panel recording-preview">
      <div className="panel-head">
        <h2>Recording Preview</h2>
      </div>
      <p className="preview-status">
        Camera: {cameraLabel}
        <span aria-hidden="true"> · </span>
        Gameplay: {background === "mock" ? "Mock" : "Dark"}
      </p>
      <PreviewCanvas background={background} safeZone={safeZone} quiet={quiet}>
        <PreviewWebcamLayer webcam={webcam} camera={camera} />
        <PreviewFilterLayer filter={visuals.filter} quiet={quiet} />
        <PreviewOverlayLayer filter={visuals.filter} overlays={visuals.overlays} />
      </PreviewCanvas>
      <div className="row preview-toolbar">
        <button
          type="button"
          className={`chip ${background === "mock" ? "on" : ""}`}
          onClick={() => setBackground("mock")}
        >
          Mock
        </button>
        <button
          type="button"
          className={`chip ${background === "dark" ? "on" : ""}`}
          onClick={() => setBackground("dark")}
        >
          Dark
        </button>
        <button
          type="button"
          className={`chip ${safeZone ? "on" : ""}`}
          onClick={() => setSafeZone((open) => !open)}
        >
          Safe zone
        </button>
      </div>
      <p className="muted">Composition preview only. Saved clips stay clean until export applies visuals.</p>
    </section>
  );
}
