import { AUDIT_ACTIONS, auditRequestMeta, writeAuditLog } from "./audit";
import type { Env } from "./env";
import { HttpError, json } from "./http";
import { serviceRest } from "./shared";
import { rankAfter, rankBetween } from "./lexorank";
import { assertPermission, requirePermission, requireStaffActor, type StaffActor } from "./staffAuth";
import type { StaffPermission } from "./staffPermissions";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VIS = new Set(["staff", "role", "private"]);
const BOARD_ROLES = new Set(["admin", "editor", "viewer"]);

export type BoardRow = {
  id: string;
  workspace_id: string;
  name: string;
  slug: string;
  description: string | null;
  visibility: "staff" | "role" | "private";
  archived_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type BoardAccess = {
  board: BoardRow;
  boardRole: "admin" | "editor" | "viewer";
  canMutate: boolean;
};

type ColumnRow = {
  id: string;
  board_id: string;
  name: string;
  rank: string;
  archived_at: string | null;
};

type LabelRow = { id: string; board_id: string; name: string; color: string };

type TaskListRow = {
  id: string;
  board_id: string;
  column_id: string;
  title: string;
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

export async function handleStaffBoards(request: Request, env: Env, url: URL): Promise<Response | null> {
  const path = url.pathname;
  const method = request.method;

  if (method === "GET" && path === "/v1/staff/workspaces") {
    await requirePermission(request, env, "staff.access");
    const workspaces = await serviceRest<Array<{ id: string; name: string; slug: string }>>(
      env,
      "GET",
      "/staff_workspaces?select=id,name,slug&order=name.asc",
    );
    return json({ workspaces });
  }

  if (method === "GET" && path === "/v1/staff/boards") {
    const actor = await requirePermission(request, env, "board.view");
    return listBoards(env, actor);
  }
  if (method === "POST" && path === "/v1/staff/boards") {
    const actor = await requirePermission(request, env, "board.create");
    return createBoard(request, env, actor);
  }

  const boardItem = path.match(/^\/v1\/staff\/boards\/([^/]+)$/);
  if (boardItem?.[1] && UUID.test(boardItem[1])) {
    if (method === "GET") {
      const actor = await requirePermission(request, env, "board.view");
      return getBoard(env, actor, boardItem[1], url);
    }
    if (method === "PATCH") {
      const actor = await requirePermission(request, env, "board.edit");
      return patchBoard(request, env, actor, boardItem[1]);
    }
    if (method === "DELETE") {
      const actor = await requirePermission(request, env, "board.delete");
      return archiveBoard(env, actor, boardItem[1]);
    }
  }

  const boardMembers = path.match(/^\/v1\/staff\/boards\/([^/]+)\/members$/);
  if (boardMembers?.[1] && method === "PUT") {
    const actor = await requireStaffActor(request, env);
    return replaceBoardMembers(request, env, actor, boardMembers[1]);
  }

  const boardColumns = path.match(/^\/v1\/staff\/boards\/([^/]+)\/columns$/);
  if (boardColumns?.[1] && method === "POST") {
    const actor = await requirePermission(request, env, "board.columns.create");
    return createColumn(request, env, actor, boardColumns[1]);
  }
  const columnItem = path.match(/^\/v1\/staff\/columns\/([^/]+)$/);
  if (columnItem?.[1] && UUID.test(columnItem[1])) {
    if (method === "PATCH") {
      const actor = await requirePermission(request, env, "board.columns.edit");
      return patchColumn(request, env, actor, columnItem[1]);
    }
    if (method === "DELETE") {
      const actor = await requirePermission(request, env, "board.columns.delete");
      return archiveColumn(env, actor, columnItem[1]);
    }
  }

  const boardLabels = path.match(/^\/v1\/staff\/boards\/([^/]+)\/labels$/);
  if (boardLabels?.[1] && method === "POST") {
    const actor = await requirePermission(request, env, "board.labels.manage");
    return createLabel(request, env, actor, boardLabels[1]);
  }
  const labelItem = path.match(/^\/v1\/staff\/labels\/([^/]+)$/);
  if (labelItem?.[1] && UUID.test(labelItem[1])) {
    if (method === "PATCH") {
      const actor = await requirePermission(request, env, "board.labels.manage");
      return patchLabel(request, env, actor, labelItem[1]);
    }
    if (method === "DELETE") {
      const actor = await requirePermission(request, env, "board.labels.manage");
      return deleteLabel(env, labelItem[1]);
    }
  }

  const boardTasks = path.match(/^\/v1\/staff\/boards\/([^/]+)\/tasks$/);
  if (boardTasks?.[1] && method === "POST") {
    const actor = await requirePermission(request, env, "board.cards.create");
    return createTask(request, env, actor, boardTasks[1]);
  }

  return null;
}

export async function requireBoardAccess(
  env: Env,
  actor: StaffActor,
  boardId: string,
  perm?: StaffPermission,
): Promise<BoardAccess> {
  if (perm) assertPermission(actor, perm);
  else assertPermission(actor, "board.view");
  if (!UUID.test(boardId)) throw new HttpError(400, "Board id is invalid.");
  const boards = await serviceRest<BoardRow[]>(
    env,
    "GET",
    `/staff_boards?id=eq.${boardId}&select=id,workspace_id,name,slug,description,visibility,archived_at,created_by,created_at,updated_at`,
  );
  const board = boards[0];
  if (!board) throw new HttpError(404, "Board not found.");
  if (board.archived_at && perm !== "board.edit" && perm !== "board.delete") {
    assertPermission(actor, "board.edit");
  }

  if (actor.isSuperAdmin) {
    return { board, boardRole: "admin", canMutate: true };
  }

  const members = await serviceRest<Array<{ staff_id: string; board_role: "admin" | "editor" | "viewer" }>>(
    env,
    "GET",
    `/staff_board_members?board_id=eq.${boardId}&staff_id=eq.${actor.staffId}&select=staff_id,board_role`,
  );
  const member = members[0];
  if (member) {
    return { board, boardRole: member.board_role, canMutate: member.board_role !== "viewer" };
  }

  if (board.visibility === "staff") {
    return { board, boardRole: "editor", canMutate: true };
  }
  if (board.visibility === "role") {
    const grants = await serviceRest<Array<{ role_id: string }>>(
      env,
      "GET",
      `/staff_board_role_grants?board_id=eq.${boardId}&select=role_id`,
    );
    const roleIds = new Set(actor.roles.map((role) => role.id));
    if (grants.some((row) => roleIds.has(row.role_id))) {
      return { board, boardRole: "editor", canMutate: true };
    }
  }
  throw new HttpError(403, "You cannot access this board.");
}

export function assertCanMutate(access: BoardAccess) {
  if (!access.canMutate) throw new HttpError(403, "Viewers cannot edit this board.");
}

async function listBoards(env: Env, actor: StaffActor): Promise<Response> {
  const boards = await serviceRest<BoardRow[]>(
    env,
    "GET",
    "/staff_boards?archived_at=is.null&select=id,workspace_id,name,slug,description,visibility,archived_at,created_by,created_at,updated_at&order=name.asc",
  );
  const visible: Array<BoardRow & { boardRole: string; mine: boolean }> = [];
  for (const board of boards) {
    try {
      const access = await requireBoardAccess(env, actor, board.id);
      visible.push({ ...board, boardRole: access.boardRole, mine: access.boardRole === "admin" || board.created_by === actor.staffId });
    } catch (caught) {
      if (caught instanceof HttpError && caught.status === 403) continue;
      throw caught;
    }
  }
  return json({
    boards: visible.map((board) => ({
      id: board.id,
      workspaceId: board.workspace_id,
      name: board.name,
      slug: board.slug,
      description: board.description,
      visibility: board.visibility,
      boardRole: board.boardRole,
      mine: board.mine,
      createdAt: board.created_at,
      updatedAt: board.updated_at,
    })),
  });
}

async function createBoard(request: Request, env: Env, actor: StaffActor): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as {
    workspaceId?: string;
    name?: string;
    description?: string;
    visibility?: string;
  };
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 80) : "";
  if (!name) throw new HttpError(400, "Name is required.");
  const visibility = VIS.has(body.visibility || "") ? (body.visibility as BoardRow["visibility"]) : "staff";
  const workspaces = await serviceRest<Array<{ id: string }>>(env, "GET", "/staff_workspaces?select=id&limit=1");
  const workspaceId =
    typeof body.workspaceId === "string" && UUID.test(body.workspaceId) ? body.workspaceId : workspaces[0]?.id;
  if (!workspaceId) throw new HttpError(400, "Workspace is required.");
  const slug = slugify(name) || "board";
  const created = await serviceRest<BoardRow[]>(
    env,
    "POST",
    "/staff_boards",
    {
      workspace_id: workspaceId,
      name,
      slug: `${slug}-${crypto.randomUUID().slice(0, 6)}`,
      description: typeof body.description === "string" ? body.description.trim().slice(0, 280) || null : null,
      visibility,
      created_by: actor.staffId,
    },
    "return=representation",
  );
  const board = created[0];
  if (!board) throw new HttpError(502, "Could not create board.");
  await serviceRest(env, "POST", "/staff_board_members", {
    board_id: board.id,
    staff_id: actor.staffId,
    board_role: "admin",
  });
  const names = ["Backlog", "In progress", "Review", "Done"];
  let rank: string | null = null;
  for (const columnName of names) {
    rank = rankAfter(rank);
    await serviceRest(env, "POST", "/staff_board_columns", {
      board_id: board.id,
      name: columnName,
      rank,
    });
  }
  return getBoard(env, actor, board.id, new URL(request.url));
}

async function patchBoard(request: Request, env: Env, actor: StaffActor, boardId: string): Promise<Response> {
  const access = await requireBoardAccess(env, actor, boardId, "board.edit");
  if (access.boardRole !== "admin" && !actor.isSuperAdmin) throw new HttpError(403, "Only board admins can edit this board.");
  const body = (await request.json().catch(() => ({}))) as {
    name?: string;
    description?: string | null;
    visibility?: string;
    roleIds?: string[];
  };
  const patch: Record<string, unknown> = {};
  if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim().slice(0, 80);
  if ("description" in body) patch.description = typeof body.description === "string" ? body.description.trim().slice(0, 280) || null : null;
  if (typeof body.visibility === "string" && VIS.has(body.visibility)) patch.visibility = body.visibility;
  if (Object.keys(patch).length) {
    await serviceRest(env, "PATCH", `/staff_boards?id=eq.${boardId}`, patch);
  }
  if (Array.isArray(body.roleIds)) {
    await serviceRest(env, "DELETE", `/staff_board_role_grants?board_id=eq.${boardId}`);
    const roleIds = body.roleIds.filter((id): id is string => typeof id === "string" && UUID.test(id));
    if (roleIds.length) {
      await serviceRest(
        env,
        "POST",
        "/staff_board_role_grants",
        roleIds.map((role_id) => ({ board_id: boardId, role_id })),
      );
    }
    await writeAuditLog(env, {
      actorUserId: actor.userId,
      actorType: "admin",
      action: AUDIT_ACTIONS.boardPermissionsChanged,
      targetType: "staff_board",
      targetId: boardId,
      requestId: actor.requestId,
      metadata: auditRequestMeta(request),
      after: { visibility: body.visibility ?? access.board.visibility, roleIds },
    });
  }
  return getBoard(env, actor, boardId, new URL(request.url));
}

async function archiveBoard(env: Env, actor: StaffActor, boardId: string): Promise<Response> {
  const access = await requireBoardAccess(env, actor, boardId, "board.delete");
  if (access.boardRole !== "admin" && !actor.isSuperAdmin) throw new HttpError(403, "Only board admins can archive this board.");
  await serviceRest(env, "PATCH", `/staff_boards?id=eq.${boardId}`, { archived_at: new Date().toISOString() });
  return json({ ok: true });
}

async function replaceBoardMembers(request: Request, env: Env, actor: StaffActor, boardId: string): Promise<Response> {
  const access = await requireBoardAccess(env, actor, boardId, "board.view");
  const canManage = actor.isSuperAdmin || actor.permissions.has("board.members.manage") || access.boardRole === "admin";
  if (!canManage) throw new HttpError(403, "Missing permission: board.members.manage");
  const body = (await request.json().catch(() => ({}))) as { members?: Array<{ staffId: string; boardRole: string }> };
  const members = Array.isArray(body.members) ? body.members : [];
  await serviceRest(env, "DELETE", `/staff_board_members?board_id=eq.${boardId}`);
  const rows = members
    .filter((row) => row && UUID.test(row.staffId) && BOARD_ROLES.has(row.boardRole))
    .map((row) => ({ board_id: boardId, staff_id: row.staffId, board_role: row.boardRole }));
  if (rows.length) await serviceRest(env, "POST", "/staff_board_members", rows);
  await writeAuditLog(env, {
    actorUserId: actor.userId,
    actorType: "admin",
    action: AUDIT_ACTIONS.boardPermissionsChanged,
    targetType: "staff_board",
    targetId: boardId,
    requestId: actor.requestId,
    metadata: auditRequestMeta(request),
    after: { members: rows },
  });
  return getBoard(env, actor, boardId, new URL(request.url));
}

async function getBoard(env: Env, actor: StaffActor, boardId: string, url: URL): Promise<Response> {
  const access = await requireBoardAccess(env, actor, boardId);
  const includeArchived = url.searchParams.get("archived") === "1";
  const [columns, labels, members, grants, people] = await Promise.all([
    serviceRest<ColumnRow[]>(
      env,
      "GET",
      `/staff_board_columns?board_id=eq.${boardId}${includeArchived ? "" : "&archived_at=is.null"}&select=id,board_id,name,rank,archived_at&order=rank.asc`,
    ),
    serviceRest<LabelRow[]>(env, "GET", `/staff_labels?board_id=eq.${boardId}&select=id,board_id,name,color&order=name.asc`),
    serviceRest<Array<{
      staff_id: string;
      board_role: string;
      staff_members: { id: string; display_name: string; user_id: string } | Array<{ id: string; display_name: string; user_id: string }>;
    }>>(
      env,
      "GET",
      `/staff_board_members?board_id=eq.${boardId}&select=staff_id,board_role,staff_members(id,display_name,user_id)`,
    ),
    serviceRest<Array<{ role_id: string }>>(env, "GET", `/staff_board_role_grants?board_id=eq.${boardId}&select=role_id`),
    serviceRest<Array<{ id: string; display_name: string }>>(
      env,
      "GET",
      "/staff_members?status=eq.active&select=id,display_name&order=display_name.asc",
    ),
  ]);

  const tasks = await serviceRest<TaskListRow[]>(
    env,
    "GET",
    `/staff_tasks?board_id=eq.${boardId}${includeArchived ? "" : "&archived_at=is.null"}&select=id,board_id,column_id,title,rank,priority,created_by,due_at,started_at,completed_at,archived_at,created_at,updated_at&order=rank.asc&limit=800`,
  );
  const taskIds = tasks.map((row) => row.id);
  const [assignees, taskLabels] = taskIds.length
    ? await Promise.all([
        serviceRest<Array<{
          task_id: string;
          staff_id: string;
          staff_members: { id: string; display_name: string } | Array<{ id: string; display_name: string }>;
        }>>(
          env,
          "GET",
          `/staff_task_assignees?task_id=in.(${taskIds.join(",")})&select=task_id,staff_id,staff_members(id,display_name)`,
        ),
        serviceRest<Array<{ task_id: string; label_id: string }>>(
          env,
          "GET",
          `/staff_task_labels?task_id=in.(${taskIds.join(",")})&select=task_id,label_id`,
        ),
      ])
    : [[], []];

  const assigneesByTask = new Map<string, Array<{ id: string; displayName: string }>>();
  for (const row of assignees) {
    const member = Array.isArray(row.staff_members) ? row.staff_members[0] : row.staff_members;
    const list = assigneesByTask.get(row.task_id) ?? [];
    list.push({ id: row.staff_id, displayName: member?.display_name ?? "Staff" });
    assigneesByTask.set(row.task_id, list);
  }
  const labelsByTask = new Map<string, string[]>();
  for (const row of taskLabels) {
    const list = labelsByTask.get(row.task_id) ?? [];
    list.push(row.label_id);
    labelsByTask.set(row.task_id, list);
  }

  return json({
    board: {
      id: access.board.id,
      workspaceId: access.board.workspace_id,
      name: access.board.name,
      slug: access.board.slug,
      description: access.board.description,
      visibility: access.board.visibility,
      boardRole: access.boardRole,
      canMutate: access.canMutate,
      createdAt: access.board.created_at,
      updatedAt: access.board.updated_at,
      roleIds: grants.map((row) => row.role_id),
      members: members.map((row) => {
        const staff = Array.isArray(row.staff_members) ? row.staff_members[0] : row.staff_members;
        return {
          staffId: row.staff_id,
          boardRole: row.board_role,
          displayName: staff?.display_name ?? "Staff",
        };
      }),
      people: people.map((row) => ({ id: row.id, displayName: row.display_name })),
      labels: labels.map((label) => ({ id: label.id, name: label.name, color: label.color })),
      columns: columns.map((column) => ({
        id: column.id,
        name: column.name,
        rank: column.rank,
        archived: Boolean(column.archived_at),
        tasks: tasks
          .filter((task) => task.column_id === column.id)
          .map((task) => ({
            id: task.id,
            title: task.title,
            rank: task.rank,
            priority: task.priority,
            dueAt: task.due_at,
            completedAt: task.completed_at,
            archivedAt: task.archived_at,
            assignees: assigneesByTask.get(task.id) ?? [],
            labelIds: labelsByTask.get(task.id) ?? [],
          })),
      })),
    },
  });
}

async function createColumn(request: Request, env: Env, actor: StaffActor, boardId: string): Promise<Response> {
  const access = await requireBoardAccess(env, actor, boardId, "board.columns.create");
  assertCanMutate(access);
  const body = (await request.json().catch(() => ({}))) as { name?: string };
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 60) : "";
  if (!name) throw new HttpError(400, "Name is required.");
  const last = await serviceRest<Array<{ rank: string }>>(
    env,
    "GET",
    `/staff_board_columns?board_id=eq.${boardId}&archived_at=is.null&select=rank&order=rank.desc&limit=1`,
  );
  const created = await serviceRest<ColumnRow[]>(
    env,
    "POST",
    "/staff_board_columns",
    { board_id: boardId, name, rank: rankAfter(last[0]?.rank) },
    "return=representation",
  );
  return json({ column: created[0] });
}

async function patchColumn(request: Request, env: Env, actor: StaffActor, columnId: string): Promise<Response> {
  const column = await mustColumn(env, columnId);
  const access = await requireBoardAccess(env, actor, column.board_id, "board.columns.edit");
  assertCanMutate(access);
  const body = (await request.json().catch(() => ({}))) as { name?: string; beforeRank?: string | null; afterRank?: string | null };
  const patch: Record<string, unknown> = {};
  if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim().slice(0, 60);
  if ("beforeRank" in body || "afterRank" in body) {
    patch.rank = rankBetween(body.beforeRank, body.afterRank);
  }
  if (!Object.keys(patch).length) throw new HttpError(400, "Nothing to update.");
  await serviceRest(env, "PATCH", `/staff_board_columns?id=eq.${columnId}`, patch);
  return json({ ok: true });
}

async function archiveColumn(env: Env, actor: StaffActor, columnId: string): Promise<Response> {
  const column = await mustColumn(env, columnId);
  const access = await requireBoardAccess(env, actor, column.board_id, "board.columns.delete");
  assertCanMutate(access);
  const remaining = await serviceRest<Array<{ id: string }>>(
    env,
    "GET",
    `/staff_board_columns?board_id=eq.${column.board_id}&archived_at=is.null&id=neq.${columnId}&select=id&limit=1`,
  );
  if (!remaining.length) throw new HttpError(400, "A board needs at least one column.");
  const openTasks = await serviceRest<Array<{ id: string }>>(
    env,
    "GET",
    `/staff_tasks?column_id=eq.${columnId}&archived_at=is.null&select=id&limit=1`,
  );
  if (openTasks.length) throw new HttpError(409, "Move or archive cards before deleting this column.");
  await serviceRest(env, "PATCH", `/staff_board_columns?id=eq.${columnId}`, { archived_at: new Date().toISOString() });
  return json({ ok: true });
}

async function createLabel(request: Request, env: Env, actor: StaffActor, boardId: string): Promise<Response> {
  const access = await requireBoardAccess(env, actor, boardId, "board.labels.manage");
  assertCanMutate(access);
  const body = (await request.json().catch(() => ({}))) as { name?: string; color?: string };
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 40) : "";
  if (!name) throw new HttpError(400, "Name is required.");
  const created = await serviceRest<LabelRow[]>(
    env,
    "POST",
    "/staff_labels",
    { board_id: boardId, name, color: typeof body.color === "string" ? body.color.slice(0, 16) : "#5b6b7c" },
    "return=representation",
  );
  return json({ label: created[0] });
}

async function patchLabel(request: Request, env: Env, actor: StaffActor, labelId: string): Promise<Response> {
  const label = await mustLabel(env, labelId);
  const access = await requireBoardAccess(env, actor, label.board_id, "board.labels.manage");
  assertCanMutate(access);
  const body = (await request.json().catch(() => ({}))) as { name?: string; color?: string };
  const patch: Record<string, unknown> = {};
  if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim().slice(0, 40);
  if (typeof body.color === "string") patch.color = body.color.slice(0, 16);
  await serviceRest(env, "PATCH", `/staff_labels?id=eq.${labelId}`, patch);
  return json({ ok: true });
}

async function deleteLabel(env: Env, labelId: string): Promise<Response> {
  if (!UUID.test(labelId)) throw new HttpError(400, "Label id is invalid.");
  await serviceRest(env, "DELETE", `/staff_labels?id=eq.${labelId}`);
  return json({ ok: true });
}

async function createTask(request: Request, env: Env, actor: StaffActor, boardId: string): Promise<Response> {
  const access = await requireBoardAccess(env, actor, boardId, "board.cards.create");
  assertCanMutate(access);
  const body = (await request.json().catch(() => ({}))) as {
    columnId?: string;
    title?: string;
    description?: string;
    priority?: string;
    dueAt?: string | null;
    relation?: { kind: string; targetId: string; label?: string };
  };
  const title = typeof body.title === "string" ? body.title.trim().slice(0, 200) : "";
  if (!title) throw new HttpError(400, "Title is required.");
  const columnId = typeof body.columnId === "string" ? body.columnId : "";
  const column = await mustColumn(env, columnId);
  if (column.board_id !== boardId) throw new HttpError(400, "Column does not belong to this board.");
  const last = await serviceRest<Array<{ rank: string }>>(
    env,
    "GET",
    `/staff_tasks?column_id=eq.${columnId}&archived_at=is.null&select=rank&order=rank.desc&limit=1`,
  );
  const created = await serviceRest<TaskListRow[]>(
    env,
    "POST",
    "/staff_tasks",
    {
      board_id: boardId,
      column_id: columnId,
      title,
      description: typeof body.description === "string" ? body.description.slice(0, 20_000) : null,
      rank: rankAfter(last[0]?.rank),
      priority: ["none", "low", "medium", "high", "urgent"].includes(body.priority || "") ? body.priority : "none",
      created_by: actor.staffId,
      due_at: typeof body.dueAt === "string" ? body.dueAt : null,
    },
    "return=representation",
  );
  const task = created[0];
  if (!task) throw new HttpError(502, "Could not create task.");
  await serviceRest(env, "POST", "/staff_task_activity", {
    task_id: task.id,
    actor_staff_id: actor.staffId,
    action: "created",
    metadata: { title },
  });
  await serviceRest(env, "POST", "/staff_task_watchers", { task_id: task.id, staff_id: actor.staffId }).catch(() => undefined);
  if (body.relation && typeof body.relation.kind === "string" && typeof body.relation.targetId === "string") {
    await serviceRest(env, "POST", "/staff_task_relations", {
      task_id: task.id,
      kind: body.relation.kind,
      target_id: body.relation.targetId.slice(0, 120),
      label: body.relation.label?.slice(0, 120) ?? null,
    });
  }
  return json({ task: { id: task.id, title: task.title, columnId: task.column_id, rank: task.rank } });
}

async function mustColumn(env: Env, id: string): Promise<ColumnRow> {
  if (!UUID.test(id)) throw new HttpError(400, "Column id is invalid.");
  const rows = await serviceRest<ColumnRow[]>(
    env,
    "GET",
    `/staff_board_columns?id=eq.${id}&select=id,board_id,name,rank,archived_at`,
  );
  if (!rows[0]) throw new HttpError(404, "Column not found.");
  return rows[0];
}

async function mustLabel(env: Env, id: string): Promise<LabelRow> {
  if (!UUID.test(id)) throw new HttpError(400, "Label id is invalid.");
  const rows = await serviceRest<LabelRow[]>(env, "GET", `/staff_labels?id=eq.${id}&select=id,board_id,name,color`);
  if (!rows[0]) throw new HttpError(404, "Label not found.");
  return rows[0];
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}
