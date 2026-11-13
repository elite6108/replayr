import { useEffect, useRef, useState } from "react";
import { formatDb } from "../../recording/useStudioAudio";

/** Highest gain the mixer allows (200%, about +6 dB). */
const MAX_GAIN = 2;

/** Parse typed text like "-6", "+3 dB", "0db" or "-inf" into linear gain. */
export function parseDbInput(text: string): number | null {
  const cleaned = text.trim().toLowerCase().replace(/db$/, "").replace(/\s+/g, "").replace("−", "-");
  if (!cleaned) return null;
  if (cleaned === "-inf" || cleaned === "-∞" || cleaned === "inf" || cleaned === "∞") return 0;
  const db = Number(cleaned);
  if (!Number.isFinite(db)) return null;
  return Math.min(MAX_GAIN, Math.max(0, 10 ** (db / 20)));
}

function dbText(gain: number): string {
  if (gain <= 0.0001) return "-inf";
  return (Math.round(20 * Math.log10(gain) * 10) / 10).toFixed(1);
}

export function MixerDbInput({
  label,
  gain,
  enabled,
  disabled,
  onGain,
}: {
  label: string;
  gain: number;
  enabled: boolean;
  disabled?: boolean;
  onGain: (gain: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (draft !== null) inputRef.current?.select();
  }, [draft !== null]);

  if (draft === null) {
    return (
      <button
        type="button"
        className="studio-mix-db studio-mix-db-edit"
        disabled={disabled || !enabled}
        title={disabled || !enabled ? undefined : "Click to type a level in dB"}
        aria-label={`${label}: ${formatDb(gain)}. Click to edit`}
        onClick={() => setDraft(dbText(gain))}
      >
        {enabled ? formatDb(gain) : "−∞ dB"}
      </button>
    );
  }

  const commit = () => {
    const next = parseDbInput(draft);
    if (next !== null) onGain(next);
    setDraft(null);
  };

  return (
    <input
      ref={inputRef}
      className="studio-mix-db studio-mix-db-input"
      aria-label={`${label} in dB`}
      value={draft}
      inputMode="decimal"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
        else if (event.key === "Escape") setDraft(null);
        else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          event.preventDefault();
          const current = parseDbInput(draft) ?? gain;
          const db = current <= 0.0001 ? -60 : 20 * Math.log10(current);
          const step = event.shiftKey ? 0.1 : 1;
          const nextGain = parseDbInput(String(db + (event.key === "ArrowUp" ? step : -step)));
          if (nextGain !== null) {
            setDraft(dbText(nextGain));
            onGain(nextGain);
          }
        }
      }}
    />
  );
}
