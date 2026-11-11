import type { AppSettings } from "../../types/settings";
import { displayHotkey, formatDuration } from "../../utils/format";
import { useRecordingStore } from "../../stores/recordingStore";
import replayMark from "../../assets/figma/capture/replay.svg";
import saveClipMark from "../../assets/figma/capture/save-clip.svg";
import hintMark from "../../assets/figma/capture/hint.svg";

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
  capture = false,
  onTurnOff,
  onBeforeSaveClip,
}: {
  settings: AppSettings;
  onSave: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  composedRecording?: boolean;
  capture?: boolean;
  onTurnOff?: () => void;
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
  const bufferCap = Math.max(1, settings.replayDurationSeconds * 1000);
  const bufferPct = Math.max(0, Math.min(100, (replay.bufferedMs / bufferCap) * 100));
  const save = () => {
    void (async () => {
      await onBeforeSaveClip?.();
      await saveClip();
    })();
  };
  const clipHotkey = displayHotkey(settings.hotkeys.saveReplay).replaceAll(" + ", " ");

  if (capture) {
    return (
      <div className="studio-ir is-capture">
        <div className="capture-ir-line">
          <span className="capture-ir-name">
            <img src={replayMark} alt="" />
            <strong>Instant Replay</strong>
            <span className={`studio-ir-state${settings.instantReplayEnabled ? " is-on" : ""}`}>
              {settings.instantReplayEnabled ? "ON" : "OFF"}
            </span>
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
          </span>
          <label className="capture-ir-buffer">
            Buffer
            <select
              aria-label="Instant Replay length"
              value={settings.replayDurationSeconds}
              onChange={(event) =>
                onSave("replayDurationSeconds", Number(event.target.value) as AppSettings["replayDurationSeconds"])
              }
            >
              <option value={15}>15 sec</option>
              <option value={30}>30 sec</option>
              <option value={45}>45 sec</option>
              <option value={60}>1 min</option>
              <option value={90}>90 sec</option>
              <option value={120}>2 min</option>
              <option value={180}>3 min</option>
              <option value={300}>5 min</option>
            </select>
          </label>
        </div>
        <div className="studio-ir-hint">
          <img src={hintMark} alt="" />
          <span>Available during an active recording.</span>
          {onTurnOff ? (
            <button type="button" className="capture-ir-turnoff" onClick={onTurnOff}>
              Turn off Instant Replay
            </button>
          ) : null}
        </div>
        <div className="capture-ir-save">
          <button type="button" disabled={busy || replay.saving || !replay.active} onClick={save}>
            <img src={saveClipMark} alt="" />
            {replay.saving ? "Saving…" : "Save Clip"}
            <kbd>{clipHotkey}</kbd>
          </button>
          <div className="capture-ir-buf">
            <div>
              <span>Buffered</span>
              <strong>
                {clock(replay.bufferedMs)} / {clock(bufferCap)}
              </strong>
            </div>
            <div className="studio-ir-meter" aria-hidden="true">
              <span style={{ width: `${bufferPct}%` }} />
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="studio-ir">
      <div className="studio-ir-head">
        <strong>Instant Replay</strong>
        <span className={`studio-ir-state${settings.instantReplayEnabled ? " is-on" : ""}`}>
          {settings.instantReplayEnabled ? "ON" : "OFF"}
        </span>
        <span className="studio-ir-label">Buffer</span>
        <select
          aria-label="Instant Replay length"
          value={settings.replayDurationSeconds}
          onChange={(event) =>
            onSave("replayDurationSeconds", Number(event.target.value) as AppSettings["replayDurationSeconds"])
          }
        >
          <option value={15}>15 sec</option>
          <option value={30}>30 sec</option>
          <option value={45}>45 sec</option>
          <option value={60}>1 min</option>
          <option value={90}>90 sec</option>
          <option value={120}>2 min</option>
          <option value={180}>3 min</option>
          <option value={300}>5 min</option>
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
      <p className="studio-ir-hint">Available during an active recording.</p>
      <div className="studio-ir-meter" aria-hidden="true">
        <span style={{ width: `${bufferPct}%` }} />
      </div>
      <p className="studio-ir-scale">
        <span>{clock(replay.bufferedMs)}</span>
        <span>{clock(bufferCap)}</span>
      </p>
    </div>
  );
}

function clock(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
