import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import { DetectedGamePanel } from "../components/common/DetectedGamePanel";
import { PageHeader } from "../components/common/PageHeader";
import { IconRecord } from "../components/icons";
import { RecordingPreview } from "../components/recording/RecordingPreview";
import { RecordingVisualControls } from "../components/recording/RecordingVisualControls";
import { RecordingWebcamLayout } from "../components/recording/RecordingWebcamLayout";
import { useDetectionStore } from "../stores/detectionStore";
import { useRecordingStore } from "../stores/recordingStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useToastStore } from "../stores/toastStore";
import { getCameraStatus } from "../services/tauri";
import { IDLE_CAMERA_STATUS, type CameraStatus } from "../types/camera";
import type { AppSettings, RecordingVisualSettings, WebcamSettings } from "../types/settings";
import { DEFAULT_RECORDING_VISUALS, DEFAULT_WEBCAM_SETTINGS } from "../types/settings";
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
  const patch = useSettingsStore((state) => state.patch);
  const showToast = useToastStore((state) => state.show);
  const [camera, setCamera] = useState<CameraStatus>(IDLE_CAMERA_STATUS);
  const quiet = status.active || replay.active || camera.rolling || camera.recording;

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void getCameraStatus().then((next) => {
      if (!cancelled && next) setCamera(next);
    });
    void listen<{ status: CameraStatus }>("camera-status", (event) => {
      if (event.payload?.status) setCamera(event.payload.status);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [settings.webcam.enabled, settings.webcam.deviceId, replay.active, status.active]);

  function save<K extends keyof AppSettings>(key: K, value: AppSettings[K], ok?: string) {
    void update(key, value)
      .then(() => {
        if (ok) showToast(ok);
      })
      .catch((caught) => showToast(caught instanceof Error ? caught.message : "Could not save that setting."));
  }

  function toggleMix(key: "gameAudioEnabled" | "discordAudioEnabled" | "systemAudioEnabled" | "micEnabled", next: boolean, on: string, off: string) {
    save(key, next, next ? on : off);
  }

  async function saveWebcam(next: WebcamSettings) {
    try {
      await update("webcam", next);
    } catch (caught) {
      showToast(caught instanceof Error ? caught.message : "Could not save webcam settings.");
    }
  }

  async function saveVisuals(next: RecordingVisualSettings) {
    try {
      await update("recordingVisuals", next);
    } catch (caught) {
      showToast(caught instanceof Error ? caught.message : "Could not save visual settings.");
    }
  }

  function resetPreviewLayout() {
    void patch({
      webcam: {
        ...settings.webcam,
        defaultPlacement: DEFAULT_WEBCAM_SETTINGS.defaultPlacement,
        defaultShape: DEFAULT_WEBCAM_SETTINGS.defaultShape,
        defaultWidth: DEFAULT_WEBCAM_SETTINGS.defaultWidth,
      },
      recordingVisuals: {
        ...DEFAULT_RECORDING_VISUALS,
        overlays: { ...DEFAULT_RECORDING_VISUALS.overlays },
      },
    })
      .then(() => showToast("Preview layout reset"))
      .catch((caught) => showToast(caught instanceof Error ? caught.message : "Could not reset preview layout."));
  }

  return (
    <>
      <PageHeader
        title="Record"
        subtitle="Compose the recording preview. Instant Replay keeps a rolling buffer. Start/stop writes a full session MP4."
      />
      <div className="record-workspace">
        <div className="record-controls stack">
          <section className="panel stack">
            <h2>Capture</h2>
            <DetectedGamePanel snapshot={snapshot} showControls={false} />
            <p className="muted">
              {settings.resolution} · {settings.fps} FPS · {settings.codec.toUpperCase()}
            </p>
            <div className="settings-fields">
              <div className="field">
                <label htmlFor="record-resolution">Resolution</label>
                <select
                  id="record-resolution"
                  value={settings.resolution}
                  onChange={(event) => save("resolution", event.target.value as AppSettings["resolution"])}
                >
                  <option value="native">Native</option>
                  <option value="1080p">1080p</option>
                  <option value="720p">720p</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="record-fps">FPS</label>
                <select
                  id="record-fps"
                  value={settings.fps}
                  onChange={(event) => save("fps", Number(event.target.value) as AppSettings["fps"])}
                >
                  <option value={30}>30</option>
                  <option value={60}>60</option>
                  <option value={120}>120</option>
                </select>
              </div>
            </div>
            <div className="record-session">
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
              {status.path ? <p className="muted">{status.path}</p> : null}
            </div>
          </section>

          <section className="panel stack">
            <h2>Instant Replay</h2>
            <label className="setting-row">
              <span>Instant Replay</span>
              <input
                className="switch"
                type="checkbox"
                checked={settings.instantReplayEnabled}
                onChange={(event) => save("instantReplayEnabled", event.target.checked)}
              />
            </label>
            <div className="field">
              <label htmlFor="record-replay-length">Length</label>
              <select
                id="record-replay-length"
                value={settings.replayDurationSeconds}
                onChange={(event) =>
                  save("replayDurationSeconds", Number(event.target.value) as AppSettings["replayDurationSeconds"])
                }
              >
                <option value={15}>15 seconds</option>
                <option value={30}>30 seconds</option>
                <option value={45}>45 seconds</option>
                <option value={60}>60 seconds</option>
                <option value={90}>90 seconds</option>
                <option value={120}>2 minutes</option>
                <option value={180}>3 minutes</option>
                <option value={300}>5 minutes</option>
              </select>
            </div>
            <div className="row">
              <button type="button" className="btn" disabled={busy || replay.saving || !replay.active} onClick={() => void saveClip()}>
                {replay.saving ? "Saving…" : "Save Clip"}
              </button>
            </div>
            <p className="muted">
              Save Replay is <kbd>{displayHotkey(settings.hotkeys.saveReplay)}</kbd>
            </p>
          </section>

          <section className="panel stack">
            <h2>Audio</h2>
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
            </div>
            <Link className="btn ghost" to="/settings?section=audio">
              Audio settings
            </Link>
          </section>

          <section className="panel stack">
            <h2>Webcam</h2>
            <RecordingWebcamLayout webcam={settings.webcam} camera={camera} onChange={saveWebcam} />
          </section>

          <section className="panel stack">
            <h2>Visuals</h2>
            <RecordingVisualControls visuals={settings.recordingVisuals} onChange={saveVisuals} />
            <button type="button" className="btn ghost" onClick={resetPreviewLayout}>
              Reset Preview Layout
            </button>
          </section>
        </div>

        <RecordingPreview
          webcam={settings.webcam}
          visuals={settings.recordingVisuals}
          camera={camera}
          quiet={quiet}
        />
      </div>
    </>
  );
}
