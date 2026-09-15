import { Link } from "react-router-dom";
import { screenshotUsageLabel, screenshotUsagePercent, type ScreenshotUsage } from "../../services/screenshots";

export function ScreenshotUsageBar({ usage }: { usage: ScreenshotUsage | null }) {
  if (!usage) return null;
  const pct = screenshotUsagePercent(usage);
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Cloud screenshots</h2>
        <span className="badge">{screenshotUsageLabel(usage)}</span>
      </div>
      <div className="meter" aria-label="Screenshot usage">
        <span style={{ width: `${pct}%` }} />
      </div>
    </section>
  );
}

export function ScreenshotDowngradeBanner({ usage }: { usage: ScreenshotUsage | null }) {
  if (!usage?.trimAfter) return null;
  const when = formatTrimDate(usage.trimAfter);
  return (
    <section className="panel" role="status">
      <div className="panel-head">
        <h2>Screenshot limit</h2>
      </div>
      <p>
        You have more cloud screenshots than Free allows. Oldest images will be removed
        {when ? ` after ${when}` : " soon"}.{" "}
        <Link to="/settings?section=account">Upgrade to keep them</Link>.
      </p>
    </section>
  );
}

function formatTrimDate(value: string): string | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
