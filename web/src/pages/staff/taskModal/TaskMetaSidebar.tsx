import type { CSSProperties } from "react";
import { SocialAvatar } from "../../../components/SocialAvatar";
import { AssigneePicker, type AssigneePerson } from "../AssigneePicker";
import { formatDue, labelTone } from "../boardUi";
import { IconClose, IconFlag, IconProgress } from "../opsIcons";

const PRIORITIES = [
  { id: "none", label: "None" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "urgent", label: "Urgent" },
];

export function TaskMetaSidebar({
  columnId,
  columns,
  canMove,
  onMove,
  priority,
  canEdit,
  onPriority,
  watching,
  onToggleWatch,
  people,
  assignees,
  canAssign,
  onToggleAssignee,
  labels,
  selectedLabelIds,
  onToggleLabel,
  dueAt,
  onDueAt,
}: {
  columnId: string;
  columns: Array<{ id: string; name: string }>;
  canMove: boolean;
  onMove: (columnId: string) => void;
  priority: string;
  canEdit: boolean;
  onPriority: (priority: string) => void;
  watching: boolean;
  onToggleWatch: () => void;
  people: AssigneePerson[];
  assignees: AssigneePerson[];
  canAssign: boolean;
  onToggleAssignee: (person: AssigneePerson) => void;
  labels: Array<{ id: string; name: string; color?: string | null }>;
  selectedLabelIds: string[];
  onToggleLabel: (labelId: string) => void;
  dueAt: string | null;
  onDueAt: (value: string | null) => void;
}) {
  const columnName = columns.find((column) => column.id === columnId)?.name ?? "List";
  const priorityOptions = PRIORITIES.filter((item) => item.id !== "urgent" || priority === "urgent");

  return (
    <section className="task-modal-card" style={{ gridArea: "details" }}>
      <header className="task-modal-card-head">
        <IconProgress />
        <div>
          <h3>Details</h3>
          <p>Manage status, assignee and other settings.</p>
        </div>
      </header>
      <div className="task-modal-detail-rows">
        <label className="task-modal-detail-row">
          <span>Status</span>
          {canMove && columns.length ? (
            <select className="task-modal-input" value={columnId} onChange={(event) => onMove(event.target.value)}>
              {columns.map((column) => (
                <option key={column.id} value={column.id}>
                  {column.name}
                </option>
              ))}
            </select>
          ) : (
            <strong className="task-modal-input is-static">{columnName}</strong>
          )}
        </label>
        <label className="task-modal-detail-row">
          <span>
            <IconFlag /> Priority
          </span>
          <select
            className="task-modal-input"
            value={priority}
            disabled={!canEdit}
            onChange={(event) => onPriority(event.target.value)}
          >
            {priorityOptions.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <div className="task-modal-detail-row is-split">
          <span>
            Watching
            <em>Get notified about activity on this task.</em>
          </span>
          <button
            type="button"
            className={`task-modal-switch${watching ? " is-on" : ""}`}
            role="switch"
            aria-checked={watching}
            onClick={onToggleWatch}
          >
            <span />
          </button>
        </div>
        <div className="task-modal-detail-row is-stack">
          <span>Assignee</span>
          <div className="task-modal-assignees">
            {assignees.map((person) => (
              <span key={person.id} className="task-modal-assignee-chip">
                <SocialAvatar name={person.displayName} size={28} />
                <span>{person.displayName}</span>
                {canAssign ? (
                  <button type="button" aria-label={`Remove ${person.displayName}`} onClick={() => onToggleAssignee(person)}>
                    <IconClose width="12" height="12" />
                  </button>
                ) : null}
              </span>
            ))}
            {canAssign ? (
              <AssigneePicker
                people={people}
                selected={assignees}
                enabled={canAssign}
                blockLabel={assignees.length ? "Add" : "+ Add assignee"}
                onToggle={onToggleAssignee}
              />
            ) : null}
            {!canAssign && !assignees.length ? <span className="muted">Unassigned</span> : null}
          </div>
        </div>
        {labels.length ? (
          <div className="task-modal-detail-row is-stack">
            <span>Labels</span>
            <div className="staff-chip-row">
              {labels.map((label) => {
                const on = selectedLabelIds.includes(label.id);
                return (
                  <button
                    key={label.id}
                    type="button"
                    className={`ops-label${on ? " is-on" : ""}`}
                    style={{ "--ops-label": labelTone(label.name, label.color ?? undefined) } as CSSProperties}
                    disabled={!canEdit}
                    onClick={() => onToggleLabel(label.id)}
                  >
                    {label.name}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
        {canEdit || dueAt ? (
          <label className="task-modal-detail-row">
            <span>Due date</span>
            {canEdit ? (
              <input
                className="task-modal-input"
                type="date"
                value={dueAt ? dueAt.slice(0, 10) : ""}
                onChange={(event) => {
                  const value = event.target.value ? new Date(`${event.target.value}T12:00:00`).toISOString() : null;
                  onDueAt(value);
                }}
              />
            ) : (
              <strong className="task-modal-input is-static">{formatDue(dueAt) || "None"}</strong>
            )}
          </label>
        ) : null}
      </div>
    </section>
  );
}
