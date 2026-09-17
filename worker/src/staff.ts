import { AUDIT_ACTIONS, auditRequestMeta, writeAuditLog } from "./audit";
import {
  roleChangedEmail,
  sendReplayrEmail,
  staffInviteEmail,
  type EmailDelivery,
} from "./email";
import type { Env } from "./env";
import { HttpError, json } from "./http";
import { serviceRest } from "./shared";
import {
  assertPermission,
  invalidateStaffCache,
  presentMe,
  requirePermission,
  requireStaffActor,
  type StaffActor,
} from "./staffAuth";
import {
  ADMIN_ROLE_ID,
  STAFF_PERMISSIONS,
  SUPER_ADMIN_ROLE_ID,
  canGrantPermissions,
  lastSuperAdminLockout,
  roleIsSubset,
} from "./staffPermissions";
import { handleStaffBoards } from "./staffBoards";
import { handleStaffTasks, notifyStaffTaskDueSoon } from "./staffTasks";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type RoleRow = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  color: string | null;
  is_system: boolean;
  is_super_admin: boolean;
  archived_at: string | null;
  created_at: string;
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
};

type InviteRow = {
  id: string;
  email_normalized: string;
  display_name: string | null;
  job_title: string | null;
  department: string | null;
  invited_by: string | null;
  expires_at: string;
  accepted_at: string | null;
  accepted_user_id: string | null;
  status: string;
  created_at: string;
};

type PermRow = { key: string; category: string; label: string; description: string | null; sort: number };

export async function handleStaff(request: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;
  const method = request.method;

  if (method === "GET" && path === "/v1/staff/me") {
    const actor = await requirePermission(request, env, "staff.access");
    return json(presentMe(actor));
  }

  const boards = await handleStaffBoards(request, env, url);
  if (boards) return boards;
  const tasks = await handleStaffTasks(request, env, url);
  if (tasks) return tasks;

  if (method === "GET" && path === "/v1/staff/permissions") {
    await requirePermission(request, env, "staff.roles.view");
    return json({ permissions: await loadCatalog(env) });
  }

  if (method === "GET" && path === "/v1/staff/members") {
    const actor = await requirePermission(request, env, "staff.members.view");
    return listMembers(env, actor, url);
  }
  const memberItem = path.match(/^\/v1\/staff\/members\/([^/]+)$/);
  if (memberItem?.[1] && UUID.test(memberItem[1])) {
    if (method === "GET") {
      await requirePermission(request, env, "staff.members.view");
      return getMember(env, memberItem[1]);
    }
    if (method === "PATCH") {
      const actor = await requirePermission(request, env, "staff.members.edit");
      return patchMember(request, env, actor, memberItem[1]);
    }
  }
  const memberStatus = path.match(/^\/v1\/staff\/members\/([^/]+)\/(suspend|activate|deactivate)$/);
  if (memberStatus?.[1] && method === "POST") {
    const actor = await requireStaffActor(request, env);
    const action = memberStatus[2];
    assertPermission(actor, action === "suspend" ? "staff.members.suspend" : "staff.members.remove");
    return setMemberStatus(request, env, actor, memberStatus[1], action === "activate" ? "active" : action === "suspend" ? "suspended" : "inactive");
  }
  const memberRoles = path.match(/^\/v1\/staff\/members\/([^/]+)\/roles$/);
  if (memberRoles?.[1] && method === "PUT") {
    const actor = await requirePermission(request, env, "staff.roles.assign");
    return assignRoles(request, env, actor, memberRoles[1]);
  }

  if (method === "GET" && path === "/v1/staff/roles") {
    await requirePermission(request, env, "staff.roles.view");
    return listRoles(env);
  }
  if (method === "POST" && path === "/v1/staff/roles") {
    const actor = await requirePermission(request, env, "staff.roles.create");
    return createRole(request, env, actor);
  }
  const roleDup = path.match(/^\/v1\/staff\/roles\/([^/]+)\/duplicate$/);
  if (roleDup?.[1] && method === "POST") {
    const actor = await requirePermission(request, env, "staff.roles.create");
    return duplicateRole(request, env, actor, roleDup[1]);
  }
  const roleItem = path.match(/^\/v1\/staff\/roles\/([^/]+)$/);
  if (roleItem?.[1] && UUID.test(roleItem[1])) {
    if (method === "GET") {
      await requirePermission(request, env, "staff.roles.view");
      return getRole(env, roleItem[1]);
    }
    if (method === "PATCH") {
      const actor = await requirePermission(request, env, "staff.roles.edit");
      return patchRole(request, env, actor, roleItem[1]);
    }
    if (method === "DELETE") {
      const actor = await requirePermission(request, env, "staff.roles.delete");
      return deleteRole(request, env, actor, roleItem[1]);
    }
  }

  if (method === "GET" && path === "/v1/staff/invites") {
    await requirePermission(request, env, "staff.members.view");
    return listInvites(env);
  }
  if (method === "POST" && path === "/v1/staff/invites") {
    const actor = await requirePermission(request, env, "staff.members.invite");
    return createInvite(request, env, actor);
  }
  const inviteRevoke = path.match(/^\/v1\/staff\/invites\/([^/]+)\/revoke$/);
  if (inviteRevoke?.[1] && method === "POST") {
    const actor = await requirePermission(request, env, "staff.members.invite");
    return revokeInvite(env, actor, inviteRevoke[1]);
  }
  const inviteResend = path.match(/^\/v1\/staff\/invites\/([^/]+)\/resend$/);
  if (inviteResend?.[1] && method === "POST") {
    const actor = await requirePermission(request, env, "staff.members.invite");
    return resendInvite(env, actor, inviteResend[1]);
  }

  throw new HttpError(404, "Not found.");
}

export { notifyStaffTaskDueSoon };

async function loadCatalog(env: Env) {
  return serviceRest<PermRow[]>(env, "GET", "/staff_permissions?select=key,category,label,description,sort&order=sort.asc");
}

async function listMembers(env: Env, _actor: StaffActor, url: URL): Promise<Response> {
  const status = (url.searchParams.get("status") || "").trim();
  const q = (url.searchParams.get("q") || "").replace(/[,()*]/g, "").trim().slice(0, 80);
  const filters = ["select=id,user_id,display_name,job_title,department,status,created_at,last_active_at", "order=display_name.asc"];
  if (status) filters.push(`status=eq.${status}`);
  if (q) filters.push(`display_name=ilike.*${q}*`);
  const members = await serviceRest<MemberRow[]>(env, "GET", `/staff_members?${filters.join("&")}`);
  const presented = await presentMembers(env, members);
  return json({ members: presented });
}

async function getMember(env: Env, id: string): Promise<Response> {
  const members = await serviceRest<MemberRow[]>(
    env,
    "GET",
    `/staff_members?id=eq.${id}&select=id,user_id,display_name,job_title,department,status,created_at,last_active_at`,
  );
  const member = members[0];
  if (!member) throw new HttpError(404, "Staff member not found.");
  const [presented] = await presentMembers(env, [member]);
  return json({ member: presented });
}

async function presentMembers(env: Env, members: MemberRow[]) {
  if (!members.length) return [];
  const ids = members.map((row) => row.id).join(",");
  const userIds = members.map((row) => row.user_id);
  const [assignments, profiles] = await Promise.all([
    serviceRest<Array<{
      staff_id: string;
      role_id: string;
      staff_roles: { id: string; slug: string; name: string; color: string | null; is_system: boolean; is_super_admin: boolean } | Array<{
        id: string;
        slug: string;
        name: string;
        color: string | null;
        is_system: boolean;
        is_super_admin: boolean;
      }>;
    }>>(
      env,
      "GET",
      `/staff_role_assignments?staff_id=in.(${ids})&select=staff_id,role_id,staff_roles(id,slug,name,color,is_system,is_super_admin)`,
    ),
    serviceRest<Array<{ id: string; username: string | null; avatar_url: string | null }>>(
      env,
      "GET",
      `/profiles?id=in.(${userIds.join(",")})&select=id,username,avatar_url`,
    ),
  ]);
  const rolesByStaff = new Map<string, Array<{ id: string; slug: string; name: string; color: string | null; isSystem: boolean; isSuperAdmin: boolean }>>();
  for (const row of assignments) {
    const role = Array.isArray(row.staff_roles) ? row.staff_roles[0] : row.staff_roles;
    if (!role) continue;
    const list = rolesByStaff.get(row.staff_id) ?? [];
    list.push({
      id: role.id,
      slug: role.slug,
      name: role.name,
      color: role.color,
      isSystem: role.is_system,
      isSuperAdmin: role.is_super_admin,
    });
    rolesByStaff.set(row.staff_id, list);
  }
  const profileById = new Map(profiles.map((row) => [row.id, row]));
  const rolePerms = await loadRolePermissionMap(env, [...new Set(assignments.map((row) => row.role_id))]);
  return members.map((member) => {
    const roles = rolesByStaff.get(member.id) ?? [];
    const keys = new Set<string>();
    let superAdmin = false;
    for (const role of roles) {
      if (role.isSuperAdmin) superAdmin = true;
      for (const key of rolePerms.get(role.id) ?? []) keys.add(key);
    }
    return {
      id: member.id,
      userId: member.user_id,
      displayName: member.display_name,
      username: profileById.get(member.user_id)?.username ?? null,
      avatarUrl: profileById.get(member.user_id)?.avatar_url ?? null,
      jobTitle: member.job_title,
      department: member.department,
      status: member.status,
      createdAt: member.created_at,
      lastActiveAt: member.last_active_at,
      roles,
      permissions: superAdmin ? ["*"] : [...keys].sort(),
      isSuperAdmin: superAdmin,
    };
  });
}

async function loadRolePermissionMap(env: Env, roleIds: string[]) {
  const map = new Map<string, string[]>();
  if (!roleIds.length) return map;
  const rows = await serviceRest<Array<{ role_id: string; permission_key: string }>>(
    env,
    "GET",
    `/staff_role_permissions?role_id=in.(${roleIds.join(",")})&select=role_id,permission_key`,
  );
  for (const row of rows) {
    const list = map.get(row.role_id) ?? [];
    list.push(row.permission_key);
    map.set(row.role_id, list);
  }
  return map;
}

async function patchMember(request: Request, env: Env, actor: StaffActor, id: string): Promise<Response> {
  const existing = await mustMember(env, id);
  const body = (await request.json().catch(() => ({}))) as {
    displayName?: string;
    jobTitle?: string | null;
    department?: string | null;
  };
  const patch: Record<string, unknown> = {};
  if (typeof body.displayName === "string" && body.displayName.trim()) patch.display_name = body.displayName.trim().slice(0, 80);
  if ("jobTitle" in body) patch.job_title = typeof body.jobTitle === "string" ? body.jobTitle.trim().slice(0, 80) || null : null;
  if ("department" in body) patch.department = typeof body.department === "string" ? body.department.trim().slice(0, 80) || null : null;
  if (!Object.keys(patch).length) throw new HttpError(400, "Nothing to update.");
  await serviceRest(env, "PATCH", `/staff_members?id=eq.${id}`, patch);
  invalidateStaffCache(existing.user_id);
  await writeAuditLog(env, {
    actorUserId: actor.userId,
    actorType: "admin",
    action: AUDIT_ACTIONS.staffRoleChanged,
    targetType: "staff_member",
    targetId: id,
    requestId: actor.requestId,
    metadata: auditRequestMeta(request),
    before: { displayName: existing.display_name, jobTitle: existing.job_title, department: existing.department },
    after: patch,
  });
  return getMember(env, id);
}

async function setMemberStatus(
  request: Request,
  env: Env,
  actor: StaffActor,
  id: string,
  status: "active" | "suspended" | "inactive",
): Promise<Response> {
  const member = await mustMember(env, id);
  if (member.id === actor.staffId && status !== "active") {
    throw new HttpError(400, "You cannot suspend or deactivate your own membership.");
  }
  const wasSuper = await memberIsSuperAdmin(env, member.id);
  if (wasSuper && status !== "active") {
    const remaining = await countActiveSuperAdmins(env);
    const message = lastSuperAdminLockout(remaining, true);
    if (message) throw new HttpError(400, message);
  }
  await serviceRest(env, "PATCH", `/staff_members?id=eq.${id}`, { status });
  invalidateStaffCache(member.user_id);
  await writeAuditLog(env, {
    actorUserId: actor.userId,
    actorType: "admin",
    action: AUDIT_ACTIONS.staffSuspended,
    targetType: "staff_member",
    targetId: id,
    requestId: actor.requestId,
    metadata: { ...auditRequestMeta(request), status },
    before: { status: member.status },
    after: { status },
  });
  return getMember(env, id);
}

async function assignRoles(request: Request, env: Env, actor: StaffActor, id: string): Promise<Response> {
  const member = await mustMember(env, id);
  const body = (await request.json().catch(() => ({}))) as { roleIds?: unknown };
  const roleIds = Array.isArray(body.roleIds)
    ? [...new Set(body.roleIds.filter((value): value is string => typeof value === "string" && UUID.test(value)))]
    : [];
  if (!roleIds.length) throw new HttpError(400, "Assign at least one role.");
  const roles = await loadRolesByIds(env, roleIds);
  if (roles.length !== roleIds.length) throw new HttpError(400, "One or more roles were not found.");
  if (roles.some((role) => role.archived_at)) throw new HttpError(400, "Cannot assign an archived role.");

  const manageAll = actor.isSuperAdmin || actor.permissions.has("staff.roles.manage_all");
  const assigningSuper = roles.some((role) => role.is_super_admin);
  if (assigningSuper && !manageAll) throw new HttpError(403, "Only Super Admin can assign Super Admin.");

  const rolePerms = await loadRolePermissionMap(env, roleIds);
  for (const role of roles) {
    if (role.is_super_admin) continue;
    const keys = new Set(rolePerms.get(role.id) ?? []);
    if (!roleIsSubset(keys, actor.permissions, manageAll)) {
      throw new HttpError(403, `You cannot assign ${role.name} because it grants permissions you do not have.`);
    }
  }

  const current = await serviceRest<Array<{ role_id: string }>>(env, "GET", `/staff_role_assignments?staff_id=eq.${id}&select=role_id`);
  const currentIds = current.map((row) => row.role_id);
  const assignmentsChanged =
    currentIds.length !== roleIds.length ||
    currentIds.some((roleId) => !roleIds.includes(roleId));
  const removingSuper = currentIds.includes(SUPER_ADMIN_ROLE_ID) && !roleIds.includes(SUPER_ADMIN_ROLE_ID);
  if (removingSuper) {
    if (member.id === actor.staffId && !manageAll) {
      throw new HttpError(400, "You cannot strip Super Admin from yourself.");
    }
    const remaining = await countActiveSuperAdmins(env);
    const message = lastSuperAdminLockout(remaining, true);
    if (message) throw new HttpError(400, message);
  }

  await serviceRest(env, "DELETE", `/staff_role_assignments?staff_id=eq.${id}`);
  await serviceRest(
    env,
    "POST",
    "/staff_role_assignments",
    roleIds.map((roleId) => ({ staff_id: id, role_id: roleId, created_by: actor.userId })),
  );
  invalidateStaffCache(member.user_id);
  await syncJwtAdmin(env, member.user_id, roleIds.includes(SUPER_ADMIN_ROLE_ID));
  let delivery: EmailDelivery | undefined;
  if (assignmentsChanged && member.status === "active") {
    const email = await verifiedAuthEmail(env, member.user_id);
    if (email) {
      const content = roleChangedEmail({
        recipientName: member.display_name,
        roles: roles.map((role) => role.name),
        staffUrl: `${publicAppOrigin(env)}/staff`,
      });
      delivery = await sendReplayrEmail(env, {
        to: email,
        ...content,
        idempotencyKey: `staff-role-change/${id}/${actor.requestId || crypto.randomUUID()}`,
      });
    } else {
      delivery = {
        sent: false,
        warning: "Roles changed, but the member does not have a verified email address.",
      };
    }
  }
  await writeAuditLog(env, {
    actorUserId: actor.userId,
    actorType: "admin",
    action: AUDIT_ACTIONS.staffRoleChanged,
    targetType: "staff_member",
    targetId: id,
    requestId: actor.requestId,
    metadata: {
      ...auditRequestMeta(request),
      ...(delivery ? { emailDelivery: delivery.sent ? "sent" : "failed" } : {}),
    },
    before: { roleIds: currentIds },
    after: { roleIds },
  });
  const memberResponse = await getMember(env, id);
  const memberBody = (await memberResponse.json()) as { member: unknown };
  return json({ ...memberBody, ...(delivery ? { delivery } : {}) });
}

async function listRoles(env: Env): Promise<Response> {
  const [roles, catalog, counts, perms] = await Promise.all([
    serviceRest<RoleRow[]>(env, "GET", "/staff_roles?select=id,slug,name,description,color,is_system,is_super_admin,archived_at,created_at&order=name.asc&archived_at=is.null"),
    loadCatalog(env),
    serviceRest<Array<{ role_id: string }>>(env, "GET", "/staff_role_assignments?select=role_id"),
    serviceRest<Array<{ role_id: string; permission_key: string }>>(env, "GET", "/staff_role_permissions?select=role_id,permission_key"),
  ]);
  const countMap = new Map<string, number>();
  for (const row of counts) countMap.set(row.role_id, (countMap.get(row.role_id) ?? 0) + 1);
  const permMap = new Map<string, string[]>();
  for (const row of perms) {
    const list = permMap.get(row.role_id) ?? [];
    list.push(row.permission_key);
    permMap.set(row.role_id, list);
  }
  return json({
    catalog,
    roles: roles.map((role) => ({
      id: role.id,
      slug: role.slug,
      name: role.name,
      description: role.description,
      color: role.color,
      isSystem: role.is_system,
      isSuperAdmin: role.is_super_admin,
      archivedAt: role.archived_at,
      createdAt: role.created_at,
      memberCount: countMap.get(role.id) ?? 0,
      permissions: role.is_super_admin ? [...STAFF_PERMISSIONS] : (permMap.get(role.id) ?? []).sort(),
    })),
  });
}

async function getRole(env: Env, id: string): Promise<Response> {
  const roles = await loadRolesByIds(env, [id]);
  const role = roles[0];
  if (!role || role.archived_at) throw new HttpError(404, "Role not found.");
  const perms = role.is_super_admin
    ? [...STAFF_PERMISSIONS]
    : (await serviceRest<Array<{ permission_key: string }>>(env, "GET", `/staff_role_permissions?role_id=eq.${id}&select=permission_key`)).map(
        (row) => row.permission_key,
      );
  return json({
    role: {
      id: role.id,
      slug: role.slug,
      name: role.name,
      description: role.description,
      color: role.color,
      isSystem: role.is_system,
      isSuperAdmin: role.is_super_admin,
      permissions: perms.sort(),
    },
  });
}

async function createRole(request: Request, env: Env, actor: StaffActor): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as {
    name?: string;
    description?: string;
    color?: string;
    permissions?: string[];
  };
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 60) : "";
  if (!name) throw new HttpError(400, "Name is required.");
  const permissions = Array.isArray(body.permissions) ? body.permissions.map(String) : [];
  const manageAll = actor.isSuperAdmin || actor.permissions.has("staff.roles.manage_all");
  const grantError = canGrantPermissions(actor.permissions, permissions, manageAll);
  if (grantError) throw new HttpError(403, grantError);
  const slug = await uniqueSlug(env, slugify(name));
  const created = await serviceRest<RoleRow[]>(
    env,
    "POST",
    "/staff_roles",
    {
      slug,
      name,
      description: typeof body.description === "string" ? body.description.trim().slice(0, 280) || null : null,
      color: typeof body.color === "string" ? body.color.slice(0, 16) : null,
      is_system: false,
      is_super_admin: false,
    },
    "return=representation",
  );
  const role = created[0];
  if (!role) throw new HttpError(502, "Could not create role.");
  if (permissions.length) {
    await serviceRest(
      env,
      "POST",
      "/staff_role_permissions",
      permissions.map((key) => ({ role_id: role.id, permission_key: key })),
    );
  }
  invalidateStaffCache();
  await writeAuditLog(env, {
    actorUserId: actor.userId,
    actorType: "admin",
    action: AUDIT_ACTIONS.staffRoleCreated,
    targetType: "staff_role",
    targetId: role.id,
    requestId: actor.requestId,
    metadata: auditRequestMeta(request),
    after: { name, slug, permissions },
  });
  return getRole(env, role.id);
}

async function patchRole(request: Request, env: Env, actor: StaffActor, id: string): Promise<Response> {
  const roles = await loadRolesByIds(env, [id]);
  const role = roles[0];
  if (!role || role.archived_at) throw new HttpError(404, "Role not found.");
  const manageAll = actor.isSuperAdmin || actor.permissions.has("staff.roles.manage_all");
  if (role.is_system && !manageAll) throw new HttpError(403, "System roles cannot be edited.");
  if (role.is_super_admin) throw new HttpError(403, "Super Admin permissions cannot be edited.");
  const body = (await request.json().catch(() => ({}))) as {
    name?: string;
    description?: string | null;
    color?: string | null;
    permissions?: string[];
  };
  const patch: Record<string, unknown> = {};
  if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim().slice(0, 60);
  if ("description" in body) patch.description = typeof body.description === "string" ? body.description.trim().slice(0, 280) || null : null;
  if ("color" in body) patch.color = typeof body.color === "string" ? body.color.slice(0, 16) : null;
  if (Object.keys(patch).length) {
    await serviceRest(env, "PATCH", `/staff_roles?id=eq.${id}`, patch);
  }
  if (Array.isArray(body.permissions)) {
    const grantError = canGrantPermissions(actor.permissions, body.permissions, manageAll);
    if (grantError) throw new HttpError(403, grantError);
    const current = await serviceRest<Array<{ permission_key: string }>>(
      env,
      "GET",
      `/staff_role_permissions?role_id=eq.${id}&select=permission_key`,
    );
    await serviceRest(env, "DELETE", `/staff_role_permissions?role_id=eq.${id}`);
    if (body.permissions.length) {
      await serviceRest(
        env,
        "POST",
        "/staff_role_permissions",
        body.permissions.map((key) => ({ role_id: id, permission_key: key })),
      );
    }
    invalidateStaffCache();
    await writeAuditLog(env, {
      actorUserId: actor.userId,
      actorType: "admin",
      action: AUDIT_ACTIONS.staffPermissionsChanged,
      targetType: "staff_role",
      targetId: id,
      requestId: actor.requestId,
      metadata: auditRequestMeta(request),
      before: { permissions: current.map((row) => row.permission_key) },
      after: { permissions: body.permissions },
    });
  }
  return getRole(env, id);
}

async function duplicateRole(request: Request, env: Env, actor: StaffActor, id: string): Promise<Response> {
  const roles = await loadRolesByIds(env, [id]);
  const role = roles[0];
  if (!role) throw new HttpError(404, "Role not found.");
  if (role.is_super_admin) throw new HttpError(400, "Super Admin cannot be duplicated.");
  const perms = (
    await serviceRest<Array<{ permission_key: string }>>(env, "GET", `/staff_role_permissions?role_id=eq.${id}&select=permission_key`)
  ).map((row) => row.permission_key);
  const cloned = new Request(request.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: `${role.name} copy`,
      description: role.description,
      color: role.color,
      permissions: perms,
    }),
  });
  return createRole(cloned, env, actor);
}

async function deleteRole(request: Request, env: Env, actor: StaffActor, id: string): Promise<Response> {
  const roles = await loadRolesByIds(env, [id]);
  const role = roles[0];
  if (!role) throw new HttpError(404, "Role not found.");
  if (role.is_system) throw new HttpError(400, "System roles cannot be deleted.");
  const body = (await request.json().catch(() => ({}))) as { reassignTo?: string; clearAssignments?: boolean };
  const assigned = await serviceRest<Array<{ staff_id: string }>>(env, "GET", `/staff_role_assignments?role_id=eq.${id}&select=staff_id`);
  if (assigned.length && !body.clearAssignments && !body.reassignTo) {
    throw new HttpError(409, "Reassign or clear members before deleting this role.");
  }
  if (body.reassignTo) {
    if (!UUID.test(body.reassignTo) || body.reassignTo === id) throw new HttpError(400, "reassignTo is invalid.");
    const target = (await loadRolesByIds(env, [body.reassignTo]))[0];
    if (!target || target.archived_at) throw new HttpError(400, "Replacement role was not found.");
    for (const row of assigned) {
      await serviceRest(env, "POST", "/staff_role_assignments", {
        staff_id: row.staff_id,
        role_id: body.reassignTo,
        created_by: actor.userId,
      }).catch(() => undefined);
    }
  }
  await serviceRest(env, "DELETE", `/staff_role_assignments?role_id=eq.${id}`);
  await serviceRest(env, "PATCH", `/staff_roles?id=eq.${id}`, { archived_at: new Date().toISOString() });
  invalidateStaffCache();
  await writeAuditLog(env, {
    actorUserId: actor.userId,
    actorType: "admin",
    action: AUDIT_ACTIONS.staffRoleDeleted,
    targetType: "staff_role",
    targetId: id,
    requestId: actor.requestId,
    metadata: auditRequestMeta(request),
    before: { slug: role.slug, name: role.name },
  });
  return json({ ok: true });
}

async function listInvites(env: Env): Promise<Response> {
  const invites = await serviceRest<InviteRow[]>(
    env,
    "GET",
    "/staff_invites?select=id,email_normalized,display_name,job_title,department,invited_by,expires_at,accepted_at,accepted_user_id,status,created_at&order=created_at.desc",
  );
  if (!invites.length) return json({ invites: [] });
  const ids = invites.map((row) => row.id).join(",");
  const roleRows = await serviceRest<Array<{
    invite_id: string;
    role_id: string;
    staff_roles: { id: string; name: string; slug: string } | Array<{ id: string; name: string; slug: string }>;
  }>>(env, "GET", `/staff_invite_roles?invite_id=in.(${ids})&select=invite_id,role_id,staff_roles(id,name,slug)`);
  const byInvite = new Map<string, Array<{ id: string; name: string; slug: string }>>();
  for (const row of roleRows) {
    const role = Array.isArray(row.staff_roles) ? row.staff_roles[0] : row.staff_roles;
    if (!role) continue;
    const list = byInvite.get(row.invite_id) ?? [];
    list.push(role);
    byInvite.set(row.invite_id, list);
  }
  return json({
    invites: invites.map((row) => ({
      id: row.id,
      email: row.email_normalized,
      displayName: row.display_name,
      jobTitle: row.job_title,
      department: row.department,
      status: row.status,
      expiresAt: row.expires_at,
      acceptedAt: row.accepted_at,
      createdAt: row.created_at,
      roles: byInvite.get(row.id) ?? [],
    })),
  });
}

async function createInvite(request: Request, env: Env, actor: StaffActor): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as {
    email?: string;
    displayName?: string;
    jobTitle?: string;
    department?: string;
    roleIds?: string[];
  };
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!EMAIL.test(email)) throw new HttpError(400, "A valid email is required.");
  const roleIds = Array.isArray(body.roleIds)
    ? [...new Set(body.roleIds.filter((value): value is string => typeof value === "string" && UUID.test(value)))]
    : [ADMIN_ROLE_ID];
  const roles = await loadRolesByIds(env, roleIds);
  if (!roles.length) throw new HttpError(400, "Assign at least one role.");
  if (roles.length !== roleIds.length) throw new HttpError(400, "One or more roles were not found.");
  const manageAll = actor.isSuperAdmin || actor.permissions.has("staff.roles.manage_all");
  if (roles.some((role) => role.is_super_admin) && !manageAll) {
    throw new HttpError(403, "Only Super Admin can invite Super Admins.");
  }
  const rolePerms = await loadRolePermissionMap(env, roleIds);
  for (const role of roles) {
    if (role.is_super_admin) continue;
    if (!roleIsSubset(new Set(rolePerms.get(role.id) ?? []), actor.permissions, manageAll)) {
      throw new HttpError(403, `You cannot invite with role ${role.name}.`);
    }
  }
  const created = await serviceRest<InviteRow[]>(
    env,
    "POST",
    "/staff_invites",
    {
      email_normalized: email,
      display_name: typeof body.displayName === "string" ? body.displayName.trim().slice(0, 80) || null : null,
      job_title: typeof body.jobTitle === "string" ? body.jobTitle.trim().slice(0, 80) || null : null,
      department: typeof body.department === "string" ? body.department.trim().slice(0, 80) || null : null,
      invited_by: actor.userId,
      status: "pending",
    },
    "return=representation",
  ).catch((caught) => {
    if (caught instanceof HttpError && caught.status === 409) throw new HttpError(409, "A pending invite already exists for that email.");
    throw caught;
  });
  const invite = created[0];
  if (!invite) throw new HttpError(502, "Could not create invite.");
  await serviceRest(
    env,
    "POST",
    "/staff_invite_roles",
    roleIds.map((roleId) => ({ invite_id: invite.id, role_id: roleId })),
  );
  const content = staffInviteEmail({
    recipientName: invite.display_name,
    inviterName: actor.displayName,
    roles: roles.map((role) => role.name),
    expiresAt: invite.expires_at,
    inviteUrl: `${publicAppOrigin(env)}/signin?next=%2Fstaff`,
  });
  const delivery = await sendReplayrEmail(env, {
    to: email,
    ...content,
    idempotencyKey: `staff-invite/${invite.id}`,
  });
  await writeAuditLog(env, {
    actorUserId: actor.userId,
    actorType: "admin",
    action: AUDIT_ACTIONS.staffInvited,
    targetType: "staff_invite",
    targetId: invite.id,
    requestId: actor.requestId,
    metadata: {
      ...auditRequestMeta(request),
      email,
      emailDelivery: delivery.sent ? "sent" : "failed",
    },
    after: { email, roleIds },
  });
  return json({ invite: { id: invite.id, email, status: "pending" }, delivery });
}

async function revokeInvite(env: Env, actor: StaffActor, id: string): Promise<Response> {
  if (!UUID.test(id)) throw new HttpError(400, "Invite id is invalid.");
  await serviceRest(env, "PATCH", `/staff_invites?id=eq.${id}&status=eq.pending`, { status: "revoked" });
  await writeAuditLog(env, {
    actorUserId: actor.userId,
    actorType: "admin",
    action: AUDIT_ACTIONS.staffInvited,
    targetType: "staff_invite",
    targetId: id,
    requestId: actor.requestId,
    after: { status: "revoked" },
  });
  return json({ ok: true });
}

async function resendInvite(env: Env, actor: StaffActor, id: string): Promise<Response> {
  if (!UUID.test(id)) throw new HttpError(400, "Invite id is invalid.");
  const invites = await serviceRest<InviteRow[]>(
    env,
    "GET",
    `/staff_invites?id=eq.${id}&status=eq.pending&select=id,email_normalized,display_name,job_title,department,invited_by,expires_at,accepted_at,accepted_user_id,status,created_at`,
  );
  const invite = invites[0];
  if (!invite) throw new HttpError(404, "Pending invite not found.");
  if (new Date(invite.expires_at).getTime() < Date.now()) {
    await serviceRest(env, "PATCH", `/staff_invites?id=eq.${id}`, { status: "expired" });
    throw new HttpError(410, "That invitation has expired.");
  }
  const roleRows = await serviceRest<Array<{
    staff_roles: { name: string } | Array<{ name: string }>;
  }>>(
    env,
    "GET",
    `/staff_invite_roles?invite_id=eq.${id}&select=staff_roles(name)`,
  );
  const roleNames = roleRows
    .map((row) => Array.isArray(row.staff_roles) ? row.staff_roles[0]?.name : row.staff_roles?.name)
    .filter((name): name is string => Boolean(name));
  const content = staffInviteEmail({
    recipientName: invite.display_name,
    inviterName: actor.displayName,
    roles: roleNames,
    expiresAt: invite.expires_at,
    inviteUrl: `${publicAppOrigin(env)}/signin?next=%2Fstaff`,
  });
  const delivery = await sendReplayrEmail(env, {
    to: invite.email_normalized,
    ...content,
    idempotencyKey: `staff-invite-resend/${id}/${actor.requestId || crypto.randomUUID()}`,
  });
  await writeAuditLog(env, {
    actorUserId: actor.userId,
    actorType: "admin",
    action: AUDIT_ACTIONS.staffInvited,
    targetType: "staff_invite",
    targetId: id,
    requestId: actor.requestId,
    metadata: {
      email: invite.email_normalized,
      resend: true,
      emailDelivery: delivery.sent ? "sent" : "failed",
    },
  });
  return json({ ok: delivery.sent, delivery });
}

async function mustMember(env: Env, id: string): Promise<MemberRow> {
  if (!UUID.test(id)) throw new HttpError(400, "Staff id is invalid.");
  const rows = await serviceRest<MemberRow[]>(
    env,
    "GET",
    `/staff_members?id=eq.${id}&select=id,user_id,display_name,job_title,department,status,created_at,last_active_at`,
  );
  if (!rows[0]) throw new HttpError(404, "Staff member not found.");
  return rows[0];
}

async function loadRolesByIds(env: Env, ids: string[]) {
  if (!ids.length) return [];
  return serviceRest<RoleRow[]>(
    env,
    "GET",
    `/staff_roles?id=in.(${ids.join(",")})&select=id,slug,name,description,color,is_system,is_super_admin,archived_at,created_at`,
  );
}

async function memberIsSuperAdmin(env: Env, staffId: string): Promise<boolean> {
  const rows = await serviceRest<Array<{ role_id: string }>>(
    env,
    "GET",
    `/staff_role_assignments?staff_id=eq.${staffId}&role_id=eq.${SUPER_ADMIN_ROLE_ID}&select=role_id`,
  );
  return rows.length > 0;
}

async function countActiveSuperAdmins(env: Env): Promise<number> {
  const assignments = await serviceRest<Array<{ staff_id: string }>>(
    env,
    "GET",
    `/staff_role_assignments?role_id=eq.${SUPER_ADMIN_ROLE_ID}&select=staff_id`,
  );
  if (!assignments.length) return 0;
  const members = await serviceRest<Array<{ id: string; status: string }>>(
    env,
    "GET",
    `/staff_members?id=in.(${assignments.map((row) => row.staff_id).join(",")})&select=id,status`,
  );
  return members.filter((row) => row.status === "active").length;
}

async function uniqueSlug(env: Env, base: string): Promise<string> {
  let slug = base || "role";
  for (let i = 0; i < 8; i++) {
    const existing = await serviceRest<Array<{ id: string }>>(env, "GET", `/staff_roles?slug=eq.${slug}&select=id`);
    if (!existing.length) return slug;
    slug = `${base}-${i + 2}`;
  }
  return `${base}-${crypto.randomUUID().slice(0, 6)}`;
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

async function syncJwtAdmin(env: Env, userId: string, isSuper: boolean) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) return;
  try {
    const current = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
      headers: { apikey: key, authorization: `Bearer ${key}` },
    });
    if (!current.ok) return;
    const user = (await current.json()) as { app_metadata?: Record<string, unknown> };
    const meta = { ...(user.app_metadata ?? {}) };
    if (isSuper) meta.role = "admin";
    else if (meta.role === "admin") delete meta.role;
    else return;
    await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
      method: "PUT",
      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ app_metadata: meta }),
    });
  } catch {
    /* observational */
  }
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
