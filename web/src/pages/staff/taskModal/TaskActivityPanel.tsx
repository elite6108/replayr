import { SocialAvatar } from "../../../components/SocialAvatar";
import type { StaffActorCard } from "../../../lib/staff";
import { activityHeadline } from "./staffActivityCopy";

export function TaskActivityPanel({
  activity,
}: {
  activity: Array<{
    id: string;
    action: string;
    createdAt: string;
    metadata?: Record<string, unknown>;
    actor?: StaffActorCard | null;
  }>;
}) {
  return (
    <section className="task-modal-side-block">
      <h3>Activity</h3>
      <ol className="task-modal-timeline">
        {activity.map((item) => (
          <li key={item.id}>
            <span className="task-modal-dot" />
            <SocialAvatar
              name={item.actor?.displayName || "Staff"}
              avatarUrl={item.actor?.avatarUrl}
              size={22}
            />
            <div>
              <strong>{activityHeadline({ action: item.action, metadata: item.metadata ?? {}, actor: item.actor })}</strong>
              <span>{new Date(item.createdAt).toLocaleString()}</span>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
