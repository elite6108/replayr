import { IconClose } from "../opsIcons";

export function TaskModalHeader({
  title,
  columnId,
  columnName,
  columns,
  canMove,
  onMove,
  onClose,
}: {
  title: string;
  columnId: string;
  columnName: string;
  columns: Array<{ id: string; name: string }>;
  canMove: boolean;
  onMove: (columnId: string) => void;
  onClose: () => void;
}) {
  return (
    <header className="task-modal-head">
      <div className="task-modal-kicker">
        <span>{title}</span>
      </div>
      <div className="task-modal-head-end">
        <label className="task-modal-list-pill">
          <span className="sr-only">Add to list</span>
          {canMove && columns.length ? (
            <select
              className="task-modal-list-select"
              value={columnId}
              aria-label="Add to list"
              onChange={(event) => onMove(event.target.value)}
            >
              {columns.map((column) => (
                <option key={column.id} value={column.id}>
                  {column.name}
                </option>
              ))}
            </select>
          ) : (
            <strong>{columnName}</strong>
          )}
        </label>
        <button type="button" className="task-modal-close" aria-label="Close" onClick={onClose}>
          <IconClose />
        </button>
      </div>
    </header>
  );
}
