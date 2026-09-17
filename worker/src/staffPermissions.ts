/** Permission keys seeded in staff_permissions. Keep in sync with the migration. */

export const STAFF_PERMISSIONS = [
  "staff.access",
  "admin.access",
  "staff.members.view",
  "staff.members.invite",
  "staff.members.edit",
  "staff.members.suspend",
  "staff.members.remove",
  "staff.roles.view",
  "staff.roles.create",
  "staff.roles.edit",
  "staff.roles.delete",
  "staff.roles.assign",
  "staff.roles.manage_all",
  "users.view",
  "users.billing.edit",
  "users.quota.edit",
  "waitlist.view",
  "waitlist.send",
  "waitlist.templates.manage",
  "clips.view",
  "clips.delete",
  "screenshots.delete",
  "creators.view",
  "creators.review",
  "announcements.view",
  "announcements.manage",
  "system.settings.view",
  "system.settings.edit",
  "system.plans.edit",
  "errors.view",
  "errors.resolve",
  "analytics.view",
  "analytics.config",
  "analytics.reports",
  "analytics.backfill",
  "audit.view",
  "board.view",
  "board.create",
  "board.edit",
  "board.delete",
  "board.members.manage",
  "board.columns.create",
  "board.columns.edit",
  "board.columns.delete",
  "board.cards.create",
  "board.cards.edit",
  "board.cards.delete",
  "board.cards.move",
  "board.cards.assign",
  "board.comments.create",
  "board.comments.delete",
  "board.labels.manage",
  "board.checklists.manage",
  "board.attachments.upload",
  "board.attachments.delete",
] as const;

export type StaffPermission = (typeof STAFF_PERMISSIONS)[number];

export const SUPER_ADMIN_ROLE_ID = "00000000-0000-4000-8000-000000000001";
export const ADMIN_ROLE_ID = "00000000-0000-4000-8000-000000000002";
export const STAFF_ROLE_ID = "00000000-0000-4000-8000-000000000003";

const PROTECTED = new Set<StaffPermission>(["staff.roles.manage_all"]);

export function isStaffPermission(value: string): value is StaffPermission {
  return (STAFF_PERMISSIONS as readonly string[]).includes(value);
}

export function canGrantPermissions(actorKeys: Set<string>, requested: string[], manageAll: boolean): string | null {
  if (manageAll) {
    return requested.some((key) => !isStaffPermission(key)) ? "Unknown permission." : null;
  }
  for (const key of requested) {
    if (!isStaffPermission(key)) return "Unknown permission.";
    if (PROTECTED.has(key)) return "Only Super Admin can grant that permission.";
    if (!actorKeys.has(key)) return `You cannot grant ${key} because you do not have it.`;
  }
  return null;
}

export function roleIsSubset(roleKeys: Set<string>, actorKeys: Set<string>, manageAll: boolean): boolean {
  if (manageAll) return true;
  for (const key of roleKeys) {
    if (!actorKeys.has(key)) return false;
  }
  return true;
}

export function lastSuperAdminLockout(activeSuperCount: number, actionRemovesSuper: boolean): string | null {
  if (actionRemovesSuper && activeSuperCount <= 1) return "Cannot remove the last Super Admin.";
  return null;
}

export function permissionForAdminRoute(method: string, path: string): StaffPermission | null {
  if (path === "/v1/admin/overview") return "admin.access";
  if (path === "/v1/admin/users" && method === "GET") return "users.view";
  if (path === "/v1/admin/waitlist" && method === "GET") return "waitlist.view";
  if (path === "/v1/admin/waitlist/templates" && method === "GET") return "waitlist.view";
  if (path === "/v1/admin/waitlist/templates" && method === "POST") return "waitlist.templates.manage";
  if (/^\/v1\/admin\/waitlist\/templates\/[^/]+$/.test(path) && (method === "PATCH" || method === "DELETE")) {
    return "waitlist.templates.manage";
  }
  if (path === "/v1/admin/waitlist/rewrite" && method === "POST") return "waitlist.send";
  if (path === "/v1/admin/waitlist/campaigns" && method === "POST") return "waitlist.send";
  if (path === "/v1/admin/waitlist/campaigns" && method === "GET") return "waitlist.view";
  if (path.startsWith("/v1/admin/users/") && path.endsWith("/billing") && method === "POST") return "users.billing.edit";
  if (/^\/v1\/admin\/users\/[^/]+$/.test(path) && method === "PATCH") return null;
  if (path === "/v1/admin/billing" && method === "GET") return "users.billing.edit";
  if (path === "/v1/admin/settings" && method === "GET") return "system.settings.view";
  if (path === "/v1/admin/settings" && method === "PATCH") return "system.settings.edit";
  if (path === "/v1/admin/plans" && method === "GET") return "system.settings.view";
  if (path.startsWith("/v1/admin/plans/") && method === "PATCH") return "system.plans.edit";
  if (path === "/v1/admin/clips" && method === "GET") return "clips.view";
  if (/^\/v1\/admin\/clips\/[^/]+$/.test(path) && method === "DELETE") return "clips.delete";
  if (/^\/v1\/admin\/screenshots\/[^/]+$/.test(path) && method === "DELETE") return "screenshots.delete";
  if (path === "/v1/admin/storage" && method === "GET") return "users.quota.edit";
  if (path === "/v1/admin/errors" && method === "GET") return "errors.view";
  if (/^\/v1\/admin\/errors\/[^/]+$/.test(path) && method === "PATCH") return "errors.resolve";
  if (path === "/v1/admin/creators" && method === "GET") return "creators.view";
  if (path.includes("/creators/") && path.endsWith("/review") && method === "POST") return "creators.review";
  if (path === "/v1/admin/announcements" && method === "GET") return "announcements.view";
  if (path.startsWith("/v1/admin/announcements") && method !== "GET") return "announcements.manage";
  if (path === "/v1/admin/audit") return "audit.view";
  if (path === "/v1/admin/analytics/cost-assumptions" && method === "PATCH") return "analytics.config";
  if (path === "/v1/admin/analytics/backfill" && method === "POST") return "analytics.backfill";
  if (path.startsWith("/v1/admin/analytics/reports") && method === "GET") return "analytics.reports";
  if (path.startsWith("/v1/admin/analytics/reports") && method !== "GET") return "analytics.reports";
  if (path.startsWith("/v1/admin/analytics")) return "analytics.view";
  return "admin.access";
}
