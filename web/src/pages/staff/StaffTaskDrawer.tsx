import { useEffect, useRef, useState } from "react";
import { useAuth } from "../../lib/auth";
import {
  addStaffChecklist,
  addStaffChecklistItem,
  addStaffRelation,
  addStaffSubtask,
  archiveStaffTask,
  commentStaffTask,
  fetchStaffAttachmentUrl,
  fetchStaffTask,
  patchStaffChecklistItem,
  patchStaffSubtask,
  patchStaffTask,
  setStaffAssignees,
  setStaffTaskLabels,
  uploadStaffAttachment,
  watchStaffTask,
  type StaffBoardCard,
  type StaffBoardDetail,
  type StaffTaskDetail,
  useStaffPermissions,
} from "../../lib/staff";
import { AssigneePicker } from "./AssigneePicker";
import { taskFromSnapshot, type StaffTaskCardPatch } from "./boardUi";
import { InlineRename } from "./InlineRename";

export function StaffTaskDrawer({
  taskId,
  board,
  snapshot,
  onClose,
  onTaskChanged,
}: {
  taskId: string;
  board: StaffBoardDetail | null;
  snapshot?: StaffBoardCard | null;
  onClose: () => void;
  onTaskChanged?: (patch: StaffTaskCardPatch) => void;
}) {
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const { can } = useStaffPermissions();
  const [task, setTask] = useState<StaffTaskDetail | null>(() =>
    snapshot && snapshot.id === taskId ? taskFromSnapshot(snapshot, board) : null,
  );
  const [error, setError] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [renameTitle, setRenameTitle] = useState(false);
  const [descFocused, setDescFocused] = useState(false);
  const [descDraft, setDescDraft] = useState(snapshot?.id === taskId ? "" : "");
  const dirty = useRef(false);

  function emit(next: StaffTaskDetail) {
    onTaskChanged?.({
      id: next.id,
      title: next.title,
      priority: next.priority,
      dueAt: next.dueAt,
      assignees: next.assignees,
      labelIds: next.labelIds,
    });
  }

  function apply(next: StaffTaskDetail) {
    dirty.current = true;
    setTask(next);
    emit(next);
  }

  async function load() {
    if (!token) return;
    const detail = await fetchStaffTask(token, taskId);
    setTask((current) => {
      if (!current || current.id !== detail.task.id || !dirty.current) return detail.task;
      return {
        ...detail.task,
        title: current.title,
        priority: current.priority,
        dueAt: current.dueAt,
        assignees: current.assignees,
        labelIds: current.labelIds,
        description: current.description ?? detail.task.description,
      };
    });
    if (!dirty.current) setDescDraft(detail.task.description ?? "");
  }

  useEffect(() => {
    dirty.current = false;
    setRenameTitle(false);
    setDescFocused(false);
    setError(null);
    setComment("");
    if (snapshot && snapshot.id === taskId) {
      const seeded = taskFromSnapshot(snapshot, board);
      setTask(seeded);
      setDescDraft("");
    } else {
      setTask((current) => (current?.id === taskId ? current : null));
    }
    void load().catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Could not load task."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, token]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && !renameTitle && !descFocused) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, renameTitle, descFocused]);

  async function patch(body: Record<string, unknown>, optimistic: Partial<StaffTaskDetail>) {
    if (!token || !task) return;
    const previous = task;
    apply({ ...task, ...optimistic });
    try {
      const result = await patchStaffTask(token, task.id, body);
      dirty.current = false;
      setTask(result.task);
      emit(result.task);
    } catch (caught) {
      setTask(previous);
      emit(previous);
      setError(caught instanceof Error ? caught.message : "Could not update task.");
    }
  }

  async function toggleAssignee(person: { id: string; displayName: string }) {
    if (!token || !task) return;
    const on = task.assignees.some((item) => item.id === person.id);
    const nextPeople = on ? task.assignees.filter((item) => item.id !== person.id) : [...task.assignees, person];
    const previous = task;
    apply({ ...task, assignees: nextPeople });
    try {
      const result = await setStaffAssignees(token, task.id, nextPeople.map((item) => item.id));
      dirty.current = false;
      setTask(result.task);
      emit(result.task);
    } catch (caught) {
      setTask(previous);
      emit(previous);
      setError(caught instanceof Error ? caught.message : "Could not update assignees.");
    }
  }

  async function toggleLabel(labelId: string) {
    if (!token || !task) return;
    const on = task.labelIds.includes(labelId);
    const next = on ? task.labelIds.filter((id) => id !== labelId) : [...task.labelIds, labelId];
    const previous = task;
    apply({ ...task, labelIds: next });
    try {
      const result = await setStaffTaskLabels(token, task.id, next);
      dirty.current = false;
      setTask(result.task);
      emit(result.task);
    } catch (caught) {
      setTask(previous);
      emit(previous);
      setError(caught instanceof Error ? caught.message : "Could not update labels.");
    }
  }

  const people = board?.people?.length ? board.people : task?.assignees ?? [];
  const mutate = Boolean(task?.canMutate);
  const hydrating = Boolean(task && !task.createdAt);

  return (
    <>
      <button type="button" className="ops-drawer-backdrop" aria-label="Close task" onClick={onClose} />
      <aside className="ops-drawer staff-drawer staff-task-drawer" aria-label="Task details">
        {!task ? (
          <>
            <p className="muted">{error || "Loading…"}</p>
            <button type="button" className="ops-ghost" onClick={onClose}>
              Close
            </button>
          </>
        ) : (
          <>
            <header className="staff-drawer-head ops-drawer-head">
              <InlineRename
                value={task.title}
                className="staff-title-input"
                ariaLabel="Task title"
                enabled={mutate && can("board.cards.edit")}
                editing={renameTitle}
                onEditingChange={setRenameTitle}
                onSave={(title) => patch({ title }, { title })}
              />
              <button type="button" className="ops-ghost" onClick={onClose}>
                Close
              </button>
            </header>
            {error ? <p className="ops-error">{error}</p> : null}
            {hydrating ? <p className="ops-drawer-status">Loading details…</p> : null}
            <div className="staff-task-grid">
              <label>
                Priority
                <select
                  className="ops-select"
                  value={task.priority}
                  disabled={!mutate}
                  onChange={(event) => void patch({ priority: event.target.value }, { priority: event.target.value })}
                >
                  {["none", "low", "medium", "high", "urgent"].map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Due
                <input
                  className="ops-select"
                  type="datetime-local"
                  value={task.dueAt ? task.dueAt.slice(0, 16) : ""}
                  disabled={!mutate}
                  onChange={(event) => {
                    const value = event.target.value ? new Date(event.target.value).toISOString() : null;
                    void patch({ dueAt: value }, { dueAt: value });
                  }}
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={Boolean(task.completedAt)}
                  onChange={(event) =>
                    void patch({ completed: event.target.checked }, { completedAt: event.target.checked ? new Date().toISOString() : null })
                  }
                />
                Complete
              </label>
              <button
                type="button"
                className="ops-ghost"
                  onClick={() => {
                    apply({ ...task, watching: !task.watching });
                    void watchStaffTask(token, task.id, !task.watching).catch((caught: unknown) => {
                      apply({ ...task, watching: task.watching });
                      setError(caught instanceof Error ? caught.message : "Could not update watch.");
                    });
                  }}
              >
                {task.watching ? "Unwatch" : "Watch"}
              </button>
            </div>
            <h4>Assignees</h4>
            <AssigneePicker
              people={people}
              selected={task.assignees}
              enabled={can("board.cards.assign") && mutate}
              onToggle={(person) => void toggleAssignee(person)}
            />
            {board?.labels.length ? (
              <>
                <h4>Labels</h4>
                <div className="staff-chip-row">
                  {board.labels.map((label) => {
                    const on = task.labelIds.includes(label.id);
                    return (
                      <button
                        key={label.id}
                        type="button"
                        className={on ? "chip active" : "chip"}
                        style={{ borderColor: label.color }}
                        onClick={() => void toggleLabel(label.id)}
                      >
                        {label.name}
                      </button>
                    );
                  })}
                </div>
              </>
            ) : null}
            <label>
              Description
              {descFocused || !task.description ? (
                <textarea
                  className="ops-textarea"
                  value={descDraft}
                  rows={8}
                  disabled={!mutate}
                  onFocus={() => {
                    setDescFocused(true);
                    if (!descDraft) setDescDraft(task.description ?? "");
                  }}
                  onChange={(event) => setDescDraft(event.target.value)}
                  onBlur={() => {
                    setDescFocused(false);
                    if (descDraft !== (task.description ?? "")) void patch({ description: descDraft }, { description: descDraft });
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="ops-desc-preview"
                  onClick={() => {
                    setDescDraft(task.description ?? "");
                    setDescFocused(true);
                  }}
                >
                  <MarkdownPreview value={task.description} />
                </button>
              )}
            </label>
            <h4>Checklists</h4>
            {task.checklists.map((list) => (
              <div key={list.id} className="staff-checklist">
                <strong>{list.title}</strong>
                {list.items.map((item) => (
                  <label key={item.id}>
                    <input
                      type="checkbox"
                      checked={item.done}
                      onChange={(event) => void patchStaffChecklistItem(token, item.id, { done: event.target.checked }).then((body) => setTask(body.task))}
                    />
                    {item.title}
                  </label>
                ))}
                {can("board.checklists.manage") ? (
                  <input
                    placeholder="Add item"
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        const value = event.currentTarget.value.trim();
                        if (!value) return;
                        event.currentTarget.value = "";
                        void addStaffChecklistItem(token, list.id, value).then((body) => setTask(body.task));
                      }
                    }}
                  />
                ) : null}
              </div>
            ))}
            {can("board.checklists.manage") && mutate ? (
              <button type="button" className="ops-ghost" onClick={() => void addStaffChecklist(token, task.id, "Checklist").then((body) => setTask(body.task))}>
                Add checklist
              </button>
            ) : null}
            <h4>Subtasks</h4>
            {task.subtasks.map((item) => (
              <label key={item.id}>
                <input
                  type="checkbox"
                  checked={item.done}
                  onChange={(event) => void patchStaffSubtask(token, item.id, { done: event.target.checked }).then((body) => setTask(body.task))}
                />
                {item.title}
              </label>
            ))}
            {can("board.checklists.manage") ? (
              <input
                placeholder="Add subtask"
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    const value = event.currentTarget.value.trim();
                    if (!value) return;
                    event.currentTarget.value = "";
                    void addStaffSubtask(token, task.id, value).then((body) => setTask(body.task));
                  }
                }}
              />
            ) : null}
            <h4>Relations</h4>
            <ul>
              {task.relations.map((row) => (
                <li key={row.id}>
                  {row.kind}: {row.label || row.targetId}
                </li>
              ))}
            </ul>
            {mutate ? (
              <form
                className="admin-filters"
                onSubmit={(event) => {
                  event.preventDefault();
                  const data = new FormData(event.currentTarget);
                  void addStaffRelation(token, task.id, {
                    kind: String(data.get("kind")),
                    targetId: String(data.get("targetId")),
                    label: String(data.get("label") || ""),
                  }).then((body) => setTask(body.task));
                  event.currentTarget.reset();
                }}
              >
                <select className="ops-select" name="kind">
                  {["clip", "user", "screenshot", "folder", "creator_application", "error_fingerprint", "url"].map((kind) => (
                    <option key={kind} value={kind}>
                      {kind}
                    </option>
                  ))}
                </select>
                <input name="targetId" placeholder="id or url" required />
                <input name="label" placeholder="label" />
                <button className="ops-create sm" type="submit">
                  Link
                </button>
              </form>
            ) : null}
            <h4>Attachments</h4>
            <ul>
              {task.attachments.map((file) => (
                <li key={file.id}>
                  <button
                    type="button"
                    className="linkish"
                    onClick={() =>
                      void fetchStaffAttachmentUrl(token, file.id).then((body) => {
                        window.open(body.url, "_blank", "noopener");
                      })
                    }
                  >
                    {file.filename}
                  </button>
                </li>
              ))}
            </ul>
            {can("board.attachments.upload") && mutate ? (
              <input
                type="file"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  void uploadStaffAttachment(token, task.id, file).then(load);
                }}
              />
            ) : null}
            <h4>Comments</h4>
            {task.comments.map((item) => (
              <article key={item.id} className="staff-comment">
                <strong>{item.authorName}</strong>
                <span className="muted"> {new Date(item.createdAt).toLocaleString()}</span>
                <p>{item.body}</p>
              </article>
            ))}
            {can("board.comments.create") ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!comment.trim()) return;
                  void commentStaffTask(token, task.id, comment.trim()).then((body) => {
                    setComment("");
                    setTask(body.task);
                  });
                }}
              >
                <textarea className="ops-textarea" value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Comment. Use @username to mention." />
                <button className="ops-create sm" type="submit">
                  Comment
                </button>
              </form>
            ) : null}
            <h4>Activity</h4>
            <ul className="muted">
              {task.activity.map((item) => (
                <li key={item.id}>
                  {item.action} · {new Date(item.createdAt).toLocaleString()}
                </li>
              ))}
            </ul>
            {can("board.cards.delete") && mutate ? (
              <button
                type="button"
                className="ops-danger"
                onClick={() => {
                  if (!window.confirm("Archive this task?")) return;
                  void archiveStaffTask(token, task.id).then(onClose);
                }}
              >
                Archive
              </button>
            ) : null}
          </>
        )}
      </aside>
    </>
  );
}

function MarkdownPreview({ value }: { value: string }) {
  const html = renderMarkdown(value);
  return <div className="staff-markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

function renderMarkdown(value: string) {
  const escaped = value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escaped
    .replace(/^### (.*)$/gm, "<h3>$1</h3>")
    .replace(/^## (.*)$/gm, "<h2>$1</h2>")
    .replace(/^# (.*)$/gm, "<h1>$1</h1>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[(.+?)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    .replace(/\n/g, "<br />");
}
