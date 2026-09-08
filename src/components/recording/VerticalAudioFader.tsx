/** Vertical volume fader (0–200% linear gain mapped from settings). */
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
        min={0}
        max={200}
        step={1}
        disabled={disabled}
        aria-label={label}
        value={Math.round(Math.min(2, Math.max(0, gain)) * 100)}
        onChange={(event) => onGain(Number(event.target.value) / 100)}
      />
    </div>
  );
}
