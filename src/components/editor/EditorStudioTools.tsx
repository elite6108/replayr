export function EditorStudioTools({
  trimActive,
  cropActive,
  onTrim,
  onCrop,
}: {
  trimActive: boolean;
  cropActive: boolean;
  onTrim: () => void;
  onCrop: () => void;
}) {
  return (
    <section className="editor-tools">
      <h2>Studio</h2>
      <div className="editor-tool-grid">
        <button type="button" className={trimActive ? "on" : ""} onClick={onTrim}>
          Trim
        </button>
        <button type="button" className={cropActive ? "on" : ""} onClick={onCrop}>
          Crop
        </button>
        <button type="button" disabled title="Coming later">
          Text
        </button>
        <button type="button" disabled title="Coming later">
          Effects
        </button>
        <button type="button" disabled title="Coming later">
          Audio
        </button>
        <button type="button" disabled title="Coming later">
          Speed
        </button>
      </div>
    </section>
  );
}
