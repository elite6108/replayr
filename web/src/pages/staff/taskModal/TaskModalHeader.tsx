import { IconBoard, IconClose } from "../opsIcons";

export function TaskModalHeader({
  boardName,
  columnId,
  columnName,
  columns,
  canMove,
  saveState,
  onMove,
  onClose,
}: {
  boardName: string;
  columnId: string;
  columnName: string;
  columns: Array<{ id: string; name: string }>;
  canMove: boolean;
  saveState: "idle" | "saving" | "saved";
  onMove: (columnId: string) => void;
  onClose: () => void;
}) {
  return (
    <header className="task-modal-head">
      <div className="task-modal-kicker">
        <h2>Task details</h2>
        <p className="task-modal-crumb">
          <IconBoard width="14" height="14" />
          <span>{boardName}</span>
          <span className="task-modal-crumb-sep">/</span>
          <span>Task</span>
        </p>
      </div>
      <div className="task-modal-head-end">
        {saveState !== "idle" ? (
          <span className="task-modal-save-state" role="status">
            {saveState === "saving" ? "Saving…" : "Saved"}
          </span>
        ) : null}
        <label className="task-modal-status-head">
          <span>Status</span>
          {canMove && columns.length ? (
            <select
              className="task-modal-list-select"
              value={columnId}
              aria-label="Status"
              onChange={(event) => onMove(event.target.value)}
            >
              {columns.map((column) => (
                <option key={column.id} value={column.id}>
                  {column.name}
                </option>
              ))}
            </select>
          ) : (
            <strong className="task-modal-list-select">{columnName}</strong>
          )}
        </label>
        <button type="button" className="task-modal-close" aria-label="Close" onClick={onClose}>
          <IconClose />
        </button>
      </div>
    </header>
  );
}
