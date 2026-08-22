import { DetectedGamePanel } from "../components/common/DetectedGamePanel";
import { PageHeader } from "../components/common/PageHeader";
import { IconRecord } from "../components/icons";
import { useDetectionStore } from "../stores/detectionStore";
import { useRecordingStore } from "../stores/recordingStore";
import { useSettingsStore } from "../stores/settingsStore";
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
        </section>
      </div>
    </>
  );
}
