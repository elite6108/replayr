import type { ReactNode } from "react";

export function StatCard({
  title,
  value,
  body,
  action,
  live,
}: {
  title: string;
  value: ReactNode;
  body?: ReactNode;
  action?: ReactNode;
  live?: boolean;
}) {
  return (
    <section className={`stat-card${live ? " live" : ""}`}>
      <div className="panel-head">
        <h2>{title}</h2>
        {live ? <span className="badge live">Live</span> : null}
      </div>
      <div className="stat-value">{value}</div>
      {body ? <p className="muted">{body}</p> : null}
      {action}
    </section>
  );
}
