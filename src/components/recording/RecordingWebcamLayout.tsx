import { Link } from "react-router-dom";
import type { WebcamPlacement, WebcamSettings, WebcamShape } from "../../types/settings";
import { cameraPreviewLabel } from "../../recording/visualFilters";
import type { CameraStatus } from "../../types/camera";

const PLACEMENTS: { id: WebcamPlacement; label: string }[] = [
  { id: "top-left", label: "Top Left" },
  { id: "top-right", label: "Top Right" },
  { id: "bottom-left", label: "Bottom Left" },
  { id: "bottom-right", label: "Bottom Right" },
];

const SHAPES: { id: WebcamShape; label: string }[] = [
  { id: "rectangle", label: "Rectangle" },
  { id: "rounded", label: "Rounded" },
  { id: "circle", label: "Circle" },
];

export function RecordingWebcamLayout({
  webcam,
  camera,
  onChange,
}: {
  webcam: WebcamSettings;
  camera: CameraStatus;
  onChange: (next: WebcamSettings) => Promise<void>;
}) {
  const status = cameraPreviewLabel(webcam.enabled, webcam.deviceId, camera);

  function patch(partial: Partial<WebcamSettings>) {
    return onChange({ ...webcam, ...partial });
  }

  return (
    <div className="stack">
      <label className="setting-row">
        <span className="setting-copy">
          Webcam
          <small>Camera: {status}</small>
        </span>
        <input
          className="switch"
          type="checkbox"
          checked={webcam.enabled}
          onChange={(event) => void patch({ enabled: event.target.checked })}
        />
      </label>
      <div className="field">
        <span className="settings-group-label">Position</span>
        <div className="placement-grid" role="group" aria-label="Webcam position">
          {PLACEMENTS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`placement-cell ${webcam.defaultPlacement === item.id ? "on" : ""}`}
              onClick={() => void patch({ defaultPlacement: item.id })}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <span className="settings-group-label">Shape</span>
        <div className="shape-row">
          {SHAPES.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`chip ${webcam.defaultShape === item.id ? "on" : ""}`}
              onClick={() => void patch({ defaultShape: item.id })}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
      <label className="setting-row">
        <span>Width</span>
        <span className="muted">{Math.round(webcam.defaultWidth * 100)}%</span>
      </label>
      <input
        type="range"
        min={12}
        max={40}
        value={Math.round(webcam.defaultWidth * 100)}
        onChange={(event) => void patch({ defaultWidth: Number(event.target.value) / 100 })}
      />
      <p className="muted">
        Device stays in{" "}
        <Link className="settings-link" to="/settings?section=recording">
          Settings
        </Link>
        .
      </p>
    </div>
  );
}
