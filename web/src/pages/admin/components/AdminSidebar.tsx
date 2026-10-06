import { useStaffPermissions } from "../../../lib/staff";
import { AdminNavItem } from "./AdminNavItem";
import {
  IconAnnouncements,
  IconBilling,
  IconBoard,
  IconChart,
  IconClips,
  IconErrors,
  IconOverview,
  IconUsers,
} from "./adminIcons";

export function AdminSidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { can } = useStaffPermissions();
  const peopleTo = can("users.view")
    ? "/admin/people"
    : can("waitlist.view")
      ? "/admin/people/waitlist"
      : "/admin/people/creators";
  const libraryTo = can("clips.view") ? "/admin/library" : "/admin/library/storage";
  const teamTo = can("staff.access")
    ? "/staff/board"
    : can("staff.members.view")
      ? "/admin/staff"
      : can("staff.roles.view")
        ? "/admin/roles"
        : "/admin/audit";

  const links = [
    can("admin.access") ? { to: "/admin", label: "Overview", end: true, icon: IconOverview } : null,
    can("users.view") || can("waitlist.view") || can("creators.view")
      ? { to: peopleTo, label: "People", icon: IconUsers, activePrefix: "/admin/people" }
      : null,
    can("clips.view") || can("users.quota.edit")
      ? { to: libraryTo, label: "Library", icon: IconClips, activePrefix: "/admin/library" }
      : null,
    can("users.billing.edit") ? { to: "/admin/billing", label: "Billing", end: true, icon: IconBilling } : null,
    can("announcements.view") ? { to: "/admin/announcements", label: "Announcements", end: true, icon: IconAnnouncements } : null,
    can("errors.view") ? { to: "/admin/errors", label: "Errors", end: true, icon: IconErrors } : null,
    can("analytics.view") ? { to: "/admin/analytics", label: "Analytics", icon: IconChart } : null,
    can("staff.access") || can("staff.members.view") || can("staff.roles.view") || can("audit.view")
      ? {
          to: teamTo,
          label: "Team",
          icon: IconBoard,
          activePrefix: ["/staff", "/admin/staff", "/admin/roles", "/admin/audit"],
        }
      : null,
  ].filter((link) => link != null);

  return (
    <aside className="admin-rail">
      <div className="admin-rail-head">
        <p className="admin-kicker">Operator</p>
        <h1>Admin</h1>
        <p className="admin-rail-copy">Manage the platform, your team, and keep Replayr running smoothly.</p>
      </div>
      <nav className="admin-nav" aria-label="Admin">
        {links.map((link) => (
          <AdminNavItem key={link.to} {...link} onNavigate={onNavigate} />
        ))}
      </nav>
    </aside>
  );
}
