import type { ComponentType, SVGProps } from "react";
import { NavLink, useLocation } from "react-router-dom";

type Icon = ComponentType<SVGProps<SVGSVGElement>>;

export function AdminNavItem({
  to,
  label,
  icon: Glyph,
  end,
  badge,
  activePrefix,
  onNavigate,
}: {
  to: string;
  label: string;
  icon: Icon;
  end?: boolean;
  badge?: number | null;
  activePrefix?: string | string[];
  onNavigate?: () => void;
}) {
  const location = useLocation();
  const prefixes = activePrefix == null ? [] : Array.isArray(activePrefix) ? activePrefix : [activePrefix];
  const prefixActive = prefixes.some((prefix) => location.pathname === prefix || location.pathname.startsWith(`${prefix}/`));
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) => `admin-nav-item${isActive || prefixActive ? " is-active" : ""}`}
      onClick={onNavigate}
    >
      <Glyph />
      <span>{label}</span>
      {badge != null && badge > 0 ? <em>{badge > 99 ? "99+" : badge}</em> : null}
    </NavLink>
  );
}
