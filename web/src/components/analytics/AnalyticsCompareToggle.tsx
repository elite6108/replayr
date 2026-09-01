import { useAnalyticsQuery } from "../../pages/admin/analytics/useAnalyticsQuery";

export function AnalyticsCompareToggle() {
  const query = useAnalyticsQuery();
  return (
    <label className="analytics-toggle">
      <input type="checkbox" checked={query.compare} onChange={(event) => query.setCompare(event.target.checked)} />
      Compare to previous period
    </label>
  );
}
