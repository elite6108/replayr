import { useAnalyticsQuery } from "../../pages/admin/analytics/useAnalyticsQuery";

export function AnalyticsDateRangePicker() {
  const query = useAnalyticsQuery();
  return (
    <div className="analytics-toolbar-block">
      <label>
        Range
        <select value={query.range} onChange={(event) => query.setRange(event.target.value)}>
          {query.presets.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.label}
            </option>
          ))}
        </select>
      </label>
      {query.range === "custom" ? (
        <div className="analytics-custom-dates">
          <label>
            Start
            <input type="date" value={query.from} onChange={(event) => query.setCustom(event.target.value, query.to || event.target.value)} />
          </label>
          <label>
            End
            <input type="date" value={query.to} onChange={(event) => query.setCustom(query.from || event.target.value, event.target.value)} />
          </label>
        </div>
      ) : null}
    </div>
  );
}
