import { formatBytes, formatDuration } from "../../utils/format";

export function EditorClipDetails({
  durationMs,
  width,
  height,
  fps,
  fileSize,
}: {
  durationMs: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  fileSize: number | null;
}) {
  return (
    <section className="editor-details">
      <h2>Clip details</h2>
      <dl>
        <div>
          <dt>Duration</dt>
          <dd>{durationMs ? formatDuration(durationMs) : "—"}</dd>
        </div>
        <div>
          <dt>Resolution</dt>
          <dd>{width && height ? `${width}×${height}` : "—"}</dd>
        </div>
        <div>
          <dt>FPS</dt>
          <dd>{fps ? Math.round(fps) : "—"}</dd>
        </div>
        <div>
          <dt>File size</dt>
          <dd>{fileSize ? formatBytes(fileSize) : "—"}</dd>
        </div>
      </dl>
    </section>
  );
}
