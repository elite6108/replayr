import { AssigneePicker, type AssigneePerson } from "../AssigneePicker";
import { TaskActivityPanel } from "./TaskActivityPanel";
import { TaskCommentsPanel, type StaffCommentItem } from "./TaskCommentsPanel";
import { TaskDangerZone } from "./TaskDangerZone";
import type { StaffActorCard } from "../../../lib/staff";

export function TaskMetaSidebar({
  comments,
  commentDraft,
  canComment,
  currentStaffId,
  canModerateComments,
  onCommentDraft,
  onCommentSubmit,
  onCommentEdit,
  onCommentDelete,
  activity,
  people,
  assignees,
  canAssign,
  onToggleAssignee,
  watching,
  onToggleWatch,
  canDelete,
  onDelete,
}: {
  comments: StaffCommentItem[];
  commentDraft: string;
  canComment: boolean;
  currentStaffId?: string;
  canModerateComments: boolean;
  onCommentDraft: (value: string) => void;
  onCommentSubmit: () => void;
  onCommentEdit: (commentId: string, body: string) => void;
  onCommentDelete: (commentId: string) => void;
  activity: Array<{
    id: string;
    action: string;
    createdAt: string;
    metadata?: Record<string, unknown>;
    actor?: StaffActorCard | null;
  }>;
  people: AssigneePerson[];
  assignees: AssigneePerson[];
  canAssign: boolean;
  onToggleAssignee: (person: AssigneePerson) => void;
  watching: boolean;
  onToggleWatch: () => void;
  canDelete: boolean;
  onDelete: () => void;
}) {
  return (
    <aside className="task-modal-side">
      <TaskCommentsPanel
        comments={comments}
        draft={commentDraft}
        canComment={canComment}
        currentStaffId={currentStaffId}
        canModerate={canModerateComments}
        onDraftChange={onCommentDraft}
        onSubmit={onCommentSubmit}
        onEdit={onCommentEdit}
        onDelete={onCommentDelete}
      />
      <TaskActivityPanel activity={activity} />
      <section className="task-modal-side-block">
        <h3>Assignee</h3>
        <AssigneePicker
          people={people}
          selected={assignees}
          enabled={canAssign}
          blockLabel="+ Add assignee"
          onToggle={onToggleAssignee}
        />
      </section>
      <section className="task-modal-side-block">
        <h3>Watchers</h3>
        <button type="button" className={`task-modal-add-block${watching ? " is-on" : ""}`} onClick={onToggleWatch}>
          {watching ? "Watching" : "+ Add watcher"}
        </button>
      </section>
      {canDelete ? <TaskDangerZone onDelete={onDelete} /> : null}
    </aside>
  );
}
