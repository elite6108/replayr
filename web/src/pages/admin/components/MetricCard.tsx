import { Link } from "react-router-dom";
import type { ComponentType, SVGProps } from "react";

export function MetricCard({
  to,
  label,
  value,
  icon: Glyph,
}: {
  to: string;
  label: string;
  value: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
}) {
  return (
    <Link className="admin-metric" to={to}>
      <span className="admin-metric-icon">
        <Glyph />
      </span>
      <span className="admin-metric-label">{label}</span>
      <strong>{value}</strong>
    </Link>
  );
}
