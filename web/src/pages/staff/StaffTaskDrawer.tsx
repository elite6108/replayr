import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useAuth } from "../../lib/auth";
import {
  addStaffChecklist,
  addStaffChecklistItem,
  addStaffRelation,
  addStaffSubtask,
  archiveStaffTask,
  commentStaffTask,
  deleteStaffAttachment,
  deleteStaffComment,
  editStaffComment,
  fetchStaffAttachmentUrl,
  fetchStaffTask,
  moveStaffTask,
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
import { formatDue, labelTone, taskFromSnapshot, type StaffTaskCardPatch } from "./boardUi";
import { TaskAttachmentLightbox } from "./taskModal/TaskAttachmentLightbox";
import { TaskAttachmentsSection } from "./taskModal/TaskAttachmentsSection";
import { TaskDescriptionEditor } from "./taskModal/TaskDescriptionEditor";
import { TaskMetaSidebar } from "./taskModal/TaskMetaSidebar";
import { TaskModalHeader } from "./taskModal/TaskModalHeader";
import { TaskRelationsSection } from "./taskModal/TaskRelationsSection";
import { TaskTitleField } from "./taskModal/TaskTitleField";

export function StaffTaskDrawer({
  taskId,
  board,
  snapshot,
  onClose,
  onTaskChanged,
  onTaskArchived,
}: {
  taskId: string;
  board: StaffBoardDetail | null;
  snapshot?: StaffBoardCard | null;
  onClose: () => void;
  onTaskChanged?: (patch: StaffTaskCardPatch) => void;
  onTaskArchived?: (taskId: string) => void;
}) {
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const { can, me } = useStaffPermissions();
  const [task, setTask] = useState<StaffTaskDetail | null>(() =>
    snapshot && snapshot.id === taskId ? taskFromSnapshot(snapshot, board) : null,
  );
  const [error, setError] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [renameTitle, setRenameTitle] = useState(false);
  const [descFocused, setDescFocused] = useState(false);
  const [descDraft, setDescDraft] = useState(snapshot?.id === taskId ? "" : "");
  const [panel, setPanel] = useState<null | "add" | "labels" | "members" | "dates">(null);
  const [uploadLabel, setUploadLabel] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<{ title: string; url: string; mime: string | null } | null>(null);
  const dirty = useRef(false);

  function emit(next: StaffTaskDetail) {
    onTaskChanged?.({
      id: next.id,
      title: next.title,
      priority: next.priority,
      dueAt: next.dueAt,
      assignees: next.assignees,
      labelIds: next.labelIds,
      columnId: next.columnId,
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
    setPanel(null);
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
    const refresh = window.setInterval(() => {
      if (!dirty.current) void load().catch(() => undefined);
    }, 20_000);
    return () => window.clearInterval(refresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, token]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (panel) {
        setPanel(null);
        return;
      }
      if (!renameTitle && !descFocused) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, renameTitle, descFocused, panel]);

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

  async function startUpload(file: File) {
    if (!token || !task) return;
    setUploadLabel("Uploading…");
    try {
      const result = await uploadStaffAttachment(token, task.id, file, (ratio) => {
        setUploadLabel(`Uploading ${Math.round(ratio * 100)}%`);
      });
      setTask(result.task);
      setUploadLabel(null);
    } catch (caught) {
      setUploadLabel(null);
      setError(caught instanceof Error ? caught.message : "Could not upload the attachment.");
    }
  }

  async function openAttachment(file: { id: string; filename: string; mime: string | null }) {
    if (!token) return;
    const body = await fetchStaffAttachmentUrl(token, file.id);
    if (body.mime === "application/pdf" || body.mime?.startsWith("image/")) {
      setLightbox({ title: file.filename, url: body.url, mime: body.mime ?? file.mime });
      return;
    }
    window.open(body.url, "_blank", "noopener");
  }

  async function moveToColumn(columnId: string) {
    if (!token || !task || columnId === task.columnId) return;
    const previous = task;
    apply({ ...task, columnId });
    try {
      await moveStaffTask(token, task.id, { columnId, afterRank: null, beforeRank: null });
      const result = await fetchStaffTask(token, task.id);
      dirty.current = false;
      setTask(result.task);
      emit(result.task);
    } catch (caught) {
      setTask(previous);
      emit(previous);
      setError(caught instanceof Error ? caught.message : "Could not move card.");
    }
  }

  function flushDescription() {
    if (!task || !canEdit) return;
    if (descDraft !== (task.description ?? "")) {
      void patch({ description: descDraft }, { description: descDraft });
    }
  }

  const people = board?.people?.length ? board.people : task?.assignees ?? [];
  const mutate = Boolean(task?.canMutate);
  const hydrating = Boolean(task && !task.createdAt);
  const canEdit = mutate && can("board.cards.edit");
  const columnName = board?.columns.find((column) => column.id === task?.columnId)?.name ?? "List";
  const isFresh = Boolean(
    task && !task.description && !task.comments.length && task.activity.filter((item) => item.action !== "created").length === 0,
  );

  return (
    <>
      <button type="button" className="ops-drawer-backdrop task-modal-backdrop" aria-label="Close task" onClick={onClose} />
      <aside className="task-modal" aria-label="Task details" role="dialog">
        {!task ? (
          <div className="task-modal-loading">
            <p className="muted">{error || "Loading…"}</p>
            <button type="button" className="task-modal-ghost" onClick={onClose}>
              Close
            </button>
          </div>
        ) : (
          <>
            <TaskModalHeader
              title={isFresh ? "New task" : "Task details"}
              columnId={task.columnId || ""}
              columnName={columnName}
              columns={board?.columns.length ? board.columns : [{ id: task.columnId, name: columnName }]}
              canMove={can("board.cards.move") && mutate && Boolean(board)}
              onMove={(columnId) => void moveToColumn(columnId)}
              onClose={onClose}
            />
            {error ? <p className="ops-error">{error}</p> : null}
            {hydrating ? <p className="ops-drawer-status">Loading details…</p> : null}
            <div className="task-modal-grid">
              <div className="task-modal-main">
                <TaskTitleField
                  value={task.title}
                  enabled={canEdit}
                  editing={renameTitle}
                  onEditingChange={setRenameTitle}
                  onSave={(title) => patch({ title }, { title })}
                />
                <TaskDescriptionEditor
                  value={descDraft}
                  preview={task.description ? <MarkdownPreview value={task.description} /> : null}
                  focused={descFocused}
                  enabled={canEdit}
                  onFocus={() => setDescFocused(true)}
                  onChange={setDescDraft}
                  onBlur={() => {
                    setDescFocused(false);
                    flushDescription();
                  }}
                  onPreviewClick={() => canEdit && setDescFocused(true)}
                />
                <div className="task-modal-badges">
                  {task.assignees.length ? (
                    <div>
                      <h4>Members</h4>
                      <AssigneePicker people={people} selected={task.assignees} enabled={mutate && can("board.cards.assign")} onToggle={(person) => void toggleAssignee(person)} />
                    </div>
                  ) : null}
                  {task.labelIds.length ? (
                    <div>
                      <h4>Labels</h4>
                      <div className="staff-chip-row">
                        {task.labelIds.map((labelId) => {
                          const label = board?.labels.find((item) => item.id === labelId);
                          if (!label) return null;
                          return (
                            <span key={label.id} className="ops-label" style={{ "--ops-label": labelTone(label.name, label.color) } as CSSProperties}>
                              {label.name}
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}
                  {task.dueAt ? (
                    <div>
                      <h4>Due date</h4>
                      <span className={`ops-due${new Date(task.dueAt).getTime() < Date.now() ? " is-overdue" : ""}`}>{formatDue(task.dueAt)}</span>
                    </div>
                  ) : null}
                  {task.priority !== "none" ? (
                    <div>
                      <h4>Priority</h4>
                      <span className={`ops-prio prio-${task.priority}`}>{task.priority}</span>
                    </div>
                  ) : null}
                </div>
                {canEdit ? (
                  <div className="trello-add-row">
                    <button type="button" className="trello-add-btn" onClick={() => setPanel(panel === "add" ? null : "add")}>
                      Add
                    </button>
                    {panel === "add" ? (
                      <div className="trello-pop">
                        {board?.labels.length ? (
                          <button type="button" className="ops-menu-item" onClick={() => setPanel("labels")}>
                            Labels
                          </button>
                        ) : null}
                        {can("board.cards.assign") ? (
                          <button type="button" className="ops-menu-item" onClick={() => setPanel("members")}>
                            Members
                          </button>
                        ) : null}
                        <button type="button" className="ops-menu-item" onClick={() => setPanel("dates")}>
                          Dates
                        </button>
                        {can("board.checklists.manage") ? (
                          <button
                            type="button"
                            className="ops-menu-item"
                            onClick={() => {
                              const title = window.prompt("Checklist title", "Checklist");
                              if (!title?.trim()) return;
                              void addStaffChecklist(token, task.id, title.trim()).then((body) => setTask(body.task));
                              setPanel(null);
                            }}
                          >
                            Checklist
                          </button>
                        ) : null}
                        {can("board.attachments.upload") ? (
                          <label className="ops-menu-item trello-file">
                            Attachment
                            <input
                              type="file"
                              hidden
                              accept="image/jpeg,image/png,image/webp,application/pdf,text/plain,.log"
                              onChange={(event) => {
                                const file = event.target.files?.[0];
                                event.currentTarget.value = "";
                                if (!file) return;
                                void startUpload(file);
                                setPanel(null);
                              }}
                            />
                          </label>
                        ) : null}
                        <button
                          type="button"
                          className="ops-menu-item"
                          onClick={() => {
                            const next = window.prompt("Priority: none, low, medium, high, urgent", task.priority);
                            if (!next) return;
                            void patch({ priority: next }, { priority: next });
                            setPanel(null);
                          }}
                        >
                          Priority
                        </button>
                      </div>
                    ) : null}
                    {panel === "labels" && board ? (
                      <div className="trello-pop">
                        {board.labels.map((label) => (
                          <button
                            key={label.id}
                            type="button"
                            className={`ops-menu-item${task.labelIds.includes(label.id) ? " is-active" : ""}`}
                            onClick={() => void toggleLabel(label.id)}
                          >
                            {label.name}
                          </button>
                        ))}
                      </div>
                    ) : null}
                    {panel === "members" ? (
                      <div className="trello-pop trello-pop-members">
                        <AssigneePicker people={people} selected={task.assignees} enabled={mutate && can("board.cards.assign")} onToggle={(person) => void toggleAssignee(person)} />
                      </div>
                    ) : null}
                    {panel === "dates" ? (
                      <div className="trello-pop">
                        <label className="trello-date-field">
                          Due date
                          <input
                            type="date"
                            value={task.dueAt ? task.dueAt.slice(0, 10) : ""}
                            onChange={(event) => {
                              const value = event.target.value ? new Date(`${event.target.value}T12:00:00`).toISOString() : null;
                              void patch({ dueAt: value }, { dueAt: value });
                            }}
                          />
                        </label>
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {task.checklists.map((list) => (
                  <section key={list.id} className="task-modal-extra">
                    <h4>{list.title}</h4>
                    {list.items.map((item) => (
                      <label key={item.id} className="staff-check">
                        <input
                          type="checkbox"
                          checked={item.done}
                          disabled={!can("board.checklists.manage")}
                          onChange={() => void patchStaffChecklistItem(token, item.id, { done: !item.done }).then((body) => setTask(body.task))}
                        />
                        {item.title}
                      </label>
                    ))}
                    {can("board.checklists.manage") ? (
                      <input
                        placeholder="Add an item"
                        onKeyDown={(event) => {
                          if (event.key !== "Enter") return;
                          const value = event.currentTarget.value.trim();
                          if (!value) return;
                          event.currentTarget.value = "";
                          void addStaffChecklistItem(token, list.id, value).then((body) => setTask(body.task));
                        }}
                      />
                    ) : null}
                  </section>
                ))}
                {task.subtasks.length ? (
                  <section className="task-modal-extra">
                    <h4>Subtasks</h4>
                    {task.subtasks.map((item) => (
                      <label key={item.id} className="staff-check">
                        <input
                          type="checkbox"
                          checked={item.done}
                          disabled={!mutate}
                          onChange={() => void patchStaffSubtask(token, item.id, { done: !item.done }).then((body) => setTask(body.task))}
                        />
                        {item.title}
                      </label>
                    ))}
                    {mutate ? (
                      <input
                        placeholder="Add a subtask"
                        onKeyDown={(event) => {
                          if (event.key !== "Enter") return;
                          const value = event.currentTarget.value.trim();
                          if (!value) return;
                          event.currentTarget.value = "";
                          void addStaffSubtask(token, task.id, value).then((body) => setTask(body.task));
                        }}
                      />
                    ) : null}
                  </section>
                ) : null}
                <TaskAttachmentsSection
                  token={token}
                  attachments={task.attachments}
                  uploadLabel={uploadLabel}
                  canUpload={can("board.attachments.upload")}
                  canDelete={can("board.attachments.delete") && mutate}
                  onPick={(file) => void startUpload(file)}
                  onOpen={(file) => void openAttachment(file)}
                  onDelete={(id) => {
                    if (!window.confirm("Remove this attachment?")) return;
                    void deleteStaffAttachment(token, id).then(load);
                  }}
                />
                <TaskRelationsSection
                  relations={task.relations}
                  canEdit={mutate}
                  onLink={(payload) => {
                    void addStaffRelation(token, task.id, payload).then((body) => setTask(body.task));
                  }}
                />
                <div className="task-modal-actions">
                  <button type="button" className="task-modal-ghost" onClick={onClose}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="task-modal-primary"
                    onClick={() => {
                      flushDescription();
                      onClose();
                    }}
                  >
                    {isFresh ? "Create task" : "Save changes"}
                  </button>
                </div>
              </div>
              <TaskMetaSidebar
                comments={task.comments}
                commentDraft={comment}
                canComment={can("board.comments.create")}
                currentStaffId={me?.staff.id}
                canModerateComments={can("board.comments.delete")}
                onCommentDraft={setComment}
                onCommentSubmit={() => {
                  if (!comment.trim()) return;
                  void commentStaffTask(token, task.id, comment.trim()).then((body) => {
                    setComment("");
                    setTask(body.task);
                  });
                }}
                onCommentEdit={(commentId, body) => {
                  void editStaffComment(token, commentId, body).then((result) => setTask(result.task));
                }}
                onCommentDelete={(commentId) => {
                  if (!window.confirm("Delete this comment?")) return;
                  void deleteStaffComment(token, commentId).then(load);
                }}
                activity={task.activity}
                people={people}
                assignees={task.assignees}
                canAssign={mutate && can("board.cards.assign")}
                onToggleAssignee={(person) => void toggleAssignee(person)}
                watching={task.watching}
                onToggleWatch={() => void watchStaffTask(token, task.id, !task.watching).then(load)}
                canDelete={can("board.cards.delete") && mutate}
                onDelete={() => {
                  if (!window.confirm("Delete this card?")) return;
                  void archiveStaffTask(token, task.id).then(() => {
                    onTaskArchived?.(task.id);
                    onClose();
                  });
                }}
              />
            </div>
          </>
        )}
      </aside>
      {lightbox ? (
        <TaskAttachmentLightbox title={lightbox.title} url={lightbox.url} mime={lightbox.mime} onClose={() => setLightbox(null)} />
      ) : null}
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
