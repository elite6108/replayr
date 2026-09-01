import { useEffect, useState } from "react";
import type { GameplayVisualFilter, RecordingOverlaySettings } from "../../types/settings";

function formatClock(now: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

export function PreviewOverlayLayer({
  filter,
  overlays,
}: {
  filter: GameplayVisualFilter;
  overlays: RecordingOverlaySettings;
}) {
  const [now, setNow] = useState(() => new Date());
  const showClock = overlays.timestamp;
  const showRec = overlays.recIndicator;

  useEffect(() => {
    if (!showClock) return;
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, [showClock]);

  if (!showClock && !showRec) return null;

  return (
    <div className={`preview-overlays overlay-${filter}`} aria-hidden="true">
      {showRec ? (
        <span className="preview-rec">
          <i />
          REC
        </span>
      ) : null}
      {showClock ? <div className="preview-timestamp">{formatClock(now)}</div> : null}
    </div>
  );
}
