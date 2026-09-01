type Props = { kind?: "proxy" | "estimate" | "incomplete" | null; tooltip?: string };

const LABELS = { proxy: "Proxy", estimate: "Estimate", incomplete: "Incomplete" };

export function AnalyticsMetricBadge({ kind, tooltip }: Props) {
  if (!kind) return null;
  return (
    <span className={`analytics-badge analytics-badge-${kind}`} title={tooltip}>
      {LABELS[kind]}
    </span>
  );
}
