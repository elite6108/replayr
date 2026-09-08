import { Link } from "react-router-dom";
import { formatDb, formatPeakDb } from "../../../recording/useStudioAudio";
import type { RecordingSource } from "../../../recording/scene";
import type { AudioChannelMode } from "../../../types/settings";
import { AudioChannelControls } from "../../common/AudioChannelControls";
import { MicrophoneDeviceSelect } from "../../common/MicrophoneDeviceSelect";
import { StudioMeter } from "../StudioMeter";

export function AudioSourceSettings({
  source,
  peak,
  gain,
  deviceId,
  channelMode,
  pan,
  recording = false,
  onToggle,
  onGain,
  onDeviceId,
  onChannelMode,
  onPan,
}: {
  source: RecordingSource;
  peak: number;
  gain?: number;
  deviceId?: string;
  channelMode: AudioChannelMode;
  pan: number;
  recording?: boolean;
  onToggle: (enabled: boolean) => void;
  onGain?: (gain: number) => void;
  onDeviceId?: (deviceId: string) => void;
  onChannelMode: (mode: AudioChannelMode) => void;
  onPan: (pan: number) => void;
}) {
  const label =
    source.type === "microphone" ? "MICROPHONE" : source.type === "gameAudio" ? "GAME AUDIO" : "DESKTOP AUDIO";
  const level = Math.max(0, Math.min(1, peak));
  const isMic = source.type === "microphone";
  const panLabel = isMic ? "Pan" : "Balance / Pan";

  return (
    <div className="studio-section" style={{ borderTop: 0, paddingTop: 0 }}>
      <h3 style={{ margin: "0 0 0.75rem", fontSize: "0.75rem", letterSpacing: "0.06em" }}>{label}</h3>
      <p className="muted">{isMic ? "Microphone is mixed into the session recording." : `${label} is mixed into the session recording.`}</p>
      <label className="setting-row">
        <span>{source.enabled ? "Enabled" : "Muted"}</span>
        <input className="switch" type="checkbox" checked={source.enabled} onChange={(event) => onToggle(event.target.checked)} />
      </label>
      {isMic && onDeviceId && deviceId != null ? (
        <>
          <p className="muted" style={{ marginBottom: "0.25rem", fontSize: "0.75rem", letterSpacing: "0.04em" }}>
            DEVICE
          </p>
          <MicrophoneDeviceSelect
            id="record-mic-device"
            deviceId={deviceId}
            onDeviceId={onDeviceId}
            disabled={recording}
            disabledReason="Stop recording to change microphone."
          />
        </>
      ) : null}
      <div className="studio-audio-inspect">
        <span>{onGain && source.enabled ? formatDb(gain ?? 1) : source.enabled ? formatPeakDb(peak) : "Muted"}</span>
        <StudioMeter level={level} />
      </div>
      {onGain ? (
        <div className="field">
          <label htmlFor="record-audio-gain">Gain</label>
          <input
            id="record-audio-gain"
            type="range"
            min={0}
            max={200}
            step={1}
            disabled={!source.enabled}
            value={Math.round((gain ?? 1) * 100)}
            onChange={(event) => onGain(Number(event.target.value) / 100)}
          />
        </div>
      ) : null}
      <p className="muted" style={{ marginBottom: "0.25rem", fontSize: "0.75rem", letterSpacing: "0.04em" }}>
        CHANNELS
      </p>
      <AudioChannelControls
        idPrefix={`record-${source.type}`}
        channelMode={channelMode}
        pan={pan}
        panLabel={panLabel}
        onChannelMode={onChannelMode}
        onPan={onPan}
      />
      <Link className="btn ghost sm" to="/settings?section=audio">
        Audio settings
      </Link>
    </div>
  );
}
