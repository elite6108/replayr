import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCameraStatus } from "../../services/tauri";
import type { CameraStatus } from "../../types/camera";
import { IDLE_CAMERA_STATUS } from "../../types/camera";
import type { AppSettings, WebcamSettings } from "../../types/settings";
import { WebcamSourceCard } from "./WebcamSourceCard";

interface RecordingSourcesProps {
  settings: AppSettings;
  previewing: boolean;
  onWebcamChange: (webcam: WebcamSettings) => Promise<void>;
}

export function RecordingSources({ settings, previewing, onWebcamChange }: RecordingSourcesProps) {
  const [status, setStatus] = useState<CameraStatus>(IDLE_CAMERA_STATUS);
  const [chooser, setChooser] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getCameraStatus().then((next) => {
      if (!cancelled && next) setStatus(next);
    });
    let unlisten: (() => void) | undefined;
    void listen<{ status: CameraStatus }>("camera-status", (event) => {
      if (event.payload?.status) setStatus(event.payload.status);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [settings.webcam.enabled, settings.webcam.deviceId]);

  return (
    <div className="settings-group recording-sources">
      <div className="settings-group-label">Recording sources</div>
      <div className="source-row">
        <span className="setting-copy">
          Gameplay
          <small>Game / window capture</small>
        </span>
        <span className="source-dot on" title="Active">
          Active
        </span>
      </div>
      <WebcamSourceCard
        webcam={settings.webcam}
        status={status}
        previewing={previewing}
        onChange={onWebcamChange}
      />
      <button type="button" className="btn ghost source-add" onClick={() => setChooser((open) => !open)}>
        + Add Source
      </button>
      {chooser ? (
        <div className="source-chooser">
          <button
            type="button"
            className="source-choice"
            onClick={() => {
              setChooser(false);
              document.getElementById("webcam-device")?.focus();
            }}
          >
            <strong>Webcam</strong>
            <span>Capture a connected camera as an editable source.</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
