import { textSettingsOf, type RecordingSource } from "../../../recording/scene";

export function TextSourceSettings({
  source,
  onChange,
}: {
  source: RecordingSource;
  onChange: (settings: { text?: string; color?: string; size?: number; align?: "left" | "center" | "right" }) => void;
}) {
  const text = textSettingsOf(source);

  return (
    <div className="stack">
      <p className="muted">Preview only. Not burned into the session file.</p>
      <div className="field">
        <label htmlFor="record-text-value">Text</label>
        <input
          id="record-text-value"
          type="text"
          value={text.text}
          onChange={(event) => onChange({ text: event.target.value })}
        />
      </div>
      <div className="settings-fields">
        <div className="field">
          <label htmlFor="record-text-color">Color</label>
          <input
            id="record-text-color"
            type="color"
            value={text.color}
            onChange={(event) => onChange({ color: event.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor="record-text-size">Size</label>
          <input
            id="record-text-size"
            type="number"
            min={10}
            max={96}
            value={text.size}
            onChange={(event) => onChange({ size: Number(event.target.value) })}
          />
        </div>
      </div>
      <div className="shape-row">
        {(["left", "center", "right"] as const).map((align) => (
          <button
            key={align}
            type="button"
            className={`chip ${text.align === align ? "on" : ""}`}
            onClick={() => onChange({ align })}
          >
            {align}
          </button>
        ))}
      </div>
    </div>
  );
}
