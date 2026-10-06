import { NavLink, Outlet, useLocation } from "react-router-dom";

export type AdminSectionTab = {
  id: string;
  label: string;
  path: string;
  end?: boolean;
};

export function AdminSectionShell({ label, tabs }: { label: string; tabs: AdminSectionTab[] }) {
  const location = useLocation();
  return (
    <div className="admin-section-shell">
      {tabs.length > 1 ? (
        <nav className="analytics-section-tabs" aria-label={label}>
          {tabs.map((tab) => (
            <NavLink key={tab.id} to={`${tab.path}${location.search}${location.hash}`} end={tab.end}>
              {tab.label}
            </NavLink>
          ))}
        </nav>
      ) : null}
      <Outlet />
    </div>
  );
}
