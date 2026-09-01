import { NavLink, Navigate, Outlet, useLocation } from "react-router-dom";
import { analyticsSectionById, type AnalyticsSection } from "./analyticsNav";

export function AnalyticsSectionShell({ sectionId }: { sectionId: AnalyticsSection["id"] }) {
  const section = analyticsSectionById(sectionId);
  const location = useLocation();
  return (
    <div className="analytics-section">
      <header className="analytics-section-header">
        <p className="eyebrow">Analytics</p>
        <h2>{section.label}</h2>
        <p className="muted">{section.description}</p>
        <nav className="analytics-section-tabs" aria-label={`${section.label} sections`}>
          {section.tabs.map((tab) => (
            <NavLink
              key={tab.id}
              to={`${tab.path}${location.search}`}
              end={tab.end}
            >
              {tab.label}
            </NavLink>
          ))}
        </nav>
      </header>
      <Outlet />
    </div>
  );
}

/** Preserve query/hash when moving a bookmarked admin analytics URL. */
export function AnalyticsRedirect({ to }: { to: string }) {
  const location = useLocation();
  return <Navigate to={`${to}${location.search}${location.hash}`} replace />;
}
