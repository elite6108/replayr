import { textSettingsOf, type RecordingSource } from "../../recording/scene";

export function PreviewTextLayer({ source, recorded = false }: { source: RecordingSource; recorded?: boolean }) {
  const text = textSettingsOf(source);
  return (
    <div
      className={`preview-text align-${text.align}${recorded ? " is-recorded" : ""}`}
      style={{ color: text.color, fontSize: `${text.size}px` }}
    >
      {text.text || "Text"}
    </div>
  );
}
