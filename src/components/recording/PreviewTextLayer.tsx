import { textSettingsOf, type RecordingSource } from "../../recording/scene";

export function PreviewTextLayer({ source }: { source: RecordingSource }) {
  const text = textSettingsOf(source);
  return (
    <div
      className={`preview-text align-${text.align}`}
      style={{ color: text.color, fontSize: `${text.size}px` }}
    >
      {text.text || "Text"}
    </div>
  );
}
