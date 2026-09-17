import { NavLink, Outlet } from "react-router-dom";
import { Seo } from "../../components/Seo";
import { useStaffPermissions } from "../../lib/staff";
import { IconAudit, IconBoard, IconHome, IconShield, IconStaff, IconTasks } from "./opsIcons";

export function StaffLayout() {
  const { me, can } = useStaffPermissions();
  const role = me?.isSuperAdmin ? "Super Admin" : me?.roles[0]?.name || "Staff";
  const kicker = (me?.staff.department || "ELITE").toUpperCase();

  return (
    <main className="page staff-page">
      <Seo title="Staff — Replayr" description="Internal Replayr work boards." robots="noindex,nofollow" />
      <div className="ops-shell">
        <aside className="ops-rail" aria-label="Staff navigation">
          <div className="ops-rail-head">
            <p className="ops-rail-kicker">Internal</p>
            <h1 className="ops-rail-title">Staff</h1>
            <p className="ops-rail-sub">
              {kicker} · {role}
            </p>
          </div>
          <nav className="ops-nav">
            <NavLink to="/staff/board" className="ops-nav-item">
              <IconBoard />
              <span>Boards</span>
            </NavLink>
            <NavLink to="/staff/tasks" className="ops-nav-item">
              <IconTasks />
              <span>My Tasks</span>
            </NavLink>
            {can("staff.members.view") ? (
              <NavLink to="/admin/staff" className="ops-nav-item">
                <IconStaff />
                <span>Staff</span>
              </NavLink>
            ) : null}
            {can("staff.roles.view") ? (
              <NavLink to="/admin/roles" className="ops-nav-item">
                <IconShield />
                <span>Roles &amp; Permissions</span>
              </NavLink>
            ) : null}
            {can("audit.view") ? (
              <NavLink to="/admin/audit" className="ops-nav-item">
                <IconAudit />
                <span>Audit Log</span>
              </NavLink>
            ) : null}
          </nav>
          <div className="ops-rail-foot">
            <NavLink to="/" className="ops-nav-item ops-nav-home">
              <IconHome />
              <span>Go to main site</span>
            </NavLink>
          </div>
        </aside>
        <div className="ops-main">
          <Outlet />
        </div>
      </div>
    </main>
  );
}
