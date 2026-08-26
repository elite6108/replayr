import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { DetectedGamePanel } from "../components/common/DetectedGamePanel";
import { PageHeader } from "../components/common/PageHeader";
import { IconRecord } from "../components/icons";
import { useDetectionStore } from "../stores/detectionStore";
import { useRecordingStore } from "../stores/recordingStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useToastStore } from "../stores/toastStore";
import { getCameraStatus } from "../services/tauri";
import { IDLE_CAMERA_STATUS, type CameraStatus } from "../types/camera";
import type { WebcamSettings } from "../types/settings";
import { displayHotkey } from "../utils/format";

export function RecordPage() {
  const snapshot = useDetectionStore((state) => state.snapshot);
  const settings = useSettingsStore((state) => state.settings);
  const status = useRecordingStore((state) => state.status);
  const replay = useRecordingStore((state) => state.replay);
  const busy = useRecordingStore((state) => state.busy);
  const start = useRecordingStore((state) => state.start);
  const stop = useRecordingStore((state) => state.stop);
  const saveClip = useRecordingStore((state) => state.saveClip);
  const update = useSettingsStore((state) => state.update);
  const showToast = useToastStore((state) => state.show);
  const [camera, setCamera] = useState<CameraStatus>(IDLE_CAMERA_STATUS);

  useEffect(() => {
    let cancelled = false;
    void getCameraStatus().then((next) => {
      if (!cancelled && next) setCamera(next);
    });
    const timer = window.setInterval(() => {
      void getCameraStatus().then((next) => {
        if (!cancelled && next) setCamera(next);
      });
    }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [settings.webcam.enabled, settings.webcam.deviceId]);

  function toggleMix(key: "gameAudioEnabled" | "discordAudioEnabled" | "systemAudioEnabled" | "micEnabled", next: boolean, on: string, off: string) {
    void update(key, next)
      .then(() => showToast(next ? on : off))
      .catch((caught) => showToast(caught instanceof Error ? caught.message : "Could not save that setting."));
  }

  return (
    <>
      <PageHeader
        title="Record"
        subtitle="Instant Replay keeps a rolling buffer. Start/stop writes a full session MP4."
      />
      <div className="grid cols-2">
        <DetectedGamePanel snapshot={snapshot} showControls={false} />
        <section className="panel stack text-center">
          <h2>Session</h2>
          <p className="muted">
            {settings.resolution} · {settings.fps} FPS · {settings.codec.toUpperCase()}
          </p>
          <button
            type="button"
            className={`record-orb ${status.active ? "live" : ""}`}
            disabled={busy}
            title={status.active ? "Stop recording" : "Start recording"}
            onClick={() => void (status.active ? stop() : start())}
          >
            <IconRecord size={28} />
          </button>
          <div className="muted">{status.active ? "Stop recording" : "Start recording"}</div>
          <div className="row" style={{ justifyContent: "center" }}>
            <button type="button" className="btn" disabled={busy || replay.saving || !replay.active} onClick={() => void saveClip()}>
              {replay.saving ? "Saving…" : "Save Clip"}
            </button>
          </div>
          {status.path ? <p className="muted">{status.path}</p> : null}
          <p className="muted">
            Save Replay is <kbd>{displayHotkey(settings.hotkeys.saveReplay)}</kbd>
          </p>
          <div className="mix-strip">
            <button
              type="button"
              className={`chip ${settings.gameAudioEnabled ? "on" : ""}`}
              onClick={() => toggleMix("gameAudioEnabled", !settings.gameAudioEnabled, "Game audio on", "Game audio off")}
            >
              Game
            </button>
            <button
              type="button"
              className={`chip ${settings.discordAudioEnabled ? "on" : ""}`}
              onClick={() => toggleMix("discordAudioEnabled", !settings.discordAudioEnabled, "Discord on", "Discord off")}
            >
              Discord
            </button>
            <button
              type="button"
              className={`chip ${settings.systemAudioEnabled ? "on" : ""}`}
              onClick={() => toggleMix("systemAudioEnabled", !settings.systemAudioEnabled, "Desktop on", "Desktop off")}
            >
              Desktop
            </button>
            <button
              type="button"
              className={`chip ${settings.micEnabled ? "on" : ""}`}
              onClick={() => toggleMix("micEnabled", !settings.micEnabled, "Microphone on", "Microphone off")}
            >
              Mic
            </button>
            <Link className="btn ghost" to="/settings?section=audio">
              Audio settings
            </Link>
          </div>
          <SourcesStatus
            gameName={snapshot.name ?? "Gameplay"}
            micEnabled={settings.micEnabled}
            webcam={settings.webcam}
            camera={camera}
          />
        </section>
      </div>
    </>
  );
}

function SourcesStatus({
  gameName,
  micEnabled,
  webcam,
  camera,
}: {
  gameName: string;
  micEnabled: boolean;
  webcam: WebcamSettings;
  camera: CameraStatus;
}) {
  const webcamOff = !webcam.enabled;
  const webcamName = webcam.name.trim() || camera.deviceName || "Webcam";
  const webcamBad =
    camera.availability === "disconnected" ||
    camera.availability === "permissionDenied" ||
    camera.availability === "failed";
  const webcamLabel = webcamOff ? "Off" : webcamBad ? "!" : camera.availability === "previewing" ? "Preview" : "On";
  return (
    <div className="sources-status">
      <div className="settings-group-label">Sources</div>
      <div className="source-status-row">
        <span>{gameName}</span>
        <span className="source-dot on">Active</span>
      </div>
      {micEnabled ? (
        <div className="source-status-row">
          <span>Microphone</span>
          <span className="source-dot on">Active</span>
        </div>
      ) : null}
      <div className={`source-status-row ${webcamBad ? "warn" : ""}`}>
        <span>
          {webcamName}
          {webcamBad ? <small>{camera.message || "Camera unavailable"}</small> : null}
        </span>
        <span className={`source-dot ${webcamOff ? "" : webcamBad ? "warn" : "on"}`}>
          {webcamLabel}
        </span>
      </div>
    </div>
  );
}
