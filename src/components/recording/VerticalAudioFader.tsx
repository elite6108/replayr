import { METER_MAX_DB, METER_MIN_DB } from "../../recording/useStudioAudio";

function gainToFaderDb(gain: number): number {
  if (!(gain > 0)) return METER_MIN_DB;
  return Math.min(METER_MAX_DB, Math.max(METER_MIN_DB, 20 * Math.log10(gain)));
}

function faderDbToGain(db: number): number {
  if (db <= METER_MIN_DB) return 0;
  return Math.min(2, 10 ** (db / 20));
}

/** Vertical volume fader on the same dB scale as the meter beside it (bottom is silence). */
export function VerticalAudioFader({
  label,
  gain,
  disabled,
  onGain,
}: {
  label: string;
  gain: number;
  disabled?: boolean;
  onGain: (gain: number) => void;
}) {
  return (
    <div className="studio-mix-fader">
      <input
        type="range"
        className="studio-mix-fader-input"
        min={METER_MIN_DB}
        max={METER_MAX_DB}
        step="any"
        disabled={disabled}
        aria-label={label}
        value={gainToFaderDb(gain)}
        onChange={(event) => onGain(faderDbToGain(Number(event.target.value)))}
      />
    </div>
  );
}
