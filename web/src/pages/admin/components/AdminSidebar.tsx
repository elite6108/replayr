import { useStaffPermissions } from "../../../lib/staff";
import { analyticsSidebarItems } from "../analytics/analyticsNav";
import { AdminNavItem } from "./AdminNavItem";
import {
  IconAnnouncements,
  IconAudit,
  IconBilling,
  IconBoard,
  IconBusiness,
  IconChart,
  IconClips,
  IconCloud,
  IconCreators,
  IconErrors,
  IconGrowth,
  IconHealth,
  IconOverview,
  IconProduct,
  IconReports,
  IconSettings,
  IconShield,
  IconTasks,
  IconUsers,
  IconWaitlist,
} from "./adminIcons";

const mainLinks = [
  { to: "/admin", label: "Overview", end: true, permission: "admin.access", icon: IconOverview },
  { to: "/admin/billing", label: "Billing", permission: "users.billing.edit", icon: IconBilling },
  { to: "/admin/clips", label: "Clips", permission: "clips.view", icon: IconClips },
  { to: "/admin/storage", label: "Storage", permission: "users.quota.edit", icon: IconCloud },
  { to: "/admin/creators", label: "Creators", permission: "creators.view", icon: IconCreators },
  { to: "/admin/announcements", label: "Announcements", permission: "announcements.view", icon: IconAnnouncements },
  { to: "/admin/errors", label: "Errors", permission: "errors.view", icon: IconErrors },
];

const peopleLinks = [
  { to: "/admin/users", label: "Users", permission: "users.view", icon: IconUsers },
  { to: "/admin/waitlist", label: "Waitlist", permission: "waitlist.view", icon: IconWaitlist },
];

const staffLinks = [
  { to: "/staff/board", label: "Work Board", permission: "staff.access", icon: IconBoard },
  { to: "/staff/tasks", label: "My Tasks", permission: "staff.access", icon: IconTasks },
  { to: "/admin/staff", label: "Staff", permission: "staff.members.view", icon: IconUsers },
  { to: "/admin/roles", label: "Roles & Permissions", permission: "staff.roles.view", icon: IconShield },
  { to: "/admin/audit", label: "Audit Log", permission: "audit.view", icon: IconAudit },
];

const analyticsIcons = {
  overview: IconChart,
  growth: IconGrowth,
  product: IconProduct,
  business: IconBusiness,
  health: IconHealth,
  reports: IconReports,
};

export function AdminSidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { can } = useStaffPermissions();
  const main = mainLinks.filter((link) => can(link.permission));
  const people = peopleLinks.filter((link) => can(link.permission));
  const staff = staffLinks.filter((link) => can(link.permission));
  const analytics = can("analytics.view") ? analyticsSidebarItems : [];

  return (
    <aside className="admin-rail">
      <div className="admin-rail-head">
        <p className="admin-kicker">Operator</p>
        <h1>Admin</h1>
        <p className="admin-rail-copy">Manage the platform, your team, and keep Replayr running smoothly.</p>
      </div>
      <nav className="admin-nav" aria-label="Admin">
        {main.length ? (
          <div className="admin-nav-section">
            <p className="admin-nav-group">Main</p>
            {main.map((link) => (
              <AdminNavItem key={link.to} {...link} onNavigate={onNavigate} />
            ))}
          </div>
        ) : null}
        {people.length ? (
          <div className="admin-nav-section">
            <p className="admin-nav-group">People</p>
            {people.map((link) => (
              <AdminNavItem key={link.to} {...link} onNavigate={onNavigate} />
            ))}
          </div>
        ) : null}
        {staff.length ? (
          <div className="admin-nav-section">
            <p className="admin-nav-group">Staff</p>
            {staff.map((link) => (
              <AdminNavItem key={link.to} {...link} onNavigate={onNavigate} />
            ))}
          </div>
        ) : null}
        {analytics.length ? (
          <div className="admin-nav-section">
            <p className="admin-nav-group">Analytics</p>
            {analytics.map((link) => (
              <AdminNavItem
                key={link.to}
                to={link.to}
                label={link.label}
                end={link.end}
                icon={analyticsIcons[link.id as keyof typeof analyticsIcons] ?? IconChart}
                onNavigate={onNavigate}
              />
            ))}
          </div>
        ) : null}
      </nav>
      <div className="admin-rail-foot">
        <AdminNavItem to="/account" label="Settings" icon={IconSettings} onNavigate={onNavigate} />
      </div>
    </aside>
  );
}
