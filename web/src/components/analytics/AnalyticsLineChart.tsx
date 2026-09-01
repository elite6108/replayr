import { useMemo, useState } from "react";
import type { AnalyticsSeries } from "../../lib/adminAnalytics";

type Series = { key: string; label: string; color: string; data: AnalyticsSeries };

export function AnalyticsLineChart({
  title,
  subtitle,
  series,
}: {
  title: string;
  subtitle?: string;
  series: Series[];
}) {
  const [hover, setHover] = useState<{ index: number; x: number; y: number } | null>(null);
  const width = 720;
  const height = 240;
  const pad = { l: 36, r: 12, t: 16, b: 28 };
  const labels = series[0]?.data.labels ?? [];
  const points = useMemo(() => {
    const values = series.flatMap((item) => item.data.values.filter((value): value is number => value != null));
    const max = Math.max(1, ...values);
    return series.map((item) => ({
      ...item,
      path: item.data.values
        .map((value, index) => {
          if (value == null) return null;
          const x = pad.l + (labels.length <= 1 ? 0 : (index / (labels.length - 1)) * (width - pad.l - pad.r));
          const y = pad.t + (1 - value / max) * (height - pad.t - pad.b);
          return { x, y, value };
        }),
    }));
  }, [series, labels.length]);

  return (
    <section className="analytics-chart">
      <header>
        <h3>{title}</h3>
        {subtitle ? <p className="muted">{subtitle}</p> : null}
      </header>
      {labels.length === 0 ? (
        <p className="muted">No chart data in this range.</p>
      ) : (
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title} onMouseLeave={() => setHover(null)}>
          {[0.25, 0.5, 0.75].map((tick) => (
            <line
              key={tick}
              x1={pad.l}
              x2={width - pad.r}
              y1={pad.t + tick * (height - pad.t - pad.b)}
              y2={pad.t + tick * (height - pad.t - pad.b)}
              className="analytics-grid"
            />
          ))}
          {points.map((item) => {
            const segs: string[] = [];
            item.path.forEach((point) => {
              if (!point) {
                segs.push("");
                return;
              }
              const last = segs[segs.length - 1];
              segs[segs.length - 1] = last ? `${last} L ${point.x} ${point.y}` : `M ${point.x} ${point.y}`;
            });
            return <path key={item.key} d={segs.filter(Boolean).join(" ")} fill="none" stroke={item.color} strokeWidth="2" />;
          })}
          {labels.map((label, index) => {
            const x = pad.l + (labels.length <= 1 ? 0 : (index / (labels.length - 1)) * (width - pad.l - pad.r));
            return (
              <rect
                key={label}
                x={x - 8}
                y={pad.t}
                width="16"
                height={height - pad.t - pad.b}
                fill="transparent"
                onMouseEnter={(event) => setHover({ index, x, y: event.clientY })}
              />
            );
          })}
          {hover ? (
            <g>
              <line x1={hover.x} x2={hover.x} y1={pad.t} y2={height - pad.b} className="analytics-hover-line" />
            </g>
          ) : null}
        </svg>
      )}
      {hover ? (
        <div className="analytics-tooltip">
          <strong>{labels[hover.index]}</strong>
          {series.map((item) => (
            <div key={item.key}>
              {item.label}: {item.data.values[hover.index] == null ? "—" : item.data.values[hover.index]?.toLocaleString()}
            </div>
          ))}
        </div>
      ) : null}
      <ul className="analytics-legend">
        {series.map((item) => (
          <li key={item.key}>
            <i style={{ background: item.color }} />
            {item.label}
          </li>
        ))}
      </ul>
    </section>
  );
}
