import { open } from "@tauri-apps/plugin-dialog";
import { isRecordableImagePath, RECORDABLE_IMAGE_EXTENSIONS } from "../../../recording/composition";
import { imageSettingsOf, type RecordingSource } from "../../../recording/scene";

export function ImageSourceSettings({
  source,
  onChange,
  recorded = false,
}: {
  source: RecordingSource;
  onChange: (settings: { path?: string; opacity?: number }) => void;
  /** Recordings bake images into the file, which supports PNG and JPEG only. */
  recorded?: boolean;
}) {
  const image = imageSettingsOf(source);

  async function pickFile() {
    const selected = await open({
      multiple: false,
      filters: recorded
        ? [{ name: "PNG or JPEG", extensions: [...RECORDABLE_IMAGE_EXTENSIONS] }]
        : [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
    });
    if (typeof selected === "string" && selected) onChange({ path: selected });
  }

  return (
    <div className="stack">
      {recorded ? (
        <p className="muted">
          Recorded into the session file. PNG or JPEG only.
          {image.path && !isRecordableImagePath(image.path) ? " This file cannot be recorded. Replace it." : ""}
        </p>
      ) : (
        <p className="muted">Preview only. Not burned into the session file.</p>
      )}
      <button type="button" className="btn" onClick={() => void pickFile()}>
        {image.path ? "Replace image" : "Choose image"}
      </button>
      {image.path ? <p className="muted path-line">{image.path}</p> : null}
      <label className="setting-row">
        <span>Opacity</span>
        <span className="muted">{Math.round(image.opacity * 100)}%</span>
      </label>
      <input
        type="range"
        min={10}
        max={100}
        value={Math.round(image.opacity * 100)}
        onChange={(event) => onChange({ opacity: Number(event.target.value) / 100 })}
      />
    </div>
  );
}
