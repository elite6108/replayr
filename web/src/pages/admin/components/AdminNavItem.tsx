import type { ComponentType, SVGProps } from "react";
import { NavLink } from "react-router-dom";

type Icon = ComponentType<SVGProps<SVGSVGElement>>;

export function AdminNavItem({
  to,
  label,
  icon: Glyph,
  end,
  badge,
  onNavigate,
}: {
  to: string;
  label: string;
  icon: Icon;
  end?: boolean;
  badge?: number | null;
  onNavigate?: () => void;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) => `admin-nav-item${isActive ? " is-active" : ""}`}
      onClick={onNavigate}
    >
      <Glyph />
      <span>{label}</span>
      {badge != null && badge > 0 ? <em>{badge > 99 ? "99+" : badge}</em> : null}
    </NavLink>
  );
}
