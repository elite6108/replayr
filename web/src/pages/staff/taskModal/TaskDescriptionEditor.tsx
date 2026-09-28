import { IconNotes } from "../opsIcons";

export const DESCRIPTION_MAX = 1000;

export function TaskDescriptionEditor({
  value,
  enabled,
  onChange,
  onBlur,
}: {
  value: string;
  enabled: boolean;
  onChange: (value: string) => void;
  onBlur: () => void;
}) {
  return (
    <section className="task-modal-card" style={{ gridArea: "desc" }}>
      <header className="task-modal-card-head">
        <IconNotes />
        <div>
          <h3>Description</h3>
          <p>Add any relevant details, context, or next steps for this task.</p>
        </div>
      </header>
      <div className="task-modal-desc-box">
        <textarea
          className="task-modal-textarea"
          value={value}
          disabled={!enabled}
          maxLength={DESCRIPTION_MAX}
          placeholder="Add a detailed description…"
          aria-label="Task description"
          onChange={(event) => onChange(event.target.value.slice(0, DESCRIPTION_MAX))}
          onBlur={onBlur}
        />
        <span className="task-modal-counter">
          {value.length}/{DESCRIPTION_MAX}
        </span>
      </div>
    </section>
  );
}
