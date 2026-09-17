import { Outlet, useLocation } from "react-router-dom";
import { Seo } from "../../components/Seo";
import { AccessDenied } from "../../components/RequireStaff";
import { useStaffPermissions } from "../../lib/staff";
import { AdminShell } from "./components/AdminShell";

const pagePermission = (pathname: string): string => {
  if (pathname === "/admin") return "admin.access";
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

export function AdminLayout() {
  const { can } = useStaffPermissions();
  const location = useLocation();
  const permission = pagePermission(location.pathname);
  return (
    <main className="page admin-page">
      <Seo title="Admin — Replayr" description="Replayr operator console." robots="noindex,nofollow" />
      <AdminShell>{can(permission) ? <Outlet /> : <AccessDenied />}</AdminShell>
    </main>
  );
}
