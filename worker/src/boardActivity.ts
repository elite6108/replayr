import { boardActivityEmail, sendReplayrEmail } from "./email";
import type { Env } from "./env";
import { serviceRest } from "./shared";
import { SUPER_ADMIN_ROLE_ID } from "./staffPermissions";

export type BoardActivityKind = "added" | "moved" | "assigned" | "comment" | "due";

export type WaitUntilCtx = { waitUntil(task: Promise<unknown>): void };

export type BoardActivityPayload = {
  boardId: string;
  taskId: string;
  actorStaffId: string;
  actorName: string;
  kind: BoardActivityKind;
  summary: string;
  taskTitle?: string;
  boardName?: string;
};

export type BoardEmailCandidate = {
  staffId: string;
  userId: string;
  status: string;
  notifyBoardEmail: boolean;
  notifyOwnBoardEmail: boolean;
  muted: boolean;
  canAccess: boolean;
};

type StaffJoin = {
  id: string;
  user_id: string;
  status: string;
  display_name: string;
  notify_board_email: boolean | null;
  notify_own_board_email: boolean | null;
};

function asStaff(value: StaffJoin | StaffJoin[] | null | undefined): StaffJoin | null {
  if (!value) return null;
  return Array.isArray(value) ? value[0] ?? null : value;
}

export function shouldNotifyBoardMove(fromColumnId: string, toColumnId: string): boolean {
  return fromColumnId !== toColumnId;
}

export function dueAtChanged(before: string | null, after: string | null): boolean {
  return (before ?? null) !== (after ?? null);
}

export function assigneeSetChanged(before: string[], after: string[]): boolean {
  const left = [...new Set(before)].sort();
  const right = [...new Set(after)].sort();
  if (left.length !== right.length) return true;
  return left.some((id, index) => id !== right[index]);
}

export function boardActivityIdempotencyKey(
  kind: BoardActivityKind,
  taskId: string,
  userId: string,
  at = Date.now(),
): string {
  const bucket = Math.floor(at / 60_000);
  return `staff-board/${kind}/${taskId}/${userId}/${bucket}`;
}

export function filterBoardEmailRecipients(
  candidates: BoardEmailCandidate[],
  actorStaffId: string,
  ownerStaffId?: string | null,
): BoardEmailCandidate[] {
  return candidates.filter((row) => {
    if (!row.canAccess || row.status !== "active" || !row.notifyBoardEmail || row.muted || !row.userId) return false;
    if (row.staffId !== actorStaffId) return true;
    return Boolean(ownerStaffId) && row.staffId === ownerStaffId && row.notifyOwnBoardEmail;
  });
}

export function queueBoardActivityEmail(ctx: WaitUntilCtx | undefined, env: Env, payload: BoardActivityPayload): void {
  const work = notifyBoardActivityEmail(env, payload).catch((caught) => {
    console.error("Board activity email failed", {
      message: caught instanceof Error ? caught.message : "Unknown error",
      boardId: payload.boardId,
      taskId: payload.taskId,
      kind: payload.kind,
    });
  });
  if (ctx?.waitUntil) ctx.waitUntil(work);
}

export async function notifyBoardActivityEmail(env: Env, payload: BoardActivityPayload): Promise<void> {
  const boardRows = await serviceRest<Array<{ id: string; name: string; visibility: string; created_by: string | null }>>(
    env,
    "GET",
    `/staff_boards?id=eq.${payload.boardId}&select=id,name,visibility,created_by`,
  );
  const board = boardRows[0];
  if (!board) return;

  const taskRows = payload.taskTitle
    ? []
    : await serviceRest<Array<{ id: string; title: string }>>(
        env,
        "GET",
        `/staff_tasks?id=eq.${payload.taskId}&select=id,title`,
      );
  const taskTitle = payload.taskTitle || taskRows[0]?.title || "a card";
  const boardName = payload.boardName || board.name;

  const people = await loadAccessibleStaff(env, payload.boardId, board.visibility, board.created_by);
  const mutes = await serviceRest<Array<{ staff_id: string; email: boolean }>>(
    env,
    "GET",
    `/staff_board_email_prefs?board_id=eq.${payload.boardId}&select=staff_id,email`,
  );
  const muted = new Set(mutes.filter((row) => row.email === false).map((row) => row.staff_id));
  const recipients = filterBoardEmailRecipients(
    people.map((person) => ({
      ...person,
      muted: muted.has(person.staffId),
    })),
    payload.actorStaffId,
    board.created_by,
  );
  if (!recipients.length) return;

  const origin = publicAppOrigin(env);
  const boardUrl = `${origin}/staff/board/${payload.boardId}`;
  const email = boardActivityEmail({
    actorName: payload.actorName,
    boardName,
    taskTitle,
    summary: payload.summary,
    boardUrl,
  });

  for (const recipient of recipients) {
    const to = await verifiedAuthEmail(env, recipient.userId);
    if (!to) continue;
    await sendReplayrEmail(env, {
      to,
      subject: email.subject,
      html: email.html,
      text: email.text,
      idempotencyKey: boardActivityIdempotencyKey(payload.kind, payload.taskId, recipient.userId),
    });
  }
}

async function loadAccessibleStaff(
  env: Env,
  boardId: string,
  visibility: string,
  ownerStaffId: string | null,
): Promise<Array<{
  staffId: string;
  userId: string;
  status: string;
  notifyBoardEmail: boolean;
  notifyOwnBoardEmail: boolean;
  canAccess: boolean;
}>> {
  const byId = new Map<string, {
    staffId: string;
    userId: string;
    status: string;
    notifyBoardEmail: boolean;
    notifyOwnBoardEmail: boolean;
    canAccess: boolean;
  }>();

  function add(staff: StaffJoin | null, canAccess: boolean) {
    if (!staff?.id || !staff.user_id) return;
    const current = byId.get(staff.id);
    if (current) {
      current.canAccess = current.canAccess || canAccess;
      return;
    }
    byId.set(staff.id, {
      staffId: staff.id,
      userId: staff.user_id,
      status: staff.status,
      notifyBoardEmail: staff.notify_board_email !== false,
      notifyOwnBoardEmail: Boolean(staff.notify_own_board_email),
      canAccess,
    });
  }

  const members = await serviceRest<Array<{ staff_id: string; staff_members: StaffJoin | StaffJoin[] | null }>>(
    env,
    "GET",
    `/staff_board_members?board_id=eq.${boardId}&select=staff_id,staff_members(id,user_id,status,display_name,notify_board_email,notify_own_board_email)`,
  );
  for (const row of members) add(asStaff(row.staff_members) ?? null, true);

  if (ownerStaffId) {
    const owners = await serviceRest<StaffJoin[]>(
      env,
      "GET",
      `/staff_members?id=eq.${ownerStaffId}&select=id,user_id,status,display_name,notify_board_email,notify_own_board_email`,
    );
    add(owners[0] ?? null, true);
  }

  const supers = await serviceRest<Array<{ staff_id: string; staff_members: StaffJoin | StaffJoin[] | null }>>(
    env,
    "GET",
    `/staff_role_assignments?role_id=eq.${SUPER_ADMIN_ROLE_ID}&select=staff_id,staff_members(id,user_id,status,display_name,notify_board_email,notify_own_board_email)`,
  );
  for (const row of supers) add(asStaff(row.staff_members) ?? null, true);

  if (visibility === "staff") {
    const permRoles = await serviceRest<Array<{ role_id: string }>>(
      env,
      "GET",
      "/staff_role_permissions?permission_key=eq.board.view&select=role_id",
    );
    const roleIds = [...new Set(permRoles.map((row) => row.role_id))];
    if (roleIds.length) {
      const granted = await serviceRest<Array<{ staff_id: string; staff_members: StaffJoin | StaffJoin[] | null }>>(
        env,
        "GET",
        `/staff_role_assignments?role_id=in.(${roleIds.join(",")})&select=staff_id,staff_members(id,user_id,status,display_name,notify_board_email,notify_own_board_email)`,
      );
      for (const row of granted) add(asStaff(row.staff_members) ?? null, true);
    }
  }

  return [...byId.values()];
}

async function verifiedAuthEmail(env: Env, userId: string): Promise<string | null> {
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) return null;
  try {
    const response = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
      headers: { apikey: key, authorization: `Bearer ${key}` },
    });
    if (!response.ok) return null;
    const user = (await response.json()) as {
      email?: string | null;
      email_confirmed_at?: string | null;
      confirmed_at?: string | null;
    };
    if (!user.email || !(user.email_confirmed_at || user.confirmed_at)) return null;
    return user.email.trim().toLowerCase();
  } catch {
    return null;
  }
}

function publicAppOrigin(env: Env): string {
  const raw = env.PUBLIC_APP_URL || "https://www.replayr.tv";
  try {
    const url = new URL(raw);
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
      return "https://www.replayr.tv";
    }
    if (url.hostname === "replayr.tv") url.hostname = "www.replayr.tv";
    return url.origin;
  } catch {
    return "https://www.replayr.tv";
  }
}
