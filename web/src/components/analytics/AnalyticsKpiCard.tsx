import type { AnalyticsKpi } from "../../lib/adminAnalytics";
import { formatBytes } from "../../lib/format";
import { AnalyticsMetricBadge } from "./AnalyticsMetricBadge";

function formatValue(kpi: AnalyticsKpi) {
  if (kpi.value == null) return "—";
  if (kpi.unit === "bytes") return formatBytes(kpi.value);
  if (kpi.unit === "cents") return `$${(kpi.value / 100).toFixed(2)}`;
  if (kpi.unit === "percent") return `${Math.round(kpi.value * 1000) / 10}%`;
  if (kpi.unit === "duration_ms") {
    const totalSeconds = Math.round(kpi.value / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return minutes > 0 ? `${minutes}m ${seconds.toString().padStart(2, "0")}s` : `${seconds}s`;
  }
  return kpi.value.toLocaleString();
}

function formatDelta(kpi: AnalyticsKpi) {
  if (kpi.percentageChange === "new") return "New";
  if (kpi.percentageChange == null || kpi.previous == null) return "—";
  const pct = Math.round(kpi.percentageChange * 1000) / 10;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct}%`;
}

export function AnalyticsKpiCard({ kpi, loading }: { kpi: AnalyticsKpi; loading?: boolean }) {
  const delta = formatDelta(kpi);
  const up = typeof kpi.percentageChange === "number" && kpi.percentageChange > 0;
  const down = typeof kpi.percentageChange === "number" && kpi.percentageChange < 0;
  return (
    <article className={`analytics-kpi${loading ? " is-loading" : ""}`} title={kpi.tooltip}>
      <div className="analytics-kpi-label">
        <span>{kpi.label}</span>
        <AnalyticsMetricBadge kind={kpi.badge} tooltip={kpi.tooltip} />
      </div>
      <strong>{loading ? " " : formatValue(kpi)}</strong>
      <p className={`analytics-kpi-delta${up ? " up" : ""}${down ? " down" : ""}`}>
        {loading ? " " : `vs previous ${delta}`}
        {kpi.asOf && !loading ? <span className="muted"> · as of {kpi.asOf}</span> : null}
      </p>
    </article>
  );
}
