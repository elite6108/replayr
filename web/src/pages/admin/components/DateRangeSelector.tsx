const PRESETS = [
  { id: "last_7", label: "Last 7 days" },
  { id: "last_14", label: "Last 14 days" },
  { id: "last_30", label: "Last 30 days" },
  { id: "last_90", label: "Last 90 days" },
];

export function DateRangeSelector({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <label className="admin-range">
      <select value={value} onChange={(event) => onChange(event.target.value)} aria-label="Activity date range">
        {PRESETS.map((preset) => (
          <option key={preset.id} value={preset.id}>
            {preset.label}
          </option>
        ))}
      </select>
    </label>
  );
}
