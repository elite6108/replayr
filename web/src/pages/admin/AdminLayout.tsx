import { Outlet, useLocation } from "react-router-dom";
import { Seo } from "../../components/Seo";
import { AccessDenied } from "../../components/RequireStaff";
import { useStaffPermissions } from "../../lib/staff";
import { AdminShell } from "./components/AdminShell";

const pagePermission = (pathname: string): string | null => {
  if (pathname === "/admin") return "admin.access";
  if (pathname === "/admin/people") return null;
  if (pathname.startsWith("/admin/people/waitlist")) return "waitlist.view";
  if (pathname.startsWith("/admin/people/creators")) return "creators.view";
  if (pathname === "/admin/library") return null;
  if (pathname.startsWith("/admin/library/storage")) return "users.quota.edit";
  if (pathname.startsWith("/admin/users")) return "users.view";
  if (pathname.startsWith("/admin/waitlist")) return "waitlist.view";
  if (pathname.startsWith("/admin/billing")) return "users.billing.edit";
  if (pathname.startsWith("/admin/clips")) return "clips.view";
  if (pathname.startsWith("/admin/storage")) return "users.quota.edit";
  if (pathname.startsWith("/admin/creators")) return "creators.view";
  if (pathname.startsWith("/admin/announcements")) return "announcements.view";
  if (pathname.startsWith("/admin/errors")) return "errors.view";
  if (pathname.startsWith("/admin/staff")) return "staff.members.view";
  if (pathname.startsWith("/admin/roles")) return "staff.roles.view";
  if (pathname.startsWith("/admin/audit")) return "audit.view";
  if (pathname.startsWith("/admin/analytics")) return "analytics.view";
  return "admin.access";
};

function canOpenAdminPath(pathname: string, can: (key: string) => boolean, canAny: (...keys: string[]) => boolean) {
  if (pathname === "/admin/people") return canAny("users.view", "waitlist.view", "creators.view");
  if (pathname === "/admin/library") return canAny("clips.view", "users.quota.edit");
  const permission = pagePermission(pathname);
  return permission ? can(permission) : false;
}

export function AdminLayout() {
  const { can, canAny } = useStaffPermissions();
  const location = useLocation();
  return (
    <main className="page admin-page">
      <Seo title="Admin — Replayr" description="Replayr operator console." robots="noindex,nofollow" />
      <AdminShell>{canOpenAdminPath(location.pathname, can, canAny) ? <Outlet /> : <AccessDenied />}</AdminShell>
    </main>
  );
}
