import type { StaffActorCard } from "../../../lib/staff";
import { activityHeadline } from "./staffActivityCopy";

export function TaskActivityPanel({
  activity,
  columns,
}: {
  activity: Array<{
    id: string;
    action: string;
    createdAt: string;
    metadata?: Record<string, unknown>;
    actor?: StaffActorCard | null;
  }>;
  columns?: Array<{ id: string; name: string }>;
}) {
  return (
    <section className="task-modal-card" style={{ gridArea: "activity" }}>
      <header className="task-modal-card-head">
        <span className="task-modal-activity-icon" aria-hidden="true" />
        <div>
          <h3>Activity</h3>
        </div>
      </header>
      <ol className="task-modal-timeline">
        {activity.map((item) => (
          <li key={item.id}>
            <span className="task-modal-dot" />
            <div>
              <strong>{activityHeadline({ action: item.action, metadata: item.metadata ?? {}, actor: item.actor }, columns)}</strong>
              <span>{formatActivityTime(item.createdAt)}</span>
            </div>
            <em>{item.actor?.displayName || "Staff"}</em>
          </li>
        ))}
      </ol>
    </section>
  );
}

function formatActivityTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}
