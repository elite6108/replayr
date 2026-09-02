import { useEffect, useState } from "react";
import { listCameraDevices } from "../../../services/tauri";
import type { CameraDevice, CameraStatus } from "../../../types/camera";
import type { WebcamPlacement, WebcamSettings, WebcamShape } from "../../../types/settings";
import { webcamSettingsOf, type RecordingSource } from "../../../recording/scene";

const PLACEMENTS: { id: WebcamPlacement; label: string }[] = [
  { id: "top-left", label: "TL" },
  { id: "top-right", label: "TR" },
  { id: "bottom-left", label: "BL" },
  { id: "bottom-right", label: "BR" },
];

const SHAPES: { id: WebcamShape; label: string }[] = [
  { id: "rectangle", label: "Rectangle" },
  { id: "rounded", label: "Rounded" },
  { id: "circle", label: "Circle" },
];

export function WebcamSourceSettings({
  source,
  webcam,
  camera,
  onToggle,
  onShape,
  onSnap,
  onDevice,
  onMirror,
}: {
  source: RecordingSource;
  webcam: WebcamSettings;
  camera: CameraStatus;
  onToggle: (enabled: boolean) => void;
  onShape: (shape: WebcamShape) => void;
  onSnap: (placement: WebcamPlacement) => void;
  onDevice: (device: CameraDevice) => void;
  onMirror: (mirror: boolean) => void;
}) {
  const [devices, setDevices] = useState<CameraDevice[]>([]);
  const shape = webcamSettingsOf(source).shape;
  void camera;
  void onToggle;

  useEffect(() => {
    let cancelled = false;
    void listCameraDevices()
      .then((listed) => {
        if (!cancelled) setDevices(listed);
      })
      .catch(() => {
        if (!cancelled) setDevices([]);
      });
    return () => {
      cancelled = true;
    };
  }, [camera.availability, webcam.deviceId]);

  return (
    <div className="studio-section">
      <div className="field">
        <label htmlFor="record-webcam-device">Device</label>
        <select
          id="record-webcam-device"
          value={webcam.deviceId}
          onChange={(event) => {
            const device = devices.find((item) => item.id === event.target.value);
            if (device) onDevice(device);
          }}
        >
          <option value="">Select a camera</option>
          {devices.map((device) => (
            <option key={device.id} value={device.id}>
              {device.name}
            </option>
          ))}
        </select>
      </div>
      <label className="studio-check">
        <input type="checkbox" checked={webcam.mirrorRecording} onChange={(event) => onMirror(event.target.checked)} />
        Mirror my video
      </label>
      <div className="field">
        <span className="settings-group-label">Shape</span>
        <div className="studio-chip-row">
          {SHAPES.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`studio-chip${shape === item.id ? " is-on" : ""}`}
              onClick={() => onShape(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <span className="settings-group-label">Snap</span>
        <div className="studio-chip-row">
          {PLACEMENTS.map((item) => (
            <button key={item.id} type="button" className="studio-chip" onClick={() => onSnap(item.id)}>
              {item.label}
            </button>
          ))}
        </div>
      </div>
      <p className="studio-output-hint">
        Session recordings use this preview position. Instant Replay clips still use the clip webcam corner in Settings.
      </p>
    </div>
  );
}
