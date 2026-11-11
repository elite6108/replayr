import { useState } from "react";
import { BitrateChangeInfo } from "../common/BitrateChangeInfo";
import { CustomBitrateInput } from "../settings/CustomBitrateInput";
import type { AppSettings } from "../../types/settings";
import { useRecordingStore } from "../../stores/recordingStore";
import { RECORD_NEEDS_IR_OFF } from "../../recording/composition";
import type { StudioMode } from "../../recording/studioMode";
import { CaptureOutputFields } from "./sources/GameSourceSettings";
import { displayHotkey } from "../../utils/format";
import { formatBitrateEstimate } from "../../utils/recordingBitrate";
import { displayFps, QUALITY_OPTIONS, qualityLabel } from "../../utils/qualityLabels";
import { IrControlsCard } from "./IrControlsCard";
import outputMark from "../../assets/figma/capture/output.svg";
import chevronMark from "../../assets/figma/capture/chevron.svg";

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
      <div className="studio-block-head">
        <h2>Recording controls</h2>
      </div>
      <div className="capture-rec-head">
        <CaptureClock ms={recording ? status.durationMs : 0} />
        <span className={`capture-rec-state${status.error ? " is-error" : ""}`}>
          <i />
          {status.active ? "Recording" : status.error ? status.error : "Ready to record"}
        </span>
      </div>
      <button
        type="button"
        className={`capture-start${status.active ? " is-live" : ""}`}
        disabled={recording ? busy : !canStart}
        title={needsIrOff ? RECORD_NEEDS_IR_OFF : recording ? "Stop recording" : "Start recording"}
        onClick={() => void (recording ? stop() : start())}
      >
        <i className="capture-rec-dot" />
        <span>{recording ? "Stop Recording" : "Start Recording"}</span>
        <kbd>{displayHotkey(settings.hotkeys.toggleRecording).replaceAll(" + ", " ")}</kbd>
      </button>
      </>
      ) : (
        <p className="studio-clip-hint">
          Overlays, text, and images burn into the clip when you save. Webcam stays a separate track you can still move later.
        </p>
      )}

      <IrControlsCard
        settings={settings}
        onSave={onSave}
        composedRecording={composedRecording}
        capture={studio === "recording"}
        onTurnOff={needsIrOff ? () => onSave("instantReplayEnabled", false) : undefined}
      />
      {studio === "recording" ? (
        <div className="capture-output-row">
          <button
            type="button"
            className="capture-output-link"
            aria-expanded={outputOpen}
            onClick={() => setOutputOpen((open) => !open)}
          >
            <img src={outputMark} alt="" />
            Output settings
            <img src={chevronMark} alt="" />
          </button>
          <span>{outputChip(settings)}</span>
        </div>
      ) : null}
      {studio === "recording" && outputOpen ? (
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
    </section>
  );
}

function outputChip(settings: AppSettings) {
  const size =
    settings.resolution === "1440p"
      ? "1440p"
      : settings.resolution === "4k"
        ? "4K"
        : settings.resolution === "720p"
          ? "720p"
          : settings.resolution === "native"
            ? "Native"
            : "1080p";
  return `MP4 · ${size}${displayFps(settings.fps)} · ${qualityLabel(settings.bitrate)}`;
}

function CaptureClock({ ms }: { ms: number }) {
  const parts = formatRecClock(ms).split(":");
  return (
    <strong className="capture-clock">
      {parts.map((part, index) => (
        <span key={part + index}>
          {index > 0 ? (
            <span className="capture-colon" style={{ color: "#799cb4" }}>
              :
            </span>
          ) : null}
          {part}
        </span>
      ))}
    </strong>
  );
}

function formatRecClock(ms: number | null | undefined) {
  const total = Math.max(0, Math.floor((ms ?? 0) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
