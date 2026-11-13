import { useEffect, useState } from "react";
import { listCameraDevices, startWebcamTestRecord, stopWebcamTestRecord } from "../../services/tauri";
import type { CameraDevice, CameraStatus } from "../../types/camera";
import type { WebcamPlacement, WebcamSettings, WebcamShape } from "../../types/settings";
import { CameraModePicker } from "./CameraModePicker";
import { WebcamPreview } from "./WebcamPreview";

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

interface WebcamSourceCardProps {
  webcam: WebcamSettings;
  status: CameraStatus;
  previewing: boolean;
  onChange: (next: WebcamSettings) => Promise<void>;
}

export function WebcamSourceCard({ webcam, status, previewing, onChange }: WebcamSourceCardProps) {
  const [devices, setDevices] = useState<CameraDevice[]>([]);
  const [modesReady, setModesReady] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [testError, setTestError] = useState("");
  const deviceId = webcam.deviceId;

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
  }, [status.availability, webcam.deviceId]);

  const testRecording = status.recording && !status.rolling;
  const instantReplayLive = status.rolling;
  const disconnected =
    status.availability === "disconnected" ||
    status.availability === "permissionDenied" ||
    status.availability === "failed";
  const mbMin = status.estimatedMbPerMinute || estimateMb(webcam.width, webcam.height, webcam.fps);
  const impact = webcam.height >= 1080 && webcam.fps >= 60 ? "Moderate" : webcam.height >= 1080 ? "Low–moderate" : "Low";

  function patch(partial: Partial<WebcamSettings>) {
    return onChange({ ...webcam, ...partial });
  }

  async function runTestRecord() {
    if (!deviceId || testBusy || instantReplayLive) return;
    setTestError("");
    setTestBusy(true);
    try {
      if (testRecording) {
        await stopWebcamTestRecord();
        return;
      }
      await startWebcamTestRecord({
        deviceId,
        width: webcam.width,
        height: webcam.height,
        fps: webcam.fps,
        mirror: webcam.mirrorRecording,
      });
    } catch (caught) {
      setTestError(caught instanceof Error ? caught.message : "Could not start the webcam test recording.");
    } finally {
      setTestBusy(false);
    }
  }

  return (
    <div className="webcam-card">
      <label className="setting-row">
        <span className="setting-copy">
          Webcam
          <small>Records as its own source so you can move it later.</small>
        </span>
        <input
          className="switch"
          type="checkbox"
          checked={webcam.enabled}
          onChange={(event) => {
            const enabled = event.target.checked;
            const nextId = webcam.deviceId || devices[0]?.id || "";
            const nextName = devices.find((device) => device.id === nextId)?.name || webcam.name;
            void patch({ enabled, deviceId: nextId, name: nextName });
          }}
        />
      </label>

      <div className="webcam-layout">
        <div className="stack">
          <div className="field">
            <label htmlFor="webcam-device">Device</label>
            <select
              id="webcam-device"
              value={deviceId}
              onChange={(event) => {
                const nextId = event.target.value;
                const nextName = devices.find((device) => device.id === nextId)?.name || webcam.name;
                void patch({ deviceId: nextId, name: nextName, enabled: webcam.enabled });
              }}
            >
              {devices.length === 0 ? <option value="">No camera connected</option> : null}
              {devices.length > 0 && !deviceId ? <option value="">Choose a camera</option> : null}
              {devices.map((device) => (
                <option key={device.id} value={device.id}>
                  {device.name}
                </option>
              ))}
            </select>
          </div>
          <WebcamPreview
            active={previewing && Boolean(deviceId) && modesReady && !testRecording && !instantReplayLive}
            deviceId={deviceId}
            width={webcam.width}
            height={webcam.height}
            fps={webcam.fps}
            mirror={webcam.mirrorPreview}
            disconnected={disconnected}
            message={status.message}
          />
        </div>

        <div className="stack">
          <div className="settings-fields webcam-fields">
            <CameraModePicker
              idPrefix="webcam"
              deviceId={deviceId}
              width={webcam.width}
              height={webcam.height}
              fps={webcam.fps}
              onChange={(mode) => void patch(mode)}
              onModesReady={setModesReady}
            />
          </div>
          <div className="field">
            <span className="settings-group-label">Default position</span>
            <div className="placement-grid" role="group" aria-label="Default webcam position">
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
          <label className="setting-row">
            <span>Default size</span>
            <span className="muted">{Math.round(webcam.defaultWidth * 100)}%</span>
          </label>
          <input
            type="range"
            min={12}
            max={40}
            value={Math.round(webcam.defaultWidth * 100)}
            onChange={(event) => void patch({ defaultWidth: Number(event.target.value) / 100 })}
          />
        </div>

        <div className="stack">
          <div className="field">
            <label htmlFor="webcam-name">Source name</label>
            <input
              id="webcam-name"
              value={webcam.name}
              maxLength={32}
              onChange={(event) => void patch({ name: event.target.value })}
            />
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
            <span className="setting-copy">
              Mirror preview
              <small>Does not change the stored recording.</small>
            </span>
            <input
              className="switch"
              type="checkbox"
              checked={webcam.mirrorPreview}
              onChange={(event) => void patch({ mirrorPreview: event.target.checked })}
            />
          </label>
          <label className="setting-row">
            <span className="setting-copy">
              Mirror recorded video
              <small>Off keeps the camera’s real orientation.</small>
            </span>
            <input
              className="switch"
              type="checkbox"
              checked={webcam.mirrorRecording}
              onChange={(event) => void patch({ mirrorRecording: event.target.checked })}
            />
          </label>
          <div className="webcam-lock">
            <div className="setting-copy">
              Record as separate source
              <small>Keeps your camera independent so you can move, resize, crop, or hide it later.</small>
            </div>
            <span className="lock-pill">On</span>
          </div>
          <div className="perf-card">
            <div className="settings-group-label">Performance impact</div>
            <strong>{impact}</strong>
            <p className="muted">
              Using {webcam.height}p · {webcam.fps} FPS
              <br />
              Estimated additional storage: ~{mbMin} MB/min
            </p>
          </div>
          <button
            type="button"
            className="btn ghost"
            disabled={!deviceId || testBusy || instantReplayLive || status.availability === "unsupported"}
            onClick={() => void runTestRecord()}
          >
            {testRecording
              ? "Stop test recording"
              : instantReplayLive
                ? "Recording with Instant Replay"
                : testBusy
                  ? "Starting…"
                  : "Test record 8s"}
          </button>
          <p className="muted">
            {instantReplayLive
              ? "Webcam is already rolling with Instant Replay. F10 saves it next to the gameplay clip."
              : "Writes a separate webcam MP4. Instant Replay is unchanged."}
          </p>
          {testRecording ? (
            <p className="muted">
              Writing a standalone webcam MP4
              {status.encoderName ? ` · ${status.encoderName}` : ""}
              {status.softwareFallback ? " · software encoder" : ""}
              {status.droppedFrames ? ` · dropped ${status.droppedFrames}` : ""}
            </p>
          ) : null}
          {instantReplayLive ? (
            <p className="muted">
              Instant Replay webcam buffer is live
              {status.encoderName ? ` · ${status.encoderName}` : ""}
              {status.softwareFallback ? " · software encoder" : ""}
              {status.droppedFrames ? ` · dropped ${status.droppedFrames}` : ""}
            </p>
          ) : null}
          {status.testPath && !testRecording ? <p className="muted">{status.testPath}</p> : null}
          {testError ? <p className="error-text">{testError}</p> : null}
          {status.message && (disconnected || status.availability === "unsupported") ? (
            <p className="error-text">{status.message}</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function estimateMb(width: number, height: number, fps: number): number {
  const bits = Math.min(10_000_000, Math.max(2_000_000, (width * height * fps) / 12));
  return Math.max(1, Math.round((bits * 60) / 8 / 1_000_000));
}
