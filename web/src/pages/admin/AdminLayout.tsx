import { NavLink, Outlet, useLocation } from "react-router-dom";
import { Seo } from "../../components/Seo";
import { AccessDenied } from "../../components/RequireStaff";
import { useStaffPermissions } from "../../lib/staff";
import { analyticsSidebarItems } from "./analytics/analyticsNav";

const operationalLinks: Array<{ to: string; label: string; end?: boolean; permission: string }> = [
  { to: "/admin", label: "Overview", end: true, permission: "admin.access" },
  { to: "/admin/users", label: "Users", permission: "users.view" },
  { to: "/admin/billing", label: "Billing", permission: "users.billing.edit" },
  { to: "/admin/clips", label: "Clips", permission: "clips.view" },
  { to: "/admin/storage", label: "Storage", permission: "users.quota.edit" },
  { to: "/admin/creators", label: "Creators", permission: "creators.view" },
  { to: "/admin/announcements", label: "Announcements", permission: "announcements.view" },
  { to: "/admin/errors", label: "Errors", permission: "errors.view" },
  { to: "/admin/staff", label: "Staff", permission: "staff.members.view" },
  { to: "/admin/roles", label: "Roles", permission: "staff.roles.view" },
];

const pagePermission = (pathname: string): string => {
  if (pathname === "/admin") return "admin.access";
  if (pathname.startsWith("/admin/users")) return "users.view";
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
      <div className="admin-shell">
        <aside className="admin-rail">
          <p className="admin-kicker">Operator</p>
          <h1>Admin</h1>
          <p className="muted admin-rail-copy">
            Privileged actions go through the Worker. Soft-delete only. Share links stay <code>/c/…</code>.
          </p>
          <nav className="admin-nav" aria-label="Admin">
            {operationalLinks.filter((link) => can(link.permission)).map((link) => (
              <NavLink key={link.to} to={link.to} end={link.end}>
                {link.label}
              </NavLink>
            ))}
            {can("analytics.view") ? (
              <>
                <p className="admin-nav-group">Analytics</p>
                {analyticsSidebarItems.map((link) => (
                  <NavLink key={link.to} to={link.to} end={link.end}>
                    {link.label}
                  </NavLink>
                ))}
              </>
            ) : null}
            {can("audit.view") ? <NavLink to="/admin/audit">Audit Log</NavLink> : null}
            {can("staff.access") ? <NavLink to="/staff/board">Work board</NavLink> : null}
          </nav>
        </aside>
        <div className="admin-main">{can(permission) ? <Outlet /> : <AccessDenied />}</div>
      </div>
    </main>
  );
}
