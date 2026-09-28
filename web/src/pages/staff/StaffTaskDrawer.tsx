import { useEffect, useRef, useState } from "react";
import { useAuth } from "../../lib/auth";
import {
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
import { taskFromSnapshot, type StaffTaskCardPatch } from "./boardUi";
import { TaskAttachmentLightbox } from "./taskModal/TaskAttachmentLightbox";
import { TaskAttachmentsSection } from "./taskModal/TaskAttachmentsSection";
import { TaskActivityPanel } from "./taskModal/TaskActivityPanel";
import { TaskCommentsPanel } from "./taskModal/TaskCommentsPanel";
import { TaskDangerZone } from "./taskModal/TaskDangerZone";
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
  const [titleDraft, setTitleDraft] = useState(snapshot?.id === taskId ? snapshot.title : "");
  const [descDraft, setDescDraft] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [uploadLabel, setUploadLabel] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<{ title: string; url: string; mime: string | null } | null>(null);
  const dirty = useRef(false);
  const titleTimer = useRef(0);
  const descTimer = useRef(0);
  const savedTimer = useRef(0);
  const titleDraftRef = useRef(titleDraft);
  const descDraftRef = useRef(descDraft);
  const taskRef = useRef(task);
  titleDraftRef.current = titleDraft;
  descDraftRef.current = descDraft;
  taskRef.current = task;

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

  function markSaving() {
    window.clearTimeout(savedTimer.current);
    setSaveState("saving");
  }

  function markSaved() {
    setSaveState("saved");
    window.clearTimeout(savedTimer.current);
    savedTimer.current = window.setTimeout(() => setSaveState("idle"), 1600);
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
    if (!dirty.current) {
      setTitleDraft(detail.task.title);
      setDescDraft(detail.task.description ?? "");
    }
  }

  useEffect(() => {
    dirty.current = false;
    setError(null);
    setComment("");
    setSaveState("idle");
    if (snapshot && snapshot.id === taskId) {
      const seeded = taskFromSnapshot(snapshot, board);
      setTask(seeded);
      setTitleDraft(seeded.title);
      setDescDraft("");
    } else {
      setTask((current) => (current?.id === taskId ? current : null));
    }
    void load().catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Could not load task."));
    const refresh = window.setInterval(() => {
      if (!dirty.current) void load().catch(() => undefined);
    }, 20_000);
    return () => {
      window.clearInterval(refresh);
      window.clearTimeout(titleTimer.current);
      window.clearTimeout(descTimer.current);
      window.clearTimeout(savedTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, token]);

  async function patch(body: Record<string, unknown>, optimistic: Partial<StaffTaskDetail>) {
    if (!token || !task) return;
    const previous = task;
    markSaving();
    apply({ ...task, ...optimistic });
    try {
      const result = await patchStaffTask(token, task.id, body);
      dirty.current = false;
      setTask(result.task);
      emit(result.task);
      markSaved();
    } catch (caught) {
      setTask(previous);
      emit(previous);
      setSaveState("idle");
      setError(caught instanceof Error ? caught.message : "Could not update task.");
    }
  }

  function flushTitle() {
    const current = taskRef.current;
    const next = titleDraftRef.current.trim();
    if (!current || !next || next === current.title) return;
    void patch({ title: next }, { title: next });
  }

  function flushDescription() {
    const current = taskRef.current;
    if (!current) return;
    const next = descDraftRef.current;
    if (next === (current.description ?? "")) return;
    void patch({ description: next }, { description: next });
  }

  function scheduleTitle(value: string) {
    setTitleDraft(value);
    titleDraftRef.current = value;
    window.clearTimeout(titleTimer.current);
    titleTimer.current = window.setTimeout(() => flushTitle(), 500);
  }

  function scheduleDescription(value: string) {
    setDescDraft(value);
    descDraftRef.current = value;
    window.clearTimeout(descTimer.current);
    descTimer.current = window.setTimeout(() => flushDescription(), 700);
  }

  function requestClose() {
    window.clearTimeout(titleTimer.current);
    window.clearTimeout(descTimer.current);
    flushTitle();
    flushDescription();
    onClose();
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") requestClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose]);

  async function toggleAssignee(person: { id: string; displayName: string }) {
    if (!token || !task) return;
    const on = task.assignees.some((item) => item.id === person.id);
    const nextPeople = on ? task.assignees.filter((item) => item.id !== person.id) : [...task.assignees, person];
    const previous = task;
    markSaving();
    apply({ ...task, assignees: nextPeople });
    try {
      const result = await setStaffAssignees(token, task.id, nextPeople.map((item) => item.id));
      dirty.current = false;
      setTask(result.task);
      emit(result.task);
      markSaved();
    } catch (caught) {
      setTask(previous);
      emit(previous);
      setSaveState("idle");
      setError(caught instanceof Error ? caught.message : "Could not update assignees.");
    }
  }

  async function toggleLabel(labelId: string) {
    if (!token || !task) return;
    const on = task.labelIds.includes(labelId);
    const next = on ? task.labelIds.filter((id) => id !== labelId) : [...task.labelIds, labelId];
    const previous = task;
    markSaving();
    apply({ ...task, labelIds: next });
    try {
      const result = await setStaffTaskLabels(token, task.id, next);
      dirty.current = false;
      setTask(result.task);
      emit(result.task);
      markSaved();
    } catch (caught) {
      setTask(previous);
      emit(previous);
      setSaveState("idle");
      setError(caught instanceof Error ? caught.message : "Could not update labels.");
    }
  }

  async function toggleWatch() {
    if (!token || !task) return;
    const previous = task;
    const next = !task.watching;
    markSaving();
    apply({ ...task, watching: next });
    try {
      await watchStaffTask(token, task.id, next);
      dirty.current = false;
      markSaved();
    } catch (caught) {
      setTask(previous);
      emit(previous);
      setSaveState("idle");
      setError(caught instanceof Error ? caught.message : "Could not update watchers.");
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
    markSaving();
    apply({ ...task, columnId });
    try {
      await moveStaffTask(token, task.id, { columnId, afterRank: null, beforeRank: null });
      const result = await fetchStaffTask(token, task.id);
      dirty.current = false;
      setTask(result.task);
      emit(result.task);
      markSaved();
    } catch (caught) {
      setTask(previous);
      emit(previous);
      setSaveState("idle");
      setError(caught instanceof Error ? caught.message : "Could not move card.");
    }
  }

  const people = board?.people?.length ? board.people : task?.assignees ?? [];
  const mutate = Boolean(task?.canMutate);
  const hydrating = Boolean(task && !task.createdAt);
  const canEdit = mutate && can("board.cards.edit");
  const columns = board?.columns.length ? board.columns : task ? [{ id: task.columnId, name: "List" }] : [];
  const columnName = columns.find((column) => column.id === task?.columnId)?.name ?? "List";
  const canMove = can("board.cards.move") && mutate && Boolean(board);

  return (
    <>
      <button type="button" className="ops-drawer-backdrop task-modal-backdrop" aria-label="Close task" onClick={requestClose} />
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
              boardName={board?.name || "Operations"}
              columnId={task.columnId || ""}
              columnName={columnName}
              columns={columns}
              canMove={canMove}
              saveState={saveState}
              onMove={(columnId) => void moveToColumn(columnId)}
              onClose={requestClose}
            />
            {error ? <p className="ops-error">{error}</p> : null}
            {hydrating ? <p className="ops-drawer-status">Loading details…</p> : null}
            <TaskTitleField
              value={titleDraft}
              enabled={canEdit}
              onChange={scheduleTitle}
              onCommit={flushTitle}
            />
            <div className="task-modal-body">
              <div className="task-modal-grid">
              <TaskDescriptionEditor
                value={descDraft}
                enabled={canEdit}
                onChange={scheduleDescription}
                onBlur={flushDescription}
              />
              <TaskRelationsSection
                relations={task.relations}
                canEdit={mutate}
                onLink={(payload) => {
                  void addStaffRelation(token, task.id, payload).then((body) => setTask(body.task));
                }}
              />
              <TaskCommentsPanel
                comments={task.comments}
                draft={comment}
                canComment={can("board.comments.create")}
                currentStaffId={me?.staff.id}
                canModerate={can("board.comments.delete")}
                onDraftChange={setComment}
                onSubmit={() => {
                  if (!comment.trim()) return;
                  void commentStaffTask(token, task.id, comment.trim()).then((body) => {
                    setComment("");
                    setTask(body.task);
                  });
                }}
                onEdit={(commentId, body) => {
                  void editStaffComment(token, commentId, body).then((result) => setTask(result.task));
                }}
                onDelete={(commentId) => {
                  if (!window.confirm("Delete this comment?")) return;
                  void deleteStaffComment(token, commentId).then(load);
                }}
              />
              <TaskMetaSidebar
                columnId={task.columnId}
                columns={columns}
                canMove={canMove}
                onMove={(columnId) => void moveToColumn(columnId)}
                priority={task.priority}
                canEdit={canEdit}
                onPriority={(priority) => void patch({ priority }, { priority })}
                watching={task.watching}
                onToggleWatch={() => void toggleWatch()}
                people={people}
                assignees={task.assignees}
                canAssign={mutate && can("board.cards.assign")}
                onToggleAssignee={(person) => void toggleAssignee(person)}
                labels={board?.labels ?? []}
                selectedLabelIds={task.labelIds}
                onToggleLabel={(labelId) => void toggleLabel(labelId)}
                dueAt={task.dueAt}
                onDueAt={(value) => void patch({ dueAt: value }, { dueAt: value })}
              />
              <TaskActivityPanel activity={task.activity} columns={columns} />
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
            </div>
            {task.checklists.map((list) => (
              <section key={list.id} className="task-modal-extra-card">
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
              <section className="task-modal-extra-card">
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
            </div>
            <footer className="task-modal-footer">
              {can("board.cards.delete") && mutate ? (
                <TaskDangerZone
                  onDelete={() => {
                    if (!window.confirm("Delete this card?")) return;
                    void archiveStaffTask(token, task.id).then(() => {
                      onTaskArchived?.(task.id);
                      onClose();
                    });
                  }}
                />
              ) : (
                <span />
              )}
            </footer>
          </>
        )}
      </aside>
      {lightbox ? (
        <TaskAttachmentLightbox title={lightbox.title} url={lightbox.url} mime={lightbox.mime} onClose={() => setLightbox(null)} />
      ) : null}
    </>
  );
}
