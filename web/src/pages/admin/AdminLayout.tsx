import { NavLink, Outlet } from "react-router-dom";
import { Seo } from "../../components/Seo";

const links = [
  { to: "/admin", label: "Overview", end: true },
  { to: "/admin/users", label: "Users" },
  { to: "/admin/billing", label: "Billing" },
  { to: "/admin/clips", label: "Clips" },
  { to: "/admin/storage", label: "Storage" },
  { to: "/admin/creators", label: "Creators" },
  { to: "/admin/announcements", label: "Announcements" },
  { to: "/admin/errors", label: "Errors" },
];

export function AdminLayout() {
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
            {links.map((link) => (
              <NavLink key={link.to} to={link.to} end={link.end}>
                {link.label}
              </NavLink>
            ))}
          </nav>
        </aside>
        <div className="admin-main">
          <Outlet />
        </div>
      </div>
    </main>
  );
}
