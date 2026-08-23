import { Link } from "react-router-dom";
import { DetectedGamePanel } from "../components/common/DetectedGamePanel";
import { PageHeader } from "../components/common/PageHeader";
import { IconRecord } from "../components/icons";
import { useDetectionStore } from "../stores/detectionStore";
import { useRecordingStore } from "../stores/recordingStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useToastStore } from "../stores/toastStore";
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
            <Link className="btn ghost" to="/settings">
              Audio settings
            </Link>
          </div>
        </section>
      </div>
    </>
  );
}
