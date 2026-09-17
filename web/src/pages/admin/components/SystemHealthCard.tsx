export type HealthRow = { label: string; status: "operational" | "unknown" | "unmonitored" };

export function SystemHealthCard({ rows, loading, error }: { rows: HealthRow[]; loading: boolean; error: string | null }) {
  return (
    <section className="admin-panel">
      <header className="admin-panel-head">
        <h3>System Health</h3>
      </header>
      {error ? <p className="error">{error}</p> : null}
      {loading ? <p className="muted">Checking services…</p> : null}
      <ul className="admin-health-list">
        {rows.map((row) => (
          <li key={row.label}>
            <i className={`admin-health-dot is-${row.status}`} />
            <span>{row.label}</span>
            <strong>
              {row.status === "operational" ? "Operational" : row.status === "unknown" ? "Unknown" : "Not monitored"}
            </strong>
          </li>
        ))}
      </ul>
    </section>
  );
}
