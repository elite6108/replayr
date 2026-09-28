import { IconPencil } from "../opsIcons";

export function TaskTitleField({
  value,
  enabled,
  onChange,
  onCommit,
}: {
  value: string;
  enabled: boolean;
  onChange: (value: string) => void;
  onCommit: () => void;
}) {
  return (
    <div className="task-modal-title-wrap">
      <label className="task-modal-field-label" htmlFor="task-modal-title">
        Title
      </label>
      <div className={`task-modal-title-box${enabled ? "" : " is-readonly"}`}>
        <IconPencil />
        <input
          id="task-modal-title"
          className="task-modal-title-input"
          value={value}
          disabled={!enabled}
          placeholder="The name of the task goes here"
          aria-label="Task title"
          onChange={(event) => onChange(event.target.value)}
          onBlur={onCommit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
        />
      </div>
    </div>
  );
}
