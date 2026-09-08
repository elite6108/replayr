export type DeleteClipScope = "pc" | "cloud" | "both";

export function DeleteClipDialog({
  count = 1,
  showPc,
  showCloud,
  showBoth,
  onClose,
  onChoose,
}: {
  count?: number;
  showPc: boolean;
  showCloud: boolean;
  showBoth: boolean;
  onClose: () => void;
  onChoose: (scope: DeleteClipScope) => void;
}) {
  const plural = count === 1 ? "clip" : "clips";
  const title = count === 1 ? "Delete clip" : `Delete ${count} clips`;

  return (
    <div className="studio-modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="studio-modal delete-clip-dialog"
        role="dialog"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="studio-block-head">
          <h2>{title}</h2>
          <button type="button" className="studio-icon-btn" onClick={onClose}>
            Close
          </button>
        </div>
        <p className="muted delete-clip-copy">
          Choose what to remove. Deleting from this PC does not remove a cloud copy unless you pick both.
        </p>
        <div className="delete-clip-actions">
          {showPc ? (
            <button type="button" className="btn danger" onClick={() => onChoose("pc")}>
              Delete from this PC
              <span className="muted">
                {count === 1
                  ? "Delete the file on this PC. The cloud copy stays."
                  : `Delete ${count} ${plural} on this PC. Cloud copies stay.`}
              </span>
            </button>
          ) : null}
          {showCloud ? (
            <button type="button" className="btn" onClick={() => onChoose("cloud")}>
              Delete from cloud
              <span className="muted">
                {count === 1
                  ? "Remove the cloud copy and share link. The file on this PC stays."
                  : `Remove ${count} cloud ${plural}. Files on this PC stay.`}
              </span>
            </button>
          ) : null}
          {showBoth ? (
            <button type="button" className="btn danger" onClick={() => onChoose("both")}>
              Delete from both
              <span className="muted">
                {count === 1
                  ? "Delete from this PC and the cloud. The share link will stop working."
                  : `Delete ${count} ${plural} from this PC and the cloud.`}
              </span>
            </button>
          ) : null}
        </div>
        <div className="studio-dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
