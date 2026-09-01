import { useAnalyticsQuery } from "../../pages/admin/analytics/useAnalyticsQuery";

export function AnalyticsGranularityControl() {
  const query = useAnalyticsQuery();
  return (
    <label>
      Chart
      <select value={query.granularity} onChange={(event) => query.setGranularity(event.target.value)}>
        <option value="">Auto</option>
        <option value="day">Day</option>
        <option value="week">Week</option>
        <option value="month">Month</option>
      </select>
    </label>
  );
}
