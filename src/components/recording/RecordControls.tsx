import { useState } from "react";
import { BitrateChangeInfo } from "../common/BitrateChangeInfo";
import { CustomBitrateInput } from "../settings/CustomBitrateInput";
import { IconGear, IconRecord } from "../icons";
import type { AppSettings } from "../../types/settings";
import { useRecordingStore } from "../../stores/recordingStore";
import { RECORD_NEEDS_IR_OFF } from "../../recording/composition";
import type { StudioMode } from "../../recording/studioMode";
import { CaptureOutputFields } from "./sources/GameSourceSettings";
import { formatBitrateEstimate } from "../../utils/recordingBitrate";
import { QUALITY_OPTIONS } from "../../utils/qualityLabels";
import { IrControlsCard } from "./IrControlsCard";

export function RecordControls({
  settings,
  onSave,
  studio = "recording",
}: {
  settings: AppSettings;
  onSave: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  studio?: StudioMode;
}) {
  const status = useRecordingStore((state) => state.status);
  const busy = useRecordingStore((state) => state.busy);
  const startingComposed = useRecordingStore((state) => state.startingComposed);
  const start = useRecordingStore((state) => state.start);
  const stop = useRecordingStore((state) => state.stop);
  const [outputOpen, setOutputOpen] = useState(false);
  const recording = status.active || startingComposed;
  const composedRecording = (status.active && status.composed) || startingComposed;
  const needsIrOff = !recording && settings.instantReplayEnabled;
  const canStart = !busy && !needsIrOff;

  return (
    <section className="studio-panel studio-controls">
      {studio === "recording" ? (
      <>
      <div className="studio-record-card">
        <button
          type="button"
          className={`record-orb ${status.active ? "live" : ""}`}
          disabled={recording ? busy : !canStart}
          title={needsIrOff ? RECORD_NEEDS_IR_OFF : recording ? "Stop recording" : "Start recording"}
          onClick={() => void (recording ? stop() : start())}
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
          ) : needsIrOff ? (
            <>
              <strong>Start Recording</strong>
              <p>Instant Replay is on. Recording and Instant Replay cannot run at the same time.</p>
              <button
                type="button"
                className="btn sm"
                onClick={() => onSave("instantReplayEnabled", false)}
              >
                Turn off Instant Replay
              </button>
            </>
          ) : (
            <>
              <strong>Start Recording</strong>
              <p>{status.error ? status.error : "Records this layout to one MP4"}</p>
            </>
          )}
        </div>
        <button
          type="button"
          className="studio-icon-btn studio-output-gear"
          title="Recording output"
          aria-expanded={outputOpen}
          onClick={() => setOutputOpen((open) => !open)}
        >
          <IconGear size={16} />
          <span>Output</span>
        </button>
      </div>
      {outputOpen ? (
        <div className="studio-output-pop">
          <p className="studio-output-hint">
            Game, desktop, webcam, images, text, and Replayr overlays are recorded into one MP4, exactly as the preview shows.
          </p>
          <CaptureOutputFields settings={settings} onSave={onSave} disabled={recording} />
          <div className="field">
            <label htmlFor="record-quality">Quality</label>
            <BitrateChangeInfo />
            <select
              id="record-quality"
              value={settings.bitrate}
              disabled={recording}
              onChange={(event) => onSave("bitrate", event.target.value as AppSettings["bitrate"])}
            >
              {QUALITY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <p className="muted" style={{ marginTop: 6 }}>
              {formatBitrateEstimate(settings)}
            </p>
            {settings.bitrate === "custom" ? (
              <div className="field" style={{ marginTop: 8 }}>
                <label htmlFor="custom-bitrate">Custom bitrate (kbps)</label>
                <CustomBitrateInput
                  value={settings.customBitrateKbps}
                  onSave={(value) => onSave("customBitrateKbps", value)}
                />
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
      </>
      ) : (
        <p className="studio-clip-hint">
          Overlays, text, and images burn into the clip when you save. Webcam stays a separate track you can still move later.
        </p>
      )}

      <IrControlsCard settings={settings} onSave={onSave} composedRecording={composedRecording} />
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
