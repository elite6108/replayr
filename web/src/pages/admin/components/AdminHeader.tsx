import { DateRangeSelector } from "./DateRangeSelector";

export function AdminHeader({
  updatedAt,
  range,
  onRangeChange,
}: {
  updatedAt: Date | null;
  range: string;
  onRangeChange: (value: string) => void;
}) {
  const clock = new Date();
  return (
    <header className="admin-dash-header">
      <div>
        <p className="admin-live">
          <i /> Live
        </p>
        <h2>What is on Replayr right now</h2>
        <p className="muted">Counts come from Auth and Postgres. Active users use last sign-in, not invented DAU.</p>
      </div>
      <div className="admin-dash-meta">
        <p className="admin-clock">
          {clock.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" })}
          {" · "}
          {clock.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
        </p>
        {updatedAt ? <p className="muted">Updated {formatUpdated(updatedAt)}</p> : <p className="muted">Loading live counts…</p>}
        <DateRangeSelector value={range} onChange={onRangeChange} />
      </div>
    </header>
  );
}

function formatUpdated(date: Date): string {
  const minutes = Math.max(0, Math.round((Date.now() - date.getTime()) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes === 1) return "1 minute ago";
  return `${minutes} minutes ago`;
}
