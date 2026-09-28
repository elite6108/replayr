import { InlineRename } from "../InlineRename";

export function TaskTitleField({
  value,
  enabled,
  editing,
  onEditingChange,
  onSave,
}: {
  value: string;
  enabled: boolean;
  editing: boolean;
  onEditingChange: (open: boolean) => void;
  onSave: (title: string) => void;
}) {
  return (
    <div className="task-modal-field">
      <label className="task-modal-label">Title</label>
      <InlineRename
        value={value}
        className="task-modal-title"
        ariaLabel="Card title"
        placeholder="Ask about…"
        enabled={enabled}
        editing={editing}
        onEditingChange={onEditingChange}
        onSave={onSave}
      />
    </div>
  );
}
