import { Link } from "react-router-dom";
import { formatDb, formatPeakDb } from "../../../recording/useStudioAudio";
import type { RecordingSource } from "../../../recording/scene";
import { MicrophoneDeviceSelect } from "../../common/MicrophoneDeviceSelect";
import { StudioMeter } from "../StudioMeter";

export function AudioSourceSettings({
  source,
  peak,
  gain,
  deviceId,
  recording = false,
  onToggle,
  onGain,
  onDeviceId,
}: {
  source: RecordingSource;
  peak: number;
  gain?: number;
  deviceId?: string;
  recording?: boolean;
  onToggle: (enabled: boolean) => void;
  onGain?: (gain: number) => void;
  onDeviceId?: (deviceId: string) => void;
}) {
  const label =
    source.type === "microphone" ? "Microphone" : source.type === "gameAudio" ? "Game audio" : "Desktop audio";
  const level = Math.max(0, Math.min(1, peak));
  const isMic = source.type === "microphone";

  return (
    <div className="studio-section" style={{ borderTop: 0, paddingTop: 0 }}>
      <p className="muted">{label} is mixed into the session recording.</p>
      <label className="setting-row">
        <span>{source.enabled ? "Enabled" : "Muted"}</span>
        <input className="switch" type="checkbox" checked={source.enabled} onChange={(event) => onToggle(event.target.checked)} />
      </label>
      {isMic && onDeviceId && deviceId != null ? (
        <MicrophoneDeviceSelect
          id="record-mic-device"
          deviceId={deviceId}
          onDeviceId={onDeviceId}
          disabled={recording}
          disabledReason="Stop recording to change microphone."
        />
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
      <Link className="btn ghost sm" to="/settings?section=audio">
        Audio settings
      </Link>
    </div>
  );
}
