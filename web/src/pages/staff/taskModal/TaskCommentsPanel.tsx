import { useState } from "react";
import { SocialAvatar } from "../../../components/SocialAvatar";
import { IconComment, IconDots, IconEmoji } from "../opsIcons";

const EMOJI = ["👍", "❤️", "🎉", "🔥", "👀", "😂", "✅", "🙏", "💡", "🚀"];

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
  const [menuId, setMenuId] = useState<string | null>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);

  return (
    <section className="task-modal-card" style={{ gridArea: "comments" }}>
      <header className="task-modal-card-head">
        <IconComment />
        <div>
          <h3>Comments</h3>
        </div>
        <span className="task-modal-count">{comments.length}</span>
      </header>
      <div className="task-modal-comments">
        {comments.map((item) => {
          const own = Boolean(item.authorStaffId && item.authorStaffId === currentStaffId);
          const canChange = own || canModerate;
          return (
            <article key={item.id} className="task-modal-comment">
              <SocialAvatar
                name={item.author?.displayName || item.authorName}
                avatarUrl={item.author?.avatarUrl}
                size={32}
              />
              <div className="task-modal-comment-body">
                <div className="task-modal-comment-head">
                  <strong>{item.authorName}</strong>
                  <span>
                    {formatCommentTime(item.createdAt)}
                    {item.edited ? " · edited" : ""}
                  </span>
                  {canChange && editingId !== item.id ? (
                    <div className="task-modal-comment-menu">
                      <button
                        type="button"
                        className="task-modal-icon-btn"
                        aria-label="Comment actions"
                        onClick={() => setMenuId(menuId === item.id ? null : item.id)}
                      >
                        <IconDots />
                      </button>
                      {menuId === item.id ? (
                        <div className="task-modal-mini-menu">
                          {own ? (
                            <button
                              type="button"
                              onClick={() => {
                                setEditingId(item.id);
                                setEditDraft(item.body);
                                setMenuId(null);
                              }}
                            >
                              Edit
                            </button>
                          ) : null}
                          <button
                            type="button"
                            onClick={() => {
                              setMenuId(null);
                              onDelete(item.id);
                            }}
                          >
                            Delete
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                {editingId === item.id ? (
                  <>
                    <textarea
                      className="task-modal-input task-modal-comment-input"
                      value={editDraft}
                      onChange={(event) => setEditDraft(event.target.value)}
                    />
                    <div className="task-modal-comment-edit-actions">
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
              </div>
            </article>
          );
        })}
      </div>
      {canComment ? (
        <form
          className="task-modal-comment-form"
          onSubmit={(event) => {
            event.preventDefault();
            setEmojiOpen(false);
            onSubmit();
          }}
        >
          <textarea
            className="task-modal-input task-modal-comment-input"
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            placeholder="Write a comment…"
            rows={2}
          />
          <div className="task-modal-comment-compose">
            <div className="task-modal-emoji-wrap">
              <button
                type="button"
                className="task-modal-icon-btn"
                aria-label="Insert emoji"
                onClick={() => setEmojiOpen((open) => !open)}
              >
                <IconEmoji />
              </button>
              {emojiOpen ? (
                <div className="task-modal-emoji-pop" role="listbox" aria-label="Emoji">
                  {EMOJI.map((item) => (
                    <button
                      key={item}
                      type="button"
                      onClick={() => {
                        onDraftChange(`${draft}${item}`);
                        setEmojiOpen(false);
                      }}
                    >
                      {item}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <button className="task-modal-primary sm" type="submit">
              Post comment
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}

function formatCommentTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}
