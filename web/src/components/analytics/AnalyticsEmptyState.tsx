export function AnalyticsEmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="analytics-empty">
      <strong>{title}</strong>
      <p className="muted">{body}</p>
    </div>
  );
}
