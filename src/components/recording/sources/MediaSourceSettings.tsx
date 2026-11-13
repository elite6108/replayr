import { open } from "@tauri-apps/plugin-dialog";
import { mediaSettingsOf, type RecordingSource } from "../../../recording/scene";

export function MediaSourceSettings({
  source,
  onChange,
}: {
  source: RecordingSource;
  onChange: (settings: { path?: string; loop?: boolean; restart?: boolean; gain?: number }) => void;
}) {
  const media = mediaSettingsOf(source);
  const video = source.type === "videoFile";

  async function pickFile() {
    const selected = await open({
      multiple: false,
      filters: [
        video
          ? { name: "Video", extensions: ["mp4", "m4v", "mov"] }
          : { name: "Audio", extensions: ["m4a", "mp3", "wav", "aac"] },
      ],
    });
    if (typeof selected === "string" && selected) onChange({ path: selected });
  }

  return (
    <div className="stack">
      <p className="muted">
        {video
          ? "Recorded into the session. MP4 or MOV on this computer."
          : "Mixed into the session. MP3, M4A, WAV, or AAC on this computer."}
      </p>
      <button type="button" className="btn" onClick={() => void pickFile()}>
        {media.path ? "Replace file" : "Choose file"}
      </button>
      {media.path ? <p className="muted path-line">{media.path}</p> : null}
      <label className="setting-row">
        <span>Loop</span>
        <input type="checkbox" checked={media.loop} onChange={(event) => onChange({ loop: event.target.checked })} />
      </label>
      <p className="muted">Playback starts at the beginning of the file.</p>
      <label className="setting-row">
        <span>Volume</span>
        <span className="muted">{Math.round(media.gain * 100)}%</span>
      </label>
      <input
        type="range"
        min={0}
        max={200}
        value={Math.round(media.gain * 100)}
        onChange={(event) => onChange({ gain: Number(event.target.value) / 100 })}
      />
    </div>
  );
}
