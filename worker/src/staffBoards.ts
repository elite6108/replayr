import { AwsClient } from "aws4fetch";
import { AUDIT_ACTIONS, auditRequestMeta, writeAuditLog } from "./audit";
import type { Env } from "./env";
import { HttpError, json } from "./http";
import { serviceRest } from "./shared";
import { rankAfter, rankBetween } from "./lexorank";
import { assertPermission, requirePermission, requireStaffActor, type StaffActor } from "./staffAuth";
import type { StaffPermission } from "./staffPermissions";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
  isOwner: boolean;
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
      return deleteBoard(request, env, actor, boardItem[1]);
    }
  }

  const boardMembers = path.match(/^\/v1\/staff\/boards\/([^/]+)\/members$/);
  if (boardMembers?.[1] && UUID.test(boardMembers[1]) && method === "GET") {
    const actor = await requireStaffActor(request, env);
    return listBoardMembers(env, actor, boardMembers[1]);
  }
  const boardMemberItem = path.match(/^\/v1\/staff\/boards\/([^/]+)\/members\/([^/]+)$/);
  if (boardMemberItem?.[1] && boardMemberItem[2] && UUID.test(boardMemberItem[1]) && UUID.test(boardMemberItem[2])) {
    const actor = await requireStaffActor(request, env);
    if (method === "PUT") return upsertBoardMember(request, env, actor, boardMemberItem[1], boardMemberItem[2]);
    if (method === "DELETE") return removeBoardMember(request, env, actor, boardMemberItem[1], boardMemberItem[2]);
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
      return deleteLabel(env, actor, labelItem[1]);
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

  const isOwner = board.created_by === actor.staffId;
  if (actor.isSuperAdmin) return { board, boardRole: "admin", canMutate: true, isOwner };

  const members = await serviceRest<Array<{ staff_id: string; board_role: "admin" | "editor" | "viewer" }>>(
    env,
    "GET",
    `/staff_board_members?board_id=eq.${boardId}&staff_id=eq.${actor.staffId}&select=staff_id,board_role`,
  );
  const member = members[0];
  if (member) {
    return { board, boardRole: member.board_role, canMutate: member.board_role !== "viewer", isOwner };
  }
  throw new HttpError(403, "You cannot access this board.");
}

export function assertCanMutate(access: BoardAccess) {
  if (!access.canMutate) throw new HttpError(403, "Viewers cannot edit this board.");
}

export function boardCapabilities(actor: StaffActor, access: BoardAccess) {
  return {
    isOwner: access.isOwner,
    canManageMembers: actor.isSuperAdmin || access.boardRole === "admin",
    canDelete: actor.isSuperAdmin || (access.isOwner && actor.permissions.has("board.delete")),
  };
}

async function listBoards(env: Env, actor: StaffActor): Promise<Response> {
  const memberships = actor.isSuperAdmin
    ? []
    : await serviceRest<Array<{ board_id: string; board_role: "admin" | "editor" | "viewer" }>>(
        env,
        "GET",
        `/staff_board_members?staff_id=eq.${actor.staffId}&select=board_id,board_role`,
      );
  if (!actor.isSuperAdmin && !memberships.length) return json({ boards: [] });
  const roleByBoard = new Map(memberships.map((row) => [row.board_id, row.board_role]));
  const boardFilter = actor.isSuperAdmin ? "" : `&id=in.(${memberships.map((row) => row.board_id).join(",")})`;
  const boards = await serviceRest<BoardRow[]>(
    env,
    "GET",
    `/staff_boards?archived_at=is.null${boardFilter}&select=id,workspace_id,name,slug,description,visibility,archived_at,created_by,created_at,updated_at&order=name.asc`,
  );
  return json({
    boards: boards.map((board) => {
      const boardRole = actor.isSuperAdmin ? "admin" : roleByBoard.get(board.id)!;
      return {
      id: board.id,
      workspaceId: board.workspace_id,
      name: board.name,
      slug: board.slug,
      description: board.description,
      visibility: board.visibility,
      boardRole,
      mine: boardRole === "admin" || board.created_by === actor.staffId,
      createdAt: board.created_at,
      updatedAt: board.updated_at,
      };
    }),
  });
}

async function createBoard(request: Request, env: Env, actor: StaffActor): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as {
    workspaceId?: string;
    name?: string;
    description?: string;
  };
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 80) : "";
  if (!name) throw new HttpError(400, "Name is required.");
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
      visibility: "private",
      created_by: actor.staffId,
    },
    "return=representation",
  );
  const board = created[0];
  if (!board) throw new HttpError(502, "Could not create board.");
  try {
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
  } catch (caught) {
    await serviceRest(env, "DELETE", `/staff_boards?id=eq.${board.id}`).catch(() => undefined);
    throw caught;
  }
  return getBoard(env, actor, board.id, new URL(request.url));
}

async function patchBoard(request: Request, env: Env, actor: StaffActor, boardId: string): Promise<Response> {
  const access = await requireBoardAccess(env, actor, boardId, "board.edit");
  if (access.boardRole !== "admin" && !actor.isSuperAdmin) throw new HttpError(403, "Only board admins can edit this board.");
  const body = (await request.json().catch(() => ({}))) as {
    name?: string;
    description?: string | null;
  };
  const patch: Record<string, unknown> = {};
  if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim().slice(0, 80);
  if ("description" in body) patch.description = typeof body.description === "string" ? body.description.trim().slice(0, 280) || null : null;
  if (Object.keys(patch).length) {
    await serviceRest(env, "PATCH", `/staff_boards?id=eq.${boardId}`, patch);
  }
  return getBoard(env, actor, boardId, new URL(request.url));
}

async function deleteBoard(request: Request, env: Env, actor: StaffActor, boardId: string): Promise<Response> {
  const access = await requireBoardAccess(env, actor, boardId, "board.delete");
  if (!boardCapabilities(actor, access).canDelete) {
    throw new HttpError(403, "Only the board owner or a Super Admin can permanently delete this board.");
  }
  const body = (await request.json().catch(() => ({}))) as { confirmName?: string };
  if (body.confirmName !== access.board.name) throw new HttpError(400, "Enter the exact board name to confirm deletion.");
  await deleteBoardAttachmentObjects(env, boardId);
  await serviceRest(env, "DELETE", `/staff_boards?id=eq.${boardId}`);
  await writeAuditLog(env, {
    actorUserId: actor.userId,
    actorType: "admin",
    action: AUDIT_ACTIONS.boardDeleted,
    targetType: "staff_board",
    targetId: boardId,
    requestId: actor.requestId,
    metadata: auditRequestMeta(request),
    before: { name: access.board.name, ownerStaffId: access.board.created_by },
  });
  return json({ ok: true });
}

async function deleteBoardAttachmentObjects(env: Env, boardId: string): Promise<void> {
  const tasks = await serviceRest<Array<{ id: string }>>(
    env,
    "GET",
    `/staff_tasks?board_id=eq.${boardId}&select=id`,
  );
  if (!tasks.length) return;
  const attachments = await serviceRest<Array<{ storage_key: string }>>(
    env,
    "GET",
    `/staff_task_attachments?task_id=in.(${tasks.map((row) => row.id).join(",")})&select=storage_key`,
  );
  if (!attachments.length) return;
  if (env.CLIPS) {
    await env.CLIPS.delete(attachments.map((row) => row.storage_key));
    return;
  }
  if (!env.R2_ACCOUNT_ID) return;
  const client = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto",
  });
  for (const attachment of attachments) {
    const response = await client.fetch(
      `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/${attachment.storage_key}`,
      { method: "DELETE" },
    );
    if (!response.ok) throw new HttpError(502, "Could not delete a board attachment.");
  }
}

async function requireBoardMemberManager(env: Env, actor: StaffActor, boardId: string): Promise<BoardAccess> {
  const access = await requireBoardAccess(env, actor, boardId, "board.view");
  if (!boardCapabilities(actor, access).canManageMembers) {
    throw new HttpError(403, "Only board admins can manage members.");
  }
  return access;
}

async function listBoardMembers(env: Env, actor: StaffActor, boardId: string): Promise<Response> {
  const access = await requireBoardMemberManager(env, actor, boardId);
  const [members, candidates] = await Promise.all([
    serviceRest<Array<{
      staff_id: string;
      board_role: "admin" | "editor" | "viewer";
      staff_members: { display_name: string } | Array<{ display_name: string }>;
    }>>(
      env,
      "GET",
      `/staff_board_members?board_id=eq.${boardId}&select=staff_id,board_role,staff_members(display_name)&order=created_at.asc`,
    ),
    serviceRest<Array<{ id: string; display_name: string }>>(
      env,
      "GET",
      "/staff_members?status=eq.active&select=id,display_name&order=display_name.asc",
    ),
  ]);
  const memberIds = new Set(members.map((row) => row.staff_id));
  return json({
    members: members.map((row) => {
      const staff = Array.isArray(row.staff_members) ? row.staff_members[0] : row.staff_members;
      return {
        staffId: row.staff_id,
        displayName: staff?.display_name ?? "Staff",
        boardRole: row.board_role,
        isOwner: row.staff_id === access.board.created_by,
      };
    }),
    candidates: candidates
      .filter((row) => !memberIds.has(row.id))
      .map((row) => ({ id: row.id, displayName: row.display_name })),
  });
}

async function upsertBoardMember(
  request: Request,
  env: Env,
  actor: StaffActor,
  boardId: string,
  staffId: string,
): Promise<Response> {
  const access = await requireBoardMemberManager(env, actor, boardId);
  const body = (await request.json().catch(() => ({}))) as { boardRole?: string };
  if (!body.boardRole || !BOARD_ROLES.has(body.boardRole)) throw new HttpError(400, "Board role is invalid.");
  if (staffId === access.board.created_by && body.boardRole !== "admin") {
    throw new HttpError(409, "The board owner must remain an admin.");
  }
  const staff = await serviceRest<Array<{ id: string }>>(
    env,
    "GET",
    `/staff_members?id=eq.${staffId}&status=eq.active&select=id`,
  );
  if (!staff[0]) throw new HttpError(404, "Active staff member not found.");
  const before = await serviceRest<Array<{ board_role: string }>>(
    env,
    "GET",
    `/staff_board_members?board_id=eq.${boardId}&staff_id=eq.${staffId}&select=board_role`,
  );
  await serviceRest(
    env,
    "POST",
    "/staff_board_members?on_conflict=board_id,staff_id",
    { board_id: boardId, staff_id: staffId, board_role: body.boardRole },
    "resolution=merge-duplicates,return=minimal",
  );
  await writeAuditLog(env, {
    actorUserId: actor.userId,
    actorType: "admin",
    action: AUDIT_ACTIONS.boardPermissionsChanged,
    targetType: "staff_board",
    targetId: boardId,
    requestId: actor.requestId,
    metadata: auditRequestMeta(request),
    before: before[0] ? { staffId, boardRole: before[0].board_role } : null,
    after: { staffId, boardRole: body.boardRole },
  });
  return json({ ok: true });
}

async function removeBoardMember(
  request: Request,
  env: Env,
  actor: StaffActor,
  boardId: string,
  staffId: string,
): Promise<Response> {
  const access = await requireBoardMemberManager(env, actor, boardId);
  if (staffId === access.board.created_by) throw new HttpError(409, "The board owner cannot be removed.");
  const before = await serviceRest<Array<{ board_role: string }>>(
    env,
    "GET",
    `/staff_board_members?board_id=eq.${boardId}&staff_id=eq.${staffId}&select=board_role`,
  );
  if (!before[0]) throw new HttpError(404, "Board member not found.");
  await serviceRest(env, "DELETE", `/staff_board_members?board_id=eq.${boardId}&staff_id=eq.${staffId}`);
  await writeAuditLog(env, {
    actorUserId: actor.userId,
    actorType: "admin",
    action: AUDIT_ACTIONS.boardPermissionsChanged,
    targetType: "staff_board",
    targetId: boardId,
    requestId: actor.requestId,
    metadata: auditRequestMeta(request),
    before: { staffId, boardRole: before[0].board_role },
    after: { staffId, removed: true },
  });
  return json({ ok: true });
}

async function getBoard(env: Env, actor: StaffActor, boardId: string, url: URL): Promise<Response> {
  const access = await requireBoardAccess(env, actor, boardId);
  const includeArchived = url.searchParams.get("archived") === "1";
  const [columns, labels, members] = await Promise.all([
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
  const boardMembers = members.map((row) => {
    const staff = Array.isArray(row.staff_members) ? row.staff_members[0] : row.staff_members;
    return {
      staffId: row.staff_id,
      boardRole: row.board_role,
      displayName: staff?.display_name ?? "Staff",
      isOwner: row.staff_id === access.board.created_by,
    };
  });
  const capabilities = boardCapabilities(actor, access);

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
      ...capabilities,
      createdAt: access.board.created_at,
      updatedAt: access.board.updated_at,
      roleIds: [],
      members: boardMembers,
      people: boardMembers.map((row) => ({ id: row.staffId, displayName: row.displayName })),
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

async function deleteLabel(env: Env, actor: StaffActor, labelId: string): Promise<Response> {
  const label = await mustLabel(env, labelId);
  const access = await requireBoardAccess(env, actor, label.board_id, "board.labels.manage");
  assertCanMutate(access);
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
  const creatorMembership = await serviceRest<Array<{ staff_id: string }>>(
    env,
    "GET",
    `/staff_board_members?board_id=eq.${boardId}&staff_id=eq.${actor.staffId}&select=staff_id&limit=1`,
  );
  if (creatorMembership[0]) {
    await serviceRest(env, "POST", "/staff_task_watchers", { task_id: task.id, staff_id: actor.staffId }).catch(() => undefined);
  }
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
