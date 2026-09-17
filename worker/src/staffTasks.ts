import { AwsClient } from "aws4fetch";
import type { Env } from "./env";
import { HttpError, json } from "./http";
import { rankAfter, rankBetween } from "./lexorank";
import { insertNotifications } from "./social";
import { serviceRest, signedObjectUrl } from "./shared";
import { requirePermission, type StaffActor } from "./staffAuth";
import { assertCanMutate, requireBoardAccess } from "./staffBoards";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRIORITIES = new Set(["none", "low", "medium", "high", "urgent"]);
const RELATION_KINDS = new Set(["clip", "user", "screenshot", "folder", "creator_application", "error_fingerprint", "url"]);
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MENTION = /@([a-z0-9_]{2,32})/gi;

type TaskRow = {
  id: string;
  board_id: string;
  column_id: string;
  title: string;
  description: string | null;
  rank: string;
  priority: string;
  created_by: string | null;
  due_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

export async function handleStaffTasks(request: Request, env: Env, url: URL): Promise<Response | null> {
  const path = url.pathname;
  const method = request.method;

  if (method === "GET" && path === "/v1/staff/tasks") {
    const actor = await requirePermission(request, env, "board.view");
    return listMyTasks(env, actor, url);
  }
  if (method === "POST" && path === "/v1/staff/tasks") {
    const actor = await requirePermission(request, env, "board.cards.create");
    return createStandaloneTask(request, env, actor);
  }

  const taskItem = path.match(/^\/v1\/staff\/tasks\/([^/]+)$/);
  if (taskItem?.[1] && UUID.test(taskItem[1])) {
    if (method === "GET") {
      const actor = await requirePermission(request, env, "board.view");
      return getTask(env, actor, taskItem[1]);
    }
    if (method === "PATCH") {
      const actor = await requirePermission(request, env, "board.cards.edit");
      return patchTask(request, env, actor, taskItem[1]);
    }
    if (method === "DELETE") {
      const actor = await requirePermission(request, env, "board.cards.delete");
      return archiveTask(env, actor, taskItem[1]);
    }
  }

  const move = path.match(/^\/v1\/staff\/tasks\/([^/]+)\/move$/);
  if (move?.[1] && method === "POST") {
    const actor = await requirePermission(request, env, "board.cards.move");
    return moveTask(request, env, actor, move[1]);
  }
  const assignees = path.match(/^\/v1\/staff\/tasks\/([^/]+)\/assignees$/);
  if (assignees?.[1] && method === "PUT") {
    const actor = await requirePermission(request, env, "board.cards.assign");
    return setAssignees(request, env, actor, assignees[1]);
  }
  const labels = path.match(/^\/v1\/staff\/tasks\/([^/]+)\/labels$/);
  if (labels?.[1] && method === "PUT") {
    const actor = await requirePermission(request, env, "board.cards.edit");
    return setTaskLabels(request, env, actor, labels[1]);
  }
  const watch = path.match(/^\/v1\/staff\/tasks\/([^/]+)\/watch$/);
  if (watch?.[1]) {
    const actor = await requirePermission(request, env, "board.view");
    if (method === "POST") return setWatch(env, actor, watch[1], true);
    if (method === "DELETE") return setWatch(env, actor, watch[1], false);
  }
  const comments = path.match(/^\/v1\/staff\/tasks\/([^/]+)\/comments$/);
  if (comments?.[1] && method === "POST") {
    const actor = await requirePermission(request, env, "board.comments.create");
    return addComment(request, env, actor, comments[1]);
  }
  const commentItem = path.match(/^\/v1\/staff\/comments\/([^/]+)$/);
  if (commentItem?.[1] && method === "DELETE") {
    const actor = await requirePermission(request, env, "board.comments.delete");
    return deleteComment(env, actor, commentItem[1]);
  }
  const checklists = path.match(/^\/v1\/staff\/tasks\/([^/]+)\/checklists$/);
  if (checklists?.[1] && method === "POST") {
    const actor = await requirePermission(request, env, "board.checklists.manage");
    return addChecklist(request, env, actor, checklists[1]);
  }
  const checklistItem = path.match(/^\/v1\/staff\/checklists\/([^/]+)$/);
  if (checklistItem?.[1] && UUID.test(checklistItem[1])) {
    if (method === "PATCH") {
      const actor = await requirePermission(request, env, "board.checklists.manage");
      return patchChecklist(request, env, actor, checklistItem[1]);
    }
    if (method === "DELETE") {
      const actor = await requirePermission(request, env, "board.checklists.manage");
      return deleteChecklist(env, actor, checklistItem[1]);
    }
  }
  const checklistItems = path.match(/^\/v1\/staff\/checklists\/([^/]+)\/items$/);
  if (checklistItems?.[1] && method === "POST") {
    const actor = await requirePermission(request, env, "board.checklists.manage");
    return addChecklistItem(request, env, actor, checklistItems[1]);
  }
  const itemPath = path.match(/^\/v1\/staff\/checklist-items\/([^/]+)$/);
  if (itemPath?.[1] && UUID.test(itemPath[1])) {
    if (method === "PATCH") {
      const actor = await requirePermission(request, env, "board.checklists.manage");
      return patchChecklistItem(request, env, actor, itemPath[1]);
    }
    if (method === "DELETE") {
      const actor = await requirePermission(request, env, "board.checklists.manage");
      return deleteChecklistItem(env, actor, itemPath[1]);
    }
  }
  const subtasks = path.match(/^\/v1\/staff\/tasks\/([^/]+)\/subtasks$/);
  if (subtasks?.[1] && method === "POST") {
    const actor = await requirePermission(request, env, "board.checklists.manage");
    return addSubtask(request, env, actor, subtasks[1]);
  }
  const subtaskItem = path.match(/^\/v1\/staff\/subtasks\/([^/]+)$/);
  if (subtaskItem?.[1] && UUID.test(subtaskItem[1])) {
    if (method === "PATCH") {
      const actor = await requirePermission(request, env, "board.checklists.manage");
      return patchSubtask(request, env, actor, subtaskItem[1]);
    }
    if (method === "DELETE") {
      const actor = await requirePermission(request, env, "board.checklists.manage");
      return deleteSubtask(env, actor, subtaskItem[1]);
    }
  }
  const attachments = path.match(/^\/v1\/staff\/tasks\/([^/]+)\/attachments$/);
  if (attachments?.[1] && method === "POST") {
    const actor = await requirePermission(request, env, "board.attachments.upload");
    return createAttachment(request, env, actor, attachments[1]);
  }
  const attachmentUrl = path.match(/^\/v1\/staff\/attachments\/([^/]+)\/url$/);
  if (attachmentUrl?.[1] && method === "GET") {
    const actor = await requirePermission(request, env, "board.view");
    return attachmentDownload(env, actor, attachmentUrl[1]);
  }
  const attachmentItem = path.match(/^\/v1\/staff\/attachments\/([^/]+)$/);
  if (attachmentItem?.[1] && method === "DELETE") {
    const actor = await requirePermission(request, env, "board.attachments.delete");
    return deleteAttachment(env, actor, attachmentItem[1]);
  }
  const relations = path.match(/^\/v1\/staff\/tasks\/([^/]+)\/relations$/);
  if (relations?.[1] && method === "POST") {
    const actor = await requirePermission(request, env, "board.cards.edit");
    return addRelation(request, env, actor, relations[1]);
  }
  const relationItem = path.match(/^\/v1\/staff\/relations\/([^/]+)$/);
  if (relationItem?.[1] && method === "DELETE") {
    const actor = await requirePermission(request, env, "board.cards.edit");
    return deleteRelation(env, actor, relationItem[1]);
  }

  return null;
}

async function createStandaloneTask(request: Request, env: Env, actor: StaffActor): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { boardId?: string; columnId?: string; title?: string; relation?: unknown };
  if (typeof body.boardId !== "string") throw new HttpError(400, "boardId is required.");
  const inner = new Request(request.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const { handleStaffBoards } = await import("./staffBoards");
  const response = await handleStaffBoards(
    new Request(`${new URL(request.url).origin}/v1/staff/boards/${body.boardId}/tasks`, inner),
    env,
    new URL(`/v1/staff/boards/${body.boardId}/tasks`, request.url),
  );
  if (!response) throw new HttpError(400, "Could not create task.");
  return response;
}

async function listMyTasks(env: Env, actor: StaffActor, url: URL): Promise<Response> {
  const q = (url.searchParams.get("q") || "").replace(/[,()*]/g, "").trim().slice(0, 80);
  const filter = url.searchParams.get("filter") || "assigned";
  const page = Math.max(1, Math.floor(Number(url.searchParams.get("page") || 1)) || 1);
  const limit = Math.min(50, Math.max(1, Math.floor(Number(url.searchParams.get("limit") || 30)) || 30));
  const from = (page - 1) * limit;
  let taskIds: string[] | null = null;
  if (filter === "assigned" || filter === "watching") {
    const table = filter === "assigned" ? "staff_task_assignees" : "staff_task_watchers";
    const rows = await serviceRest<Array<{ task_id: string }>>(
      env,
      "GET",
      `/${table}?staff_id=eq.${actor.staffId}&select=task_id`,
    );
    taskIds = rows.map((row) => row.task_id);
    if (!taskIds.length) return json({ tasks: [], total: 0, page, limit });
  }
  const filters = [
    "select=id,board_id,column_id,title,rank,priority,created_by,due_at,started_at,completed_at,archived_at,created_at,updated_at",
    "archived_at=is.null",
    "order=due_at.asc.nullslast,updated_at.desc",
  ];
  if (taskIds) filters.push(`id=in.(${taskIds.join(",")})`);
  else if (filter === "created") filters.push(`created_by=eq.${actor.staffId}`);
  if (q) filters.push(`title=ilike.*${q}*`);
  const priority = (url.searchParams.get("priority") || "").trim();
  if (PRIORITIES.has(priority)) filters.push(`priority=eq.${priority}`);
  const due = url.searchParams.get("due");
  if (due === "overdue") filters.push(`due_at=lt.${new Date().toISOString()}`, "completed_at=is.null");
  const tasks = await serviceRest<TaskRow[]>(env, "GET", `/staff_tasks?${filters.join("&")}&limit=${limit}&offset=${from}`);
  const visible = [];
  for (const task of tasks) {
    try {
      await requireBoardAccess(env, actor, task.board_id);
      visible.push(task);
    } catch (caught) {
      if (caught instanceof HttpError && caught.status === 403) continue;
      throw caught;
    }
  }
  return json({
    tasks: visible.map((task) => ({
      id: task.id,
      boardId: task.board_id,
      columnId: task.column_id,
      title: task.title,
      priority: task.priority,
      dueAt: task.due_at,
      completedAt: task.completed_at,
      updatedAt: task.updated_at,
    })),
    page,
    limit,
    total: visible.length,
  });
}

async function getTask(env: Env, actor: StaffActor, taskId: string): Promise<Response> {
  const task = await mustTask(env, taskId);
  const access = await requireBoardAccess(env, actor, task.board_id);
  const [assignees, labels, checklists, subtasks, comments, attachments, relations, watchers, activity] = await Promise.all([
    serviceRest<Array<{
      staff_id: string;
      staff_members: { display_name: string } | Array<{ display_name: string }>;
    }>>(env, "GET", `/staff_task_assignees?task_id=eq.${taskId}&select=staff_id,staff_members(display_name)`),
    serviceRest<Array<{ label_id: string }>>(env, "GET", `/staff_task_labels?task_id=eq.${taskId}&select=label_id`),
    serviceRest<Array<{ id: string; title: string; rank: string }>>(
      env,
      "GET",
      `/staff_task_checklists?task_id=eq.${taskId}&select=id,title,rank&order=rank.asc`,
    ),
    serviceRest<Array<{ id: string; title: string; assignee_staff_id: string | null; done: boolean; rank: string }>>(
      env,
      "GET",
      `/staff_task_subtasks?task_id=eq.${taskId}&select=id,title,assignee_staff_id,done,rank&order=rank.asc`,
    ),
    serviceRest<Array<{
      id: string;
      parent_id: string | null;
      author_staff_id: string | null;
      body: string;
      created_at: string;
    }>>(
      env,
      "GET",
      `/staff_task_comments?task_id=eq.${taskId}&select=id,parent_id,author_staff_id,body,created_at&order=created_at.asc`,
    ),
    serviceRest<Array<{ id: string; filename: string; mime: string | null; bytes: number | null; created_at: string }>>(
      env,
      "GET",
      `/staff_task_attachments?task_id=eq.${taskId}&select=id,filename,mime,bytes,created_at&order=created_at.asc`,
    ),
    serviceRest<Array<{ id: string; kind: string; target_id: string; label: string | null }>>(
      env,
      "GET",
      `/staff_task_relations?task_id=eq.${taskId}&select=id,kind,target_id,label`,
    ),
    serviceRest<Array<{ staff_id: string }>>(env, "GET", `/staff_task_watchers?task_id=eq.${taskId}&select=staff_id`),
    serviceRest<Array<{
      id: string;
      action: string;
      metadata: Record<string, unknown>;
      created_at: string;
      actor_staff_id: string | null;
    }>>(env, "GET", `/staff_task_activity?task_id=eq.${taskId}&select=id,action,metadata,created_at,actor_staff_id&order=created_at.desc&limit=80`),
  ]);
  const checklistIds = checklists.map((row) => row.id);
  const items = checklistIds.length
    ? await serviceRest<Array<{ id: string; checklist_id: string; title: string; done: boolean; rank: string }>>(
        env,
        "GET",
        `/staff_task_checklist_items?checklist_id=in.(${checklistIds.join(",")})&select=id,checklist_id,title,done,rank&order=rank.asc`,
      )
    : [];
  const authorIds = [...new Set(comments.map((row) => row.author_staff_id).filter((id): id is string => Boolean(id)))];
  const commentAuthors = authorIds.length
    ? await serviceRest<Array<{ id: string; display_name: string }>>(
        env,
        "GET",
        `/staff_members?id=in.(${authorIds.join(",")})&select=id,display_name`,
      )
    : [];
  const authorById = new Map(commentAuthors.map((row) => [row.id, row.display_name]));
  return json({
    task: {
      id: task.id,
      boardId: task.board_id,
      columnId: task.column_id,
      title: task.title,
      description: task.description,
      rank: task.rank,
      priority: task.priority,
      dueAt: task.due_at,
      startedAt: task.started_at,
      completedAt: task.completed_at,
      archivedAt: task.archived_at,
      createdAt: task.created_at,
      updatedAt: task.updated_at,
      boardRole: access.boardRole,
      canMutate: access.canMutate,
      watching: watchers.some((row) => row.staff_id === actor.staffId),
      assignees: assignees.map((row) => ({
        id: row.staff_id,
        displayName: (Array.isArray(row.staff_members) ? row.staff_members[0] : row.staff_members)?.display_name ?? "Staff",
      })),
      labelIds: labels.map((row) => row.label_id),
      checklists: checklists.map((list) => ({
        id: list.id,
        title: list.title,
        rank: list.rank,
        items: items
          .filter((item) => item.checklist_id === list.id)
          .map((item) => ({ id: item.id, title: item.title, done: item.done, rank: item.rank })),
      })),
      subtasks: subtasks.map((row) => ({
        id: row.id,
        title: row.title,
        assigneeStaffId: row.assignee_staff_id,
        done: row.done,
        rank: row.rank,
      })),
      comments: comments.map((row) => ({
        id: row.id,
        parentId: row.parent_id,
        authorStaffId: row.author_staff_id,
        authorName: (row.author_staff_id && authorById.get(row.author_staff_id)) || "Staff",
        body: row.body,
        createdAt: row.created_at,
      })),
      attachments: attachments.map((row) => ({
        id: row.id,
        filename: row.filename,
        mime: row.mime,
        bytes: row.bytes,
        createdAt: row.created_at,
      })),
      relations: relations.map((row) => ({
        id: row.id,
        kind: row.kind,
        targetId: row.target_id,
        label: row.label,
      })),
      activity: activity.map((row) => ({
        id: row.id,
        action: row.action,
        metadata: row.metadata,
        createdAt: row.created_at,
        actorStaffId: row.actor_staff_id,
      })),
    },
  });
}

async function patchTask(request: Request, env: Env, actor: StaffActor, taskId: string): Promise<Response> {
  const task = await mustTask(env, taskId);
  const access = await requireBoardAccess(env, actor, task.board_id, "board.cards.edit");
  assertCanMutate(access);
  const body = (await request.json().catch(() => ({}))) as {
    title?: string;
    description?: string | null;
    priority?: string;
    dueAt?: string | null;
    completed?: boolean;
  };
  const patch: Record<string, unknown> = {};
  const before: Record<string, unknown> = {};
  if (typeof body.title === "string" && body.title.trim()) {
    before.title = task.title;
    patch.title = body.title.trim().slice(0, 200);
  }
  if ("description" in body) {
    before.description = task.description;
    patch.description = typeof body.description === "string" ? body.description.slice(0, 20_000) : null;
  }
  if (typeof body.priority === "string" && PRIORITIES.has(body.priority)) {
    before.priority = task.priority;
    patch.priority = body.priority;
  }
  if ("dueAt" in body) {
    before.dueAt = task.due_at;
    patch.due_at = typeof body.dueAt === "string" ? body.dueAt : null;
  }
  if (typeof body.completed === "boolean") {
    before.completedAt = task.completed_at;
    patch.completed_at = body.completed ? new Date().toISOString() : null;
    if (body.completed && !task.started_at) patch.started_at = new Date().toISOString();
  }
  if (!Object.keys(patch).length) throw new HttpError(400, "Nothing to update.");
  await serviceRest(env, "PATCH", `/staff_tasks?id=eq.${taskId}`, patch);
  await addActivity(env, taskId, actor.staffId, "updated", patch);
  return getTask(env, actor, taskId);
}

async function archiveTask(env: Env, actor: StaffActor, taskId: string): Promise<Response> {
  const task = await mustTask(env, taskId);
  const access = await requireBoardAccess(env, actor, task.board_id, "board.cards.delete");
  assertCanMutate(access);
  await serviceRest(env, "PATCH", `/staff_tasks?id=eq.${taskId}`, { archived_at: new Date().toISOString() });
  await addActivity(env, taskId, actor.staffId, "archived", {});
  return json({ ok: true });
}

async function moveTask(request: Request, env: Env, actor: StaffActor, taskId: string): Promise<Response> {
  const task = await mustTask(env, taskId);
  const access = await requireBoardAccess(env, actor, task.board_id, "board.cards.move");
  assertCanMutate(access);
  const body = (await request.json().catch(() => ({}))) as {
    columnId?: string;
    beforeRank?: string | null;
    afterRank?: string | null;
  };
  const columnId = typeof body.columnId === "string" && UUID.test(body.columnId) ? body.columnId : task.column_id;
  const columns = await serviceRest<Array<{ id: string; board_id: string }>>(
    env,
    "GET",
    `/staff_board_columns?id=eq.${columnId}&select=id,board_id`,
  );
  if (!columns[0] || columns[0].board_id !== task.board_id) throw new HttpError(400, "Column does not belong to this board.");
  const rank = rankBetween(body.beforeRank, body.afterRank);
  await serviceRest(env, "PATCH", `/staff_tasks?id=eq.${taskId}`, { column_id: columnId, rank });
  await addActivity(env, taskId, actor.staffId, "moved", { columnId, rank });
  return json({ ok: true, rank, columnId });
}

async function setAssignees(request: Request, env: Env, actor: StaffActor, taskId: string): Promise<Response> {
  const task = await mustTask(env, taskId);
  const access = await requireBoardAccess(env, actor, task.board_id, "board.cards.assign");
  assertCanMutate(access);
  const body = (await request.json().catch(() => ({}))) as { staffIds?: string[] };
  const staffIds = Array.isArray(body.staffIds)
    ? [...new Set(body.staffIds.filter((id): id is string => typeof id === "string" && UUID.test(id)))]
    : [];
  if (Array.isArray(body.staffIds) && staffIds.length !== body.staffIds.length) {
    throw new HttpError(400, "One or more assignee ids are invalid.");
  }
  await assertBoardMembers(env, task.board_id, staffIds);
  const previous = await serviceRest<Array<{ staff_id: string }>>(env, "GET", `/staff_task_assignees?task_id=eq.${taskId}&select=staff_id`);
  await serviceRest(env, "DELETE", `/staff_task_assignees?task_id=eq.${taskId}`);
  if (staffIds.length) {
    await serviceRest(
      env,
      "POST",
      "/staff_task_assignees",
      staffIds.map((staff_id) => ({ task_id: taskId, staff_id })),
    );
  }
  for (const staffId of staffIds) {
    await serviceRest(env, "POST", "/staff_task_watchers", { task_id: taskId, staff_id: staffId }).catch(() => undefined);
  }
  const added = staffIds.filter((id) => !previous.some((row) => row.staff_id === id));
  await notifyStaff(env, actor, task, added, "staff_task_assigned");
  await addActivity(env, taskId, actor.staffId, "assigned", { staffIds });
  return getTask(env, actor, taskId);
}

async function setTaskLabels(request: Request, env: Env, actor: StaffActor, taskId: string): Promise<Response> {
  const task = await mustTask(env, taskId);
  const access = await requireBoardAccess(env, actor, task.board_id, "board.cards.edit");
  assertCanMutate(access);
  const body = (await request.json().catch(() => ({}))) as { labelIds?: string[] };
  const labelIds = Array.isArray(body.labelIds)
    ? body.labelIds.filter((id): id is string => typeof id === "string" && UUID.test(id))
    : [];
  if (Array.isArray(body.labelIds) && labelIds.length !== body.labelIds.length) {
    throw new HttpError(400, "One or more label ids are invalid.");
  }
  if (labelIds.length) {
    const boardLabels = await serviceRest<Array<{ id: string }>>(
      env,
      "GET",
      `/staff_labels?board_id=eq.${task.board_id}&id=in.(${labelIds.join(",")})&select=id`,
    );
    const found = new Set(boardLabels.map((row) => row.id));
    if (labelIds.some((id) => !found.has(id))) throw new HttpError(400, "Labels must belong to this board.");
  }
  await serviceRest(env, "DELETE", `/staff_task_labels?task_id=eq.${taskId}`);
  if (labelIds.length) {
    await serviceRest(
      env,
      "POST",
      "/staff_task_labels",
      labelIds.map((label_id) => ({ task_id: taskId, label_id })),
    );
  }
  return getTask(env, actor, taskId);
}

async function setWatch(env: Env, actor: StaffActor, taskId: string, watch: boolean): Promise<Response> {
  const task = await mustTask(env, taskId);
  await requireBoardAccess(env, actor, task.board_id);
  if (watch) {
    await assertBoardMembers(env, task.board_id, [actor.staffId]);
    await serviceRest(env, "POST", "/staff_task_watchers", { task_id: taskId, staff_id: actor.staffId }).catch(() => undefined);
  } else {
    await serviceRest(env, "DELETE", `/staff_task_watchers?task_id=eq.${taskId}&staff_id=eq.${actor.staffId}`);
  }
  return json({ watching: watch });
}

async function addComment(request: Request, env: Env, actor: StaffActor, taskId: string): Promise<Response> {
  const task = await mustTask(env, taskId);
  const access = await requireBoardAccess(env, actor, task.board_id, "board.comments.create");
  assertCanMutate(access);
  const body = (await request.json().catch(() => ({}))) as { body?: string; parentId?: string | null };
  const text = typeof body.body === "string" ? body.body.trim().slice(0, 8000) : "";
  if (!text) throw new HttpError(400, "Comment cannot be empty.");
  const created = await serviceRest<Array<{ id: string }>>(
    env,
    "POST",
    "/staff_task_comments",
    {
      task_id: taskId,
      parent_id: typeof body.parentId === "string" && UUID.test(body.parentId) ? body.parentId : null,
      author_staff_id: actor.staffId,
      body: text,
    },
    "return=representation",
  );
  if (await isBoardMember(env, task.board_id, actor.staffId)) {
    await serviceRest(env, "POST", "/staff_task_watchers", { task_id: taskId, staff_id: actor.staffId }).catch(() => undefined);
  }
  const mentioned = await resolveMentions(env, task.board_id, text);
  for (const staffId of mentioned) {
    await serviceRest(env, "POST", "/staff_task_watchers", { task_id: taskId, staff_id: staffId }).catch(() => undefined);
  }
  await notifyStaff(env, actor, task, mentioned, "staff_task_mentioned");
  const watchers = await watcherUserIds(env, taskId, task.board_id, [...mentioned, actor.staffId]);
  await notifyUsers(env, actor.userId, watchers, "staff_task_comment", task.id);
  await addActivity(env, taskId, actor.staffId, "commented", { commentId: created[0]?.id });
  return getTask(env, actor, taskId);
}

async function deleteComment(env: Env, actor: StaffActor, commentId: string): Promise<Response> {
  if (!UUID.test(commentId)) throw new HttpError(400, "Comment id is invalid.");
  const rows = await serviceRest<Array<{ id: string; task_id: string; author_staff_id: string | null }>>(
    env,
    "GET",
    `/staff_task_comments?id=eq.${commentId}&select=id,task_id,author_staff_id`,
  );
  const comment = rows[0];
  if (!comment) throw new HttpError(404, "Comment not found.");
  const task = await mustTask(env, comment.task_id);
  const access = await requireBoardAccess(env, actor, task.board_id, "board.comments.delete");
  if (comment.author_staff_id !== actor.staffId && access.boardRole !== "admin" && !actor.isSuperAdmin) {
    throw new HttpError(403, "You can only delete your own comments.");
  }
  await serviceRest(env, "DELETE", `/staff_task_comments?id=eq.${commentId}`);
  return json({ ok: true });
}

async function addChecklist(request: Request, env: Env, actor: StaffActor, taskId: string): Promise<Response> {
  const task = await mustTask(env, taskId);
  const access = await requireBoardAccess(env, actor, task.board_id, "board.checklists.manage");
  assertCanMutate(access);
  const body = (await request.json().catch(() => ({}))) as { title?: string };
  const title = typeof body.title === "string" ? body.title.trim().slice(0, 80) : "Checklist";
  const last = await serviceRest<Array<{ rank: string }>>(
    env,
    "GET",
    `/staff_task_checklists?task_id=eq.${taskId}&select=rank&order=rank.desc&limit=1`,
  );
  await serviceRest(env, "POST", "/staff_task_checklists", { task_id: taskId, title, rank: rankAfter(last[0]?.rank) });
  await addActivity(env, taskId, actor.staffId, "checklist", { title });
  return getTask(env, actor, taskId);
}

async function patchChecklist(request: Request, env: Env, actor: StaffActor, checklistId: string): Promise<Response> {
  const list = await mustChecklist(env, checklistId);
  const task = await mustTask(env, list.task_id);
  const access = await requireBoardAccess(env, actor, task.board_id, "board.checklists.manage");
  assertCanMutate(access);
  const body = (await request.json().catch(() => ({}))) as { title?: string };
  if (typeof body.title === "string" && body.title.trim()) {
    await serviceRest(env, "PATCH", `/staff_task_checklists?id=eq.${checklistId}`, { title: body.title.trim().slice(0, 80) });
  }
  return getTask(env, actor, task.id);
}

async function deleteChecklist(env: Env, actor: StaffActor, checklistId: string): Promise<Response> {
  const list = await mustChecklist(env, checklistId);
  const task = await mustTask(env, list.task_id);
  const access = await requireBoardAccess(env, actor, task.board_id, "board.checklists.manage");
  assertCanMutate(access);
  await serviceRest(env, "DELETE", `/staff_task_checklists?id=eq.${checklistId}`);
  return json({ ok: true });
}

async function addChecklistItem(request: Request, env: Env, actor: StaffActor, checklistId: string): Promise<Response> {
  const list = await mustChecklist(env, checklistId);
  const task = await mustTask(env, list.task_id);
  const access = await requireBoardAccess(env, actor, task.board_id, "board.checklists.manage");
  assertCanMutate(access);
  const body = (await request.json().catch(() => ({}))) as { title?: string };
  const title = typeof body.title === "string" ? body.title.trim().slice(0, 200) : "";
  if (!title) throw new HttpError(400, "Title is required.");
  const last = await serviceRest<Array<{ rank: string }>>(
    env,
    "GET",
    `/staff_task_checklist_items?checklist_id=eq.${checklistId}&select=rank&order=rank.desc&limit=1`,
  );
  await serviceRest(env, "POST", "/staff_task_checklist_items", {
    checklist_id: checklistId,
    title,
    rank: rankAfter(last[0]?.rank),
  });
  return getTask(env, actor, task.id);
}

async function patchChecklistItem(request: Request, env: Env, actor: StaffActor, itemId: string): Promise<Response> {
  if (!UUID.test(itemId)) throw new HttpError(400, "Item id is invalid.");
  const items = await serviceRest<Array<{ id: string; checklist_id: string; title: string; done: boolean }>>(
    env,
    "GET",
    `/staff_task_checklist_items?id=eq.${itemId}&select=id,checklist_id,title,done`,
  );
  const item = items[0];
  if (!item) throw new HttpError(404, "Item not found.");
  const list = await mustChecklist(env, item.checklist_id);
  const task = await mustTask(env, list.task_id);
  const access = await requireBoardAccess(env, actor, task.board_id, "board.checklists.manage");
  assertCanMutate(access);
  const body = (await request.json().catch(() => ({}))) as { title?: string; done?: boolean };
  const patch: Record<string, unknown> = {};
  if (typeof body.title === "string" && body.title.trim()) patch.title = body.title.trim().slice(0, 200);
  if (typeof body.done === "boolean") patch.done = body.done;
  await serviceRest(env, "PATCH", `/staff_task_checklist_items?id=eq.${itemId}`, patch);
  return getTask(env, actor, task.id);
}

async function deleteChecklistItem(env: Env, actor: StaffActor, itemId: string): Promise<Response> {
  if (!UUID.test(itemId)) throw new HttpError(400, "Item id is invalid.");
  const items = await serviceRest<Array<{ checklist_id: string }>>(
    env,
    "GET",
    `/staff_task_checklist_items?id=eq.${itemId}&select=checklist_id`,
  );
  if (!items[0]) throw new HttpError(404, "Item not found.");
  const checklist = await mustChecklist(env, items[0].checklist_id);
  const task = await mustTask(env, checklist.task_id);
  const access = await requireBoardAccess(env, actor, task.board_id, "board.checklists.manage");
  assertCanMutate(access);
  await serviceRest(env, "DELETE", `/staff_task_checklist_items?id=eq.${itemId}`);
  return json({ ok: true });
}

async function addSubtask(request: Request, env: Env, actor: StaffActor, taskId: string): Promise<Response> {
  const task = await mustTask(env, taskId);
  const access = await requireBoardAccess(env, actor, task.board_id, "board.checklists.manage");
  assertCanMutate(access);
  const body = (await request.json().catch(() => ({}))) as { title?: string; assigneeStaffId?: string | null };
  const title = typeof body.title === "string" ? body.title.trim().slice(0, 200) : "";
  if (!title) throw new HttpError(400, "Title is required.");
  const assigneeStaffId =
    typeof body.assigneeStaffId === "string" && UUID.test(body.assigneeStaffId) ? body.assigneeStaffId : null;
  if (assigneeStaffId) await assertBoardMembers(env, task.board_id, [assigneeStaffId]);
  const last = await serviceRest<Array<{ rank: string }>>(
    env,
    "GET",
    `/staff_task_subtasks?task_id=eq.${taskId}&select=rank&order=rank.desc&limit=1`,
  );
  await serviceRest(env, "POST", "/staff_task_subtasks", {
    task_id: taskId,
    title,
    assignee_staff_id: assigneeStaffId,
    rank: rankAfter(last[0]?.rank),
  });
  return getTask(env, actor, taskId);
}

async function patchSubtask(request: Request, env: Env, actor: StaffActor, subtaskId: string): Promise<Response> {
  if (!UUID.test(subtaskId)) throw new HttpError(400, "Subtask id is invalid.");
  const rows = await serviceRest<Array<{ id: string; task_id: string }>>(
    env,
    "GET",
    `/staff_task_subtasks?id=eq.${subtaskId}&select=id,task_id`,
  );
  const subtask = rows[0];
  if (!subtask) throw new HttpError(404, "Subtask not found.");
  const task = await mustTask(env, subtask.task_id);
  const access = await requireBoardAccess(env, actor, task.board_id, "board.checklists.manage");
  assertCanMutate(access);
  const body = (await request.json().catch(() => ({}))) as { title?: string; done?: boolean; assigneeStaffId?: string | null };
  const patch: Record<string, unknown> = {};
  if (typeof body.title === "string" && body.title.trim()) patch.title = body.title.trim().slice(0, 200);
  if (typeof body.done === "boolean") patch.done = body.done;
  if ("assigneeStaffId" in body) {
    const assigneeStaffId =
      typeof body.assigneeStaffId === "string" && UUID.test(body.assigneeStaffId) ? body.assigneeStaffId : null;
    if (assigneeStaffId) await assertBoardMembers(env, task.board_id, [assigneeStaffId]);
    patch.assignee_staff_id = assigneeStaffId;
  }
  await serviceRest(env, "PATCH", `/staff_task_subtasks?id=eq.${subtaskId}`, patch);
  return getTask(env, actor, task.id);
}

async function deleteSubtask(env: Env, actor: StaffActor, subtaskId: string): Promise<Response> {
  if (!UUID.test(subtaskId)) throw new HttpError(400, "Subtask id is invalid.");
  const rows = await serviceRest<Array<{ task_id: string }>>(
    env,
    "GET",
    `/staff_task_subtasks?id=eq.${subtaskId}&select=task_id`,
  );
  if (!rows[0]) throw new HttpError(404, "Subtask not found.");
  const task = await mustTask(env, rows[0].task_id);
  const access = await requireBoardAccess(env, actor, task.board_id, "board.checklists.manage");
  assertCanMutate(access);
  await serviceRest(env, "DELETE", `/staff_task_subtasks?id=eq.${subtaskId}`);
  return json({ ok: true });
}

async function createAttachment(request: Request, env: Env, actor: StaffActor, taskId: string): Promise<Response> {
  const task = await mustTask(env, taskId);
  const access = await requireBoardAccess(env, actor, task.board_id, "board.attachments.upload");
  assertCanMutate(access);
  const body = (await request.json().catch(() => ({}))) as { filename?: string; mime?: string; bytes?: number };
  const filename = typeof body.filename === "string" ? body.filename.replace(/[^\w.\- ()]/g, "").slice(0, 120) : "";
  if (!filename) throw new HttpError(400, "Filename is required.");
  const bytes = Number(body.bytes);
  if (!Number.isFinite(bytes) || bytes <= 0 || bytes > MAX_ATTACHMENT_BYTES) {
    throw new HttpError(400, "Attachment must be between 1 byte and 25 MB.");
  }
  const id = crypto.randomUUID();
  const storageKey = `staff/${task.board_id}/${task.id}/${id}`;
  const mime = typeof body.mime === "string" ? body.mime.slice(0, 120) : "application/octet-stream";
  await serviceRest(env, "POST", "/staff_task_attachments", {
    id,
    task_id: taskId,
    storage_key: storageKey,
    filename,
    mime,
    bytes: Math.floor(bytes),
    created_by: actor.staffId,
  });
  const uploadUrl = await signedObjectUrl(env, storageKey, "PUT", { "content-type": mime }, 3600);
  await addActivity(env, taskId, actor.staffId, "attachment", { filename });
  return json({ attachment: { id, filename, bytes }, uploadUrl });
}

async function attachmentDownload(env: Env, actor: StaffActor, attachmentId: string): Promise<Response> {
  const attachment = await mustAttachment(env, attachmentId);
  const task = await mustTask(env, attachment.task_id);
  await requireBoardAccess(env, actor, task.board_id);
  const url = await signedObjectUrl(env, attachment.storage_key, "GET", undefined, 300);
  return json({ url, filename: attachment.filename });
}

async function deleteAttachment(env: Env, actor: StaffActor, attachmentId: string): Promise<Response> {
  const attachment = await mustAttachment(env, attachmentId);
  const task = await mustTask(env, attachment.task_id);
  const access = await requireBoardAccess(env, actor, task.board_id, "board.attachments.delete");
  assertCanMutate(access);
  if (env.CLIPS) {
    await env.CLIPS.delete(attachment.storage_key);
  } else if (env.R2_ACCOUNT_ID) {
    await new AwsClient({
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      service: "s3",
      region: "auto",
    }).fetch(`https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/${attachment.storage_key}`, {
      method: "DELETE",
    });
  }
  await serviceRest(env, "DELETE", `/staff_task_attachments?id=eq.${attachmentId}`);
  return json({ ok: true });
}

async function addRelation(request: Request, env: Env, actor: StaffActor, taskId: string): Promise<Response> {
  const task = await mustTask(env, taskId);
  const access = await requireBoardAccess(env, actor, task.board_id, "board.cards.edit");
  assertCanMutate(access);
  const body = (await request.json().catch(() => ({}))) as { kind?: string; targetId?: string; label?: string };
  if (!body.kind || !RELATION_KINDS.has(body.kind) || typeof body.targetId !== "string" || !body.targetId.trim()) {
    throw new HttpError(400, "kind and targetId are required.");
  }
  await serviceRest(env, "POST", "/staff_task_relations", {
    task_id: taskId,
    kind: body.kind,
    target_id: body.targetId.trim().slice(0, 200),
    label: typeof body.label === "string" ? body.label.trim().slice(0, 120) || null : null,
  });
  return getTask(env, actor, taskId);
}

async function deleteRelation(env: Env, actor: StaffActor, relationId: string): Promise<Response> {
  if (!UUID.test(relationId)) throw new HttpError(400, "Relation id is invalid.");
  const rows = await serviceRest<Array<{ id: string; task_id: string }>>(
    env,
    "GET",
    `/staff_task_relations?id=eq.${relationId}&select=id,task_id`,
  );
  const relation = rows[0];
  if (!relation) throw new HttpError(404, "Relation not found.");
  const task = await mustTask(env, relation.task_id);
  const access = await requireBoardAccess(env, actor, task.board_id, "board.cards.edit");
  assertCanMutate(access);
  await serviceRest(env, "DELETE", `/staff_task_relations?id=eq.${relationId}`);
  return json({ ok: true });
}

export async function notifyStaffTaskDueSoon(env: Env): Promise<void> {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return;
  const start = new Date();
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  const tasks = await serviceRest<TaskRow[]>(
    env,
    "GET",
    `/staff_tasks?archived_at=is.null&completed_at=is.null&due_at=gte.${start.toISOString()}&due_at=lt.${end.toISOString()}&select=id,board_id,column_id,title,rank,priority,created_by,due_at,started_at,completed_at,archived_at,created_at,updated_at`,
  );
  for (const task of tasks) {
    const existing = await serviceRest<Array<{ id: string }>>(
      env,
      "GET",
      `/notifications?staff_task_id=eq.${task.id}&kind=eq.staff_task_due_soon&created_at=gte.${new Date(start.getTime() - 20 * 60 * 60 * 1000).toISOString()}&select=id&limit=1`,
    );
    if (existing.length) continue;
    const watchers = await watcherUserIds(env, task.id, task.board_id, []);
    if (!watchers.length) continue;
    await insertNotifications(
      env,
      watchers.map((user_id) => ({
        user_id,
        kind: "staff_task_due_soon",
        staff_task_id: task.id,
      })),
    );
  }
}

async function mustTask(env: Env, id: string): Promise<TaskRow> {
  if (!UUID.test(id)) throw new HttpError(400, "Task id is invalid.");
  const rows = await serviceRest<TaskRow[]>(
    env,
    "GET",
    `/staff_tasks?id=eq.${id}&select=id,board_id,column_id,title,description,rank,priority,created_by,due_at,started_at,completed_at,archived_at,created_at,updated_at`,
  );
  if (!rows[0]) throw new HttpError(404, "Task not found.");
  return rows[0];
}

async function mustChecklist(env: Env, id: string) {
  if (!UUID.test(id)) throw new HttpError(400, "Checklist id is invalid.");
  const rows = await serviceRest<Array<{ id: string; task_id: string; title: string }>>(
    env,
    "GET",
    `/staff_task_checklists?id=eq.${id}&select=id,task_id,title`,
  );
  if (!rows[0]) throw new HttpError(404, "Checklist not found.");
  return rows[0];
}

async function mustAttachment(env: Env, id: string) {
  if (!UUID.test(id)) throw new HttpError(400, "Attachment id is invalid.");
  const rows = await serviceRest<Array<{ id: string; task_id: string; storage_key: string; filename: string }>>(
    env,
    "GET",
    `/staff_task_attachments?id=eq.${id}&select=id,task_id,storage_key,filename`,
  );
  if (!rows[0]) throw new HttpError(404, "Attachment not found.");
  return rows[0];
}

async function addActivity(env: Env, taskId: string, actorStaffId: string, action: string, metadata: Record<string, unknown>) {
  await serviceRest(env, "POST", "/staff_task_activity", {
    task_id: taskId,
    actor_staff_id: actorStaffId,
    action,
    metadata,
  });
}

async function resolveMentions(env: Env, boardId: string, body: string): Promise<string[]> {
  const names = [...body.matchAll(MENTION)].map((match) => match[1]!.toLowerCase());
  if (!names.length) return [];
  const boardMembers = await serviceRest<Array<{ staff_id: string }>>(
    env,
    "GET",
    `/staff_board_members?board_id=eq.${boardId}&select=staff_id`,
  );
  const boardMemberIds = new Set(boardMembers.map((row) => row.staff_id));
  if (!boardMemberIds.size) return [];
  const members = await serviceRest<Array<{ id: string; display_name: string; user_id: string; status: string }>>(
    env,
    "GET",
    `/staff_members?status=eq.active&select=id,display_name,user_id,status`,
  );
  const profiles = await serviceRest<Array<{ id: string; username: string | null }>>(
    env,
    "GET",
    `/profiles?id=in.(${members.map((row) => row.user_id).join(",")})&select=id,username`,
  );
  const usernameByUser = new Map(profiles.map((row) => [row.id, row.username?.toLowerCase() ?? ""]));
  return members
    .filter((member) => boardMemberIds.has(member.id))
    .filter((member) => {
      const username = usernameByUser.get(member.user_id) ?? "";
      const display = member.display_name.toLowerCase().replace(/\s+/g, "");
      return names.includes(username) || names.includes(display);
    })
    .map((member) => member.id);
}

async function notifyStaff(
  env: Env,
  actor: StaffActor,
  task: TaskRow,
  staffIds: string[],
  kind: "staff_task_assigned" | "staff_task_mentioned",
) {
  if (!staffIds.length) return;
  const members = await serviceRest<Array<{ id: string; user_id: string }>>(
    env,
    "GET",
    `/staff_members?id=in.(${staffIds.join(",")})&select=id,user_id`,
  );
  await notifyUsers(
    env,
    actor.userId,
    members.map((row) => row.user_id),
    kind,
    task.id,
  );
}

async function watcherUserIds(env: Env, taskId: string, boardId: string, excludeStaffIds: string[]): Promise<string[]> {
  const watchers = await serviceRest<Array<{ staff_id: string }>>(env, "GET", `/staff_task_watchers?task_id=eq.${taskId}&select=staff_id`);
  const ids = watchers.map((row) => row.staff_id).filter((id) => !excludeStaffIds.includes(id));
  if (!ids.length) return [];
  const boardMembers = await serviceRest<Array<{ staff_id: string }>>(
    env,
    "GET",
    `/staff_board_members?board_id=eq.${boardId}&staff_id=in.(${ids.join(",")})&select=staff_id`,
  );
  const allowedIds = new Set(boardMembers.map((row) => row.staff_id));
  const members = await serviceRest<Array<{ id: string; user_id: string }>>(
    env,
    "GET",
    `/staff_members?id=in.(${ids.join(",")})&select=id,user_id`,
  );
  return members.filter((row) => allowedIds.has(row.id)).map((row) => row.user_id);
}

async function assertBoardMembers(env: Env, boardId: string, staffIds: string[]): Promise<void> {
  if (!staffIds.length) return;
  const rows = await serviceRest<Array<{ staff_id: string }>>(
    env,
    "GET",
    `/staff_board_members?board_id=eq.${boardId}&staff_id=in.(${staffIds.join(",")})&select=staff_id`,
  );
  const found = new Set(rows.map((row) => row.staff_id));
  if (staffIds.some((id) => !found.has(id))) {
    throw new HttpError(400, "Assignees and watchers must be members of this board.");
  }
}

async function isBoardMember(env: Env, boardId: string, staffId: string): Promise<boolean> {
  const rows = await serviceRest<Array<{ staff_id: string }>>(
    env,
    "GET",
    `/staff_board_members?board_id=eq.${boardId}&staff_id=eq.${staffId}&select=staff_id&limit=1`,
  );
  return Boolean(rows[0]);
}

async function notifyUsers(
  env: Env,
  actorUserId: string,
  userIds: string[],
  kind: "staff_task_assigned" | "staff_task_mentioned" | "staff_task_comment" | "staff_task_due_soon",
  taskId: string,
) {
  const unique = [...new Set(userIds)].filter((id) => id && id !== actorUserId);
  if (!unique.length) return;
  await insertNotifications(
    env,
    unique.map((user_id) => ({
      user_id,
      kind,
      actor_id: actorUserId,
      staff_task_id: taskId,
    })),
  );
}
