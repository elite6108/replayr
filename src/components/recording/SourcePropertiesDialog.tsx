import type { AppSettings } from "../../types/settings";
import type { RecordingSource } from "../../recording/scene";
import type { DisplayInfo } from "../../recording/display/displayTypes";
import { formatDb } from "../../recording/useStudioAudio";
import { MicrophoneDeviceSelect } from "../common/MicrophoneDeviceSelect";
import { DisplaySourceSettings } from "./sources/DisplaySourceSettings";

export function SourcePropertiesDialog({
  source,
  settings,
  displays,
  listError = null,
  recording,
  onMonitorId,
  onSaveSetting,
  onClose,
}: {
  source: RecordingSource;
  settings: AppSettings;
  displays: DisplayInfo[];
  listError?: string | null;
  recording: boolean;
  onMonitorId: (monitorId: string | null) => void;
  onSaveSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  onClose: () => void;
}) {
  const title =
    source.type === "microphone"
      ? "Microphone Properties"
      : source.type === "desktopAudio"
        ? "Desktop Audio Properties"
        : source.type === "gameAudio"
          ? "Game Audio Properties"
          : source.type === "display"
            ? source.name
            : `${source.name} Properties`;

  return (
    <div className="studio-modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="studio-modal"
        role="dialog"
        aria-labelledby="source-properties-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="studio-block-head">
          <h2 id="source-properties-title">{title}</h2>
          <button type="button" className="studio-icon-btn" onClick={onClose}>
            Close
          </button>
        </div>
        {source.type === "display" ? (
          <DisplaySourceSettings
            source={source}
            displays={displays}
            listError={listError}
            recording={recording}
            onMonitorId={onMonitorId}
          />
        ) : source.type === "microphone" ? (
          <div className="stack">
            <MicrophoneDeviceSelect
              id="mic-properties-device"
              deviceId={settings.microphoneId}
              onDeviceId={(deviceId) => onSaveSetting("microphoneId", deviceId)}
              disabled={recording}
              disabledReason="Stop recording to change microphone."
            />
            <GainField
              id="mic-properties-gain"
              gain={settings.micGain}
              disabled={!source.enabled}
              onGain={(gain) => onSaveSetting("micGain", gain)}
            />
          </div>
        ) : source.type === "desktopAudio" ? (
          <div className="stack">
            <p className="muted">Full speaker mix. Gain applies to Desktop Audio in the session mix.</p>
            <GainField
              id="desktop-properties-gain"
              gain={settings.systemAudioGain}
              disabled={!source.enabled}
              onGain={(gain) => onSaveSetting("systemAudioGain", gain)}
            />
          </div>
        ) : source.type === "gameAudio" ? (
          <div className="stack">
            <p className="muted">Isolated game process audio. Gain applies when Game Audio is enabled.</p>
            <GainField
              id="game-properties-gain"
              gain={settings.gameAudioGain}
              disabled={!source.enabled}
              onGain={(gain) => onSaveSetting("gameAudioGain", gain)}
            />
          </div>
        ) : (
          <p className="studio-empty">No extra properties for this source.</p>
        )}
      </div>
    </div>
  );
}

function GainField({
  id,
  gain,
  disabled,
  onGain,
}: {
  id: string;
  gain: number;
  disabled?: boolean;
  onGain: (gain: number) => void;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>Gain ({formatDb(gain)})</label>
      <input
        id={id}
        type="range"
        min={0}
        max={200}
        step={1}
        disabled={disabled}
        value={Math.round(gain * 100)}
        onChange={(event) => onGain(Number(event.target.value) / 100)}
      />
    </div>
  );
}
