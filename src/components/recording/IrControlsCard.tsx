import type { AppSettings } from "../../types/settings";
import { displayHotkey, formatDuration } from "../../utils/format";
import { useRecordingStore } from "../../stores/recordingStore";

/**
 * Instant Replay enable, buffer length, and Save Clip.
 *
 * Shared by both Record docks so the copy and the disabled-state rules live in one place. These
 * three settings are genuinely global — they *are* in `CAPTURE_KEYS`, so changing them restarts
 * the buffer, which is the correct behaviour for them and is why they do not go through the clip
 * studio's settings fence.
 */
export function IrControlsCard({
  settings,
  onSave,
  composedRecording = false,
  onBeforeSaveClip,
}: {
  settings: AppSettings;
  onSave: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  composedRecording?: boolean;
  /**
   * Run before Save Clip reaches Rust. The Clips tab uses this to flush its debounced scene
   * write, so an overlay added a moment ago is already on the settings document when
   * `stage_clip` reads it.
   */
  onBeforeSaveClip?: () => Promise<void> | void;
}) {
  const replay = useRecordingStore((state) => state.replay);
  const busy = useRecordingStore((state) => state.busy);
  const saveClip = useRecordingStore((state) => state.saveClip);

  return (
    <div className="studio-ir">
      <div className="studio-ir-head">
        <strong>Instant Replay</strong>
        <span className={`studio-ir-state${settings.instantReplayEnabled ? " is-on" : ""}`}>
          {settings.instantReplayEnabled ? "ON" : "OFF"}
        </span>
        <select
          aria-label="Instant Replay length"
          value={settings.replayDurationSeconds}
          onChange={(event) =>
            onSave("replayDurationSeconds", Number(event.target.value) as AppSettings["replayDurationSeconds"])
          }
        >
          <option value={15}>15 sec buffer</option>
          <option value={30}>30 sec buffer</option>
          <option value={45}>45 sec buffer</option>
          <option value={60}>1 min buffer</option>
          <option value={90}>90 sec buffer</option>
          <option value={120}>2 min buffer</option>
          <option value={180}>3 min buffer</option>
          <option value={300}>5 min buffer</option>
        </select>
        <label className="studio-switch">
          <span className="visually-hidden">Instant Replay</span>
          <input
            className="switch"
            type="checkbox"
            checked={settings.instantReplayEnabled}
            disabled={composedRecording}
            title={composedRecording ? "Stop composed recording before enabling Instant Replay." : undefined}
            onChange={(event) => {
              if (composedRecording && event.target.checked) return;
              onSave("instantReplayEnabled", event.target.checked);
            }}
          />
        </label>
      </div>
      <div className="studio-ir-row">
        <button
          type="button"
          className="btn primary sm"
          disabled={busy || replay.saving || !replay.active}
          onClick={() => {
            void (async () => {
              await onBeforeSaveClip?.();
              await saveClip();
            })();
          }}
        >
          {replay.saving ? "Saving…" : "Save Clip"}
        </button>
        <kbd>{displayHotkey(settings.hotkeys.saveReplay)}</kbd>
        <span className="studio-ir-buf">{formatDuration(replay.bufferedMs)} buffered</span>
      </div>
    </div>
  );
}
