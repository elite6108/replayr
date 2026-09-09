import { useEffect, useState } from "react";

/** Commit a completed number, not each keystroke (which would reset IR). */
export function CustomBitrateInput({ value, onSave }: { value: number; onSave: (value: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const parsed = Number(draft);
    if (!draft.trim() || !Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const next = Math.round(Math.max(1000, Math.min(120000, parsed)));
    setDraft(String(next));
    if (next !== value) onSave(next);
  };
  return (
    <input id="custom-bitrate" type="number" min={1000} max={120000} step={500}
      value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={commit}
      onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }}
    />
  );
}
