import { requestCorrelationId } from "./audit";
import type { Env } from "./env";
import { HttpError } from "./http";
import { requireUser, serviceRest } from "./shared";
import { STAFF_ROLE_ID, SUPER_ADMIN_ROLE_ID, type StaffPermission } from "./staffPermissions";

const CACHE_TTL_MS = 15_000;
const LAST_ACTIVE_GAP_MS = 5 * 60_000;
const cache = new Map<string, { actor: StaffActor; expiresAt: number }>();

export type StaffRoleSummary = {
  id: string;
  slug: string;
  name: string;
  color: string | null;
  isSystem: boolean;
  isSuperAdmin: boolean;
};

export type StaffActor = {
  userId: string;
  staffId: string;
  displayName: string;
  email: string | null;
  status: string;
  jobTitle: string | null;
  department: string | null;
  permissions: Set<string>;
  roles: StaffRoleSummary[];
  isSuperAdmin: boolean;
  notifyBoardEmail: boolean;
  notifyOwnBoardEmail: boolean;
  serviceKey: string;
  requestId: string | null;
};

type MemberRow = {
  id: string;
  user_id: string;
  display_name: string;
  job_title: string | null;
  department: string | null;
  status: string;
  created_at: string;
  last_active_at: string | null;
  notify_board_email?: boolean | null;
  notify_own_board_email?: boolean | null;
};

type AssignmentJoin = {
  staff_id: string;
  role_id: string;
  staff_roles: {
    id: string;
    slug: string;
    name: string;
    color: string | null;
    is_system: boolean;
    is_super_admin: boolean;
    archived_at: string | null;
  } | {
    id: string;
    slug: string;
    name: string;
    color: string | null;
    is_system: boolean;
    is_super_admin: boolean;
    archived_at: string | null;
  }[];
};

function asRole(value: AssignmentJoin["staff_roles"]) {
  return Array.isArray(value) ? value[0] : value;
}

export function assertPermission(actor: StaffActor, key: StaffPermission): void {
  if (actor.isSuperAdmin || actor.permissions.has(key)) return;
  throw new HttpError(403, `Missing permission: ${key}`);
}

export async function requireStaffActor(request: Request, env: Env): Promise<StaffActor> {
  const user = await requireUser(request, env);
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new HttpError(503, "Staff API is not configured.");
  }
  const cached = cache.get(user.id);
  if (cached && cached.expiresAt > Date.now()) {
    return { ...cached.actor, requestId: requestCorrelationId(request) };
  }
  const actor = await loadActor(env, user.id, user.email ?? null, Boolean(user.jwtAdmin), request);
  cache.set(user.id, { actor, expiresAt: Date.now() + CACHE_TTL_MS });
  return actor;
}

export async function requirePermission(request: Request, env: Env, key: StaffPermission): Promise<StaffActor> {
  const actor = await requireStaffActor(request, env);
  assertPermission(actor, key);
  return actor;
}

export function presentMe(actor: StaffActor) {
  return {
    staff: {
      id: actor.staffId,
      userId: actor.userId,
      displayName: actor.displayName,
      email: actor.email,
      jobTitle: actor.jobTitle,
      department: actor.department,
      status: actor.status,
    },
    roles: actor.roles,
    permissions: actor.isSuperAdmin ? ["*"] : [...actor.permissions].sort(),
    isSuperAdmin: actor.isSuperAdmin,
    notifyBoardEmail: actor.notifyBoardEmail,
    notifyOwnBoardEmail: actor.notifyOwnBoardEmail,
  };
}

export function invalidateStaffCache(userId?: string) {
  if (userId) cache.delete(userId);
  else cache.clear();
}

async function loadActor(
  env: Env,
  userId: string,
  email: string | null,
  jwtAdmin: boolean,
  request: Request,
): Promise<StaffActor> {
  let member = await fetchMember(env, userId);
  if (!member && email) {
    await acceptInviteIfPresent(env, userId, email);
    member = await fetchMember(env, userId);
  }
  if (!member && jwtAdmin) {
    await bootstrapSuperAdmin(env, userId, email);
    member = await fetchMember(env, userId);
  }
  if (!member || member.status !== "active") {
    throw new HttpError(403, "Staff access required.");
  }

  const assignments = await serviceRest<AssignmentJoin[]>(
    env,
    "GET",
    `/staff_role_assignments?staff_id=eq.${member.id}&select=staff_id,role_id,staff_roles(id,slug,name,color,is_system,is_super_admin,archived_at)`,
  );
  const roles: StaffRoleSummary[] = [];
  const permissionKeys = new Set<string>();
  let isSuperAdmin = false;
  for (const row of assignments) {
    const role = asRole(row.staff_roles);
    if (!role || role.archived_at) continue;
    roles.push({
      id: role.id,
      slug: role.slug,
      name: role.name,
      color: role.color,
      isSystem: role.is_system,
      isSuperAdmin: role.is_super_admin,
    });
    if (role.is_super_admin) isSuperAdmin = true;
  }
  if (!isSuperAdmin && roles.length) {
    const ids = roles.map((role) => role.id).join(",");
    const granted = await serviceRest<Array<{ permission_key: string }>>(
      env,
      "GET",
      `/staff_role_permissions?role_id=in.(${ids})&select=permission_key`,
    );
    for (const row of granted) permissionKeys.add(row.permission_key);
  }

  const actor: StaffActor = {
    userId,
    staffId: member.id,
    displayName: member.display_name,
    email,
    status: member.status,
    jobTitle: member.job_title,
    department: member.department,
    permissions: permissionKeys,
    roles,
    isSuperAdmin,
    notifyBoardEmail: member.notify_board_email !== false,
    notifyOwnBoardEmail: Boolean(member.notify_own_board_email),
    serviceKey: env.SUPABASE_SERVICE_ROLE_KEY!,
    requestId: requestCorrelationId(request),
  };
  void touchLastActive(env, member);
  return actor;
}

async function fetchMember(env: Env, userId: string): Promise<MemberRow | null> {
  const rows = await serviceRest<MemberRow[]>(
    env,
    "GET",
    `/staff_members?user_id=eq.${userId}&select=id,user_id,display_name,job_title,department,status,created_at,last_active_at,notify_board_email,notify_own_board_email`,
  );
  return rows[0] ?? null;
}

async function bootstrapSuperAdmin(env: Env, userId: string, email: string | null) {
  const profiles = await serviceRest<Array<{ display_name: string | null; username: string | null }>>(
    env,
    "GET",
    `/profiles?id=eq.${userId}&select=display_name,username`,
  );
  const display =
    profiles[0]?.display_name?.trim() ||
    profiles[0]?.username?.trim() ||
    email?.split("@")[0] ||
    "Operator";
  const created = await serviceRest<MemberRow[]>(
    env,
    "POST",
    "/staff_members",
    { user_id: userId, display_name: display, status: "active" },
    "return=representation",
  );
  const member = created[0];
  if (!member) return;
  await serviceRest(env, "POST", "/staff_role_assignments", {
    staff_id: member.id,
    role_id: SUPER_ADMIN_ROLE_ID,
  }).catch(() => undefined);
}

async function acceptInviteIfPresent(env: Env, userId: string, email: string) {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return;
  const invites = await serviceRest<Array<{
    id: string;
    display_name: string | null;
    job_title: string | null;
    department: string | null;
    expires_at: string;
    status: string;
  }>>(
    env,
    "GET",
    `/staff_invites?email_normalized=eq.${encodeURIComponent(normalized)}&status=eq.pending&select=id,display_name,job_title,department,expires_at,status`,
  );
  const invite = invites[0];
  if (!invite) return;
  if (new Date(invite.expires_at).getTime() < Date.now()) {
    await serviceRest(env, "PATCH", `/staff_invites?id=eq.${invite.id}`, { status: "expired" });
    return;
  }
  const profiles = await serviceRest<Array<{ display_name: string | null; username: string | null }>>(
    env,
    "GET",
    `/profiles?id=eq.${userId}&select=display_name,username`,
  );
  const display =
    invite.display_name?.trim() ||
    profiles[0]?.display_name?.trim() ||
    profiles[0]?.username?.trim() ||
    normalized.split("@")[0];
  const created = await serviceRest<MemberRow[]>(
    env,
    "POST",
    "/staff_members",
    {
      user_id: userId,
      display_name: display,
      job_title: invite.job_title,
      department: invite.department,
      status: "active",
    },
    "return=representation",
  );
  const member = created[0];
  if (!member) return;
  const roleRows = await serviceRest<Array<{ role_id: string }>>(
    env,
    "GET",
    `/staff_invite_roles?invite_id=eq.${invite.id}&select=role_id`,
  );
  const assignments = roleRows.length
    ? roleRows.map((row) => ({ staff_id: member.id, role_id: row.role_id }))
    : [{ staff_id: member.id, role_id: STAFF_ROLE_ID }];
  await serviceRest(env, "POST", "/staff_role_assignments", assignments).catch(() => undefined);
  await serviceRest(env, "PATCH", `/staff_invites?id=eq.${invite.id}`, {
    status: "accepted",
    accepted_at: new Date().toISOString(),
    accepted_user_id: userId,
  });
}

async function touchLastActive(env: Env, member: MemberRow) {
  const last = member.last_active_at ? Date.parse(member.last_active_at) : 0;
  if (Date.now() - last < LAST_ACTIVE_GAP_MS) return;
  await serviceRest(env, "PATCH", `/staff_members?id=eq.${member.id}`, {
    last_active_at: new Date().toISOString(),
  }).catch(() => undefined);
}
