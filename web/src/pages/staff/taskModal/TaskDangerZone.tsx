export function TaskDangerZone({ onDelete }: { onDelete: () => void }) {
  return (
    <section className="task-modal-side-block task-modal-danger">
      <h3>Danger zone</h3>
      <button type="button" className="task-modal-danger-btn" onClick={onDelete}>
        Delete task
      </button>
    </section>
  );
}
