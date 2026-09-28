import { useState } from "react";
import { SocialAvatar } from "../../../components/SocialAvatar";

export type StaffCommentItem = {
  id: string;
  authorName: string;
  authorStaffId: string | null;
  author?: { displayName: string; username?: string | null; avatarUrl: string | null } | null;
  createdAt: string;
  body: string;
  edited?: boolean;
};

export function TaskCommentsPanel({
  comments,
  draft,
  canComment,
  currentStaffId,
  canModerate,
  onDraftChange,
  onSubmit,
  onEdit,
  onDelete,
}: {
  comments: StaffCommentItem[];
  draft: string;
  canComment: boolean;
  currentStaffId?: string;
  canModerate: boolean;
  onDraftChange: (value: string) => void;
  onSubmit: () => void;
  onEdit: (commentId: string, body: string) => void;
  onDelete: (commentId: string) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");

  return (
    <section className="task-modal-side-block">
      <h3>Comments</h3>
      <div className="task-modal-comments">
        {comments.map((item) => {
          const own = Boolean(item.authorStaffId && item.authorStaffId === currentStaffId);
          const canChange = own || canModerate;
          return (
            <article key={item.id} className="task-modal-comment">
              <div className="task-modal-comment-head">
                <SocialAvatar
                  name={item.author?.displayName || item.authorName}
                  avatarUrl={item.author?.avatarUrl}
                  size={28}
                />
                <div>
                  <strong>{item.authorName}</strong>
                  <span>
                    {new Date(item.createdAt).toLocaleString()}
                    {item.edited ? " · edited" : ""}
                  </span>
                </div>
              </div>
              {editingId === item.id ? (
                <>
                  <textarea
                    className="task-modal-input task-modal-comment-input"
                    value={editDraft}
                    onChange={(event) => setEditDraft(event.target.value)}
                  />
                  <div className="row">
                    <button
                      className="task-modal-primary sm"
                      type="button"
                      onClick={() => {
                        if (!editDraft.trim()) return;
                        onEdit(item.id, editDraft.trim());
                        setEditingId(null);
                      }}
                    >
                      Save
                    </button>
                    <button className="task-modal-ghost sm" type="button" onClick={() => setEditingId(null)}>
                      Cancel
                    </button>
                  </div>
                </>
              ) : (
                <p>{item.body}</p>
              )}
              {canChange && editingId !== item.id ? (
                <div className="task-modal-comment-actions">
                  {own ? (
                    <button
                      type="button"
                      className="linkish"
                      onClick={() => {
                        setEditingId(item.id);
                        setEditDraft(item.body);
                      }}
                    >
                      Edit
                    </button>
                  ) : null}
                  <button type="button" className="linkish" onClick={() => onDelete(item.id)}>
                    Delete
                  </button>
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
      {canComment ? (
        <form
          className="task-modal-comment-form"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <textarea
            className="task-modal-input task-modal-comment-input"
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            placeholder="Write a comment…"
          />
          <button className="task-modal-primary sm" type="submit">
            Post comment
          </button>
        </form>
      ) : null}
    </section>
  );
}
