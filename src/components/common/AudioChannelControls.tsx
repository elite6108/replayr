import type { AudioChannelMode } from "../../types/settings";
import { parseAudioChannelMode } from "../../types/settings";

const CHANNEL_MODE_OPTIONS: { value: AudioChannelMode; label: string }[] = [
  { value: "auto", label: "Auto (Recommended)" },
  { value: "mono", label: "Mono" },
  { value: "stereo", label: "Stereo" },
];

export function AudioChannelControls({
  idPrefix,
  channelMode,
  pan,
  panLabel = "Pan",
  onChannelMode,
  onPan,
}: {
  idPrefix: string;
  channelMode: AudioChannelMode;
  pan: number;
  panLabel?: string;
  onChannelMode: (mode: AudioChannelMode) => void;
  onPan: (pan: number) => void;
}) {
  const mode = parseAudioChannelMode(channelMode);
  const panValue = Number.isFinite(pan) ? Math.max(-1, Math.min(1, pan)) : 0;
  const panPct = Math.round(((panValue + 1) / 2) * 100);

  return (
    <>
      <div className="field">
        <label htmlFor={`${idPrefix}-channel-mode`}>Channel Mode</label>
        <select
          id={`${idPrefix}-channel-mode`}
          value={mode}
          onChange={(event) => onChannelMode(parseAudioChannelMode(event.target.value))}
        >
          {CHANNEL_MODE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <details className="studio-fold">
        <summary>Advanced</summary>
        <div className="field">
          <label htmlFor={`${idPrefix}-pan`}>
            {panLabel} {panValue === 0 ? "(Center)" : panValue < 0 ? "(Left)" : "(Right)"}
          </label>
          <div className="row" style={{ gap: "0.5rem", alignItems: "center" }}>
            <span className="muted">L</span>
            <input
              id={`${idPrefix}-pan`}
              type="range"
              min={0}
              max={100}
              step={1}
              value={panPct}
              onChange={(event) => onPan(Number(event.target.value) / 50 - 1)}
              style={{ flex: 1 }}
            />
            <span className="muted">R</span>
          </div>
        </div>
      </details>
    </>
  );
}
