import { useEffect, useMemo, useState } from "react";
import { useLibraryStore } from "../../stores/libraryStore";
import type { UploadQueueItem } from "../../types/upload";
import { formatBytes } from "../../utils/format";

function formatEta(seconds: number | null): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 60) return `~${Math.max(1, Math.round(seconds))}s left`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `~${minutes}m left`;
  return `~${Math.round(minutes / 60)}h left`;
}

function etaSeconds(item: UploadQueueItem, now: number): number | null {
  if (item.phase !== "uploading" || item.startedAt == null) return null;
  if (item.bytesUploaded <= 0 || item.bytesTotal <= item.bytesUploaded) return null;
  const elapsed = (now - item.startedAt) / 1000;
  if (elapsed < 1) return null;
  const rate = item.bytesUploaded / elapsed;
  if (rate <= 0) return null;
  return (item.bytesTotal - item.bytesUploaded) / rate;
}

function phaseLabel(item: UploadQueueItem, now: number, waitingIndex: number): string {
  if (item.phase === "queued") {
    return waitingIndex >= 0 ? `#${waitingIndex + 2} in queue` : "Waiting";
  }
  if (item.phase === "preparing") return "Preparing…";
  if (item.phase === "processing") return "Finishing…";
  return formatEta(etaSeconds(item, now)) || "Uploading…";
}

function progressPct(item: UploadQueueItem): number {
  if (item.phase === "processing") return 100;
  if (item.bytesTotal <= 0) return item.phase === "uploading" ? 4 : 0;
  return Math.min(100, Math.round((item.bytesUploaded / item.bytesTotal) * 100));
}

export function UploadQueuePanel() {
  const queue = useLibraryStore((state) => state.uploadQueue);
  const activeUploadId = useLibraryStore((state) => state.activeUploadId);
  const dequeueUpload = useLibraryStore((state) => state.dequeueUpload);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const active = useMemo(
    () => queue.find((item) => item.localId === activeUploadId) ?? queue[0] ?? null,
    [queue, activeUploadId],
  );
  const waiting = useMemo(
    () => queue.filter((item) => item.localId !== active?.localId),
    [queue, active],
  );

  useEffect(() => {
    if (!queue.some((item) => item.phase === "uploading" && item.startedAt)) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [queue]);

  useEffect(() => {
    if (queue.length === 0) setOpen(false);
  }, [queue.length]);

  if (!active || queue.length === 0) return null;

  const total = queue.length;
  const eta = phaseLabel(active, now, -1);
  const collapsed = `Uploading ${active.title} · 1 of ${total} · ${eta}`;

  return (
    <div className="upload-queue">
      <button
        type="button"
        className="upload-queue-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="upload-queue-summary">{collapsed}</span>
        <span className="upload-queue-bar" aria-hidden="true">
          <span className="upload-queue-bar-fill" style={{ width: `${progressPct(active)}%` }} />
        </span>
      </button>
      {open ? (
        <div className="upload-queue-list" role="list">
          <div className="upload-queue-row" role="listitem">
            <div className="upload-queue-copy">
              <strong>{active.title}</strong>
              <small>
                {phaseLabel(active, now, -1)}
                {active.phase === "uploading" && active.bytesTotal > 0
                  ? ` · ${formatBytes(active.bytesUploaded)} / ${formatBytes(active.bytesTotal)}`
                  : null}
              </small>
            </div>
            <span className="upload-queue-bar" aria-hidden="true">
              <span className="upload-queue-bar-fill" style={{ width: `${progressPct(active)}%` }} />
            </span>
          </div>
          {waiting.map((item, index) => (
            <div key={item.localId} className="upload-queue-row" role="listitem">
              <div className="upload-queue-copy">
                <strong>{item.title}</strong>
                <small>{phaseLabel(item, now, index)}</small>
              </div>
              <button type="button" className="btn sm" onClick={() => dequeueUpload(item.localId)}>
                Remove
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
