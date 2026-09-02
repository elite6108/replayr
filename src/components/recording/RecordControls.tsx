import { useState } from "react";
import { IconGear, IconRecord } from "../icons";
import type { AppSettings } from "../../types/settings";
import { displayHotkey, formatDuration } from "../../utils/format";
import { useRecordingStore } from "../../stores/recordingStore";
import type { RecordingOutputMode } from "../../recording/scene";
import { CaptureOutputFields } from "./sources/GameSourceSettings";

export function RecordControls({
  settings,
  outputMode,
  onOutputMode,
  onSave,
}: {
  settings: AppSettings;
  outputMode: RecordingOutputMode;
  onOutputMode: (mode: RecordingOutputMode) => void;
  onSave: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
}) {
  const status = useRecordingStore((state) => state.status);
  const replay = useRecordingStore((state) => state.replay);
  const busy = useRecordingStore((state) => state.busy);
  const startingComposed = useRecordingStore((state) => state.startingComposed);
  const start = useRecordingStore((state) => state.start);
  const stop = useRecordingStore((state) => state.stop);
  const saveClip = useRecordingStore((state) => state.saveClip);
  const [outputOpen, setOutputOpen] = useState(false);
  const composedRecording = (status.active && status.composed) || startingComposed;
  const composedNeedsIrOff = outputMode === "composed" && settings.instantReplayEnabled;
  const canStart = !busy && !composedNeedsIrOff;

  return (
    <section className="studio-panel studio-controls">
      <div className="studio-record-card">
        <button
          type="button"
          className={`record-orb ${status.active ? "live" : ""}`}
          disabled={status.active || composedRecording ? busy : !canStart}
          title={
            composedNeedsIrOff
              ? "Turn off Instant Replay to use Composed Recording."
              : status.active || composedRecording
                ? "Stop recording"
                : "Start recording"
          }
          onClick={() => void (status.active || composedRecording ? stop() : start())}
        >
          <IconRecord size={30} />
        </button>
        <div className="studio-record-copy">
          {status.active ? (
            <>
              <strong className="studio-rec-clock">REC {formatRecClock(status.durationMs)}</strong>
              <button type="button" className="btn danger sm" disabled={busy} onClick={() => void stop()}>
                Stop Recording
              </button>
            </>
          ) : (
            <>
              <strong>Start Recording</strong>
              <p>Start a new recording session</p>
            </>
          )}
        </div>
        <button type="button" className="studio-icon-btn studio-output-gear" title="Recording output" onClick={() => setOutputOpen((open) => !open)}>
          <IconGear size={16} />
        </button>
      </div>
      {outputOpen ? (
        <div className="studio-output-pop">
          <div className="field">
            <label htmlFor="record-output-mode">Session output</label>
            <select
              id="record-output-mode"
              value={outputMode}
              disabled={status.active || composedRecording}
              onChange={(event) => onOutputMode(event.target.value === "composed" ? "composed" : "legacy")}
            >
              <option value="legacy">Legacy (gameplay + optional webcam sidecar)</option>
              <option value="composed">Composed (matches Recording Layout Preview)</option>
            </select>
          </div>
          {composedNeedsIrOff ? (
            <p className="studio-output-hint studio-output-warn">
              Turn off Instant Replay to use Composed Recording.
            </p>
          ) : null}
          {outputMode === "composed" ? (
            <p className="studio-output-hint">
              Game, desktop, webcam, images, text, and Replayr overlays are baked into one MP4.
            </p>
          ) : (
            <p className="studio-output-hint">
              Session recordings follow the webcam box in this preview. Instant Replay clips still use the clip webcam corner in Settings.
            </p>
          )}
          <CaptureOutputFields settings={settings} onSave={onSave} disabled={composedRecording} />
          <div className="field">
            <label htmlFor="record-quality">Quality</label>
            <select
              id="record-quality"
              value={settings.bitrate}
              disabled={composedRecording}
              onChange={(event) => onSave("bitrate", event.target.value as AppSettings["bitrate"])}
            >
              <option value="low">Low</option>
              <option value="medium">High Quality</option>
              <option value="high">Maximum</option>
              <option value="custom">Custom</option>
            </select>
          </div>
        </div>
      ) : null}

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
          <button type="button" className="btn sm" disabled={busy || replay.saving || !replay.active} onClick={() => void saveClip()}>
            {replay.saving ? "Saving…" : "Save Clip"}
          </button>
          <kbd>{displayHotkey(settings.hotkeys.saveReplay)}</kbd>
          <span className="studio-ir-buf">{formatDuration(replay.bufferedMs)} buffered</span>
        </div>
      </div>
    </section>
  );
}

function formatRecClock(ms: number | null | undefined) {
  const total = Math.max(0, Math.floor((ms ?? 0) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
