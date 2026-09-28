import { IconTrash } from "../opsIcons";

export function TaskDangerZone({ onDelete }: { onDelete: () => void }) {
  return (
    <button type="button" className="task-modal-danger-btn" onClick={onDelete}>
      <IconTrash />
      Delete task
    </button>
  );
}
