import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Seo } from "../components/Seo";
import {
  deleteUserScreenshot,
  fetchScreenshotUsage,
  fetchUserScreenshots,
  type CloudScreenshot,
  type ScreenshotUsage,
} from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatBytes, formatClipDate } from "../lib/format";
import { screenshotImageUrl, screenshotShareUrl } from "../lib/supabase";
import { LibraryFolderTabs } from "./FoldersPage";

function usageLabel(usage: ScreenshotUsage): string {
  if (usage.countLimit != null) return `${usage.count} / ${usage.countLimit} images`;
  if (usage.bytesLimit != null) return `${formatBytes(usage.bytes)} / ${formatBytes(usage.bytesLimit)}`;
  return `${usage.count} images`;
}

function usagePercent(usage: ScreenshotUsage): number {
  if (usage.countLimit != null && usage.countLimit > 0) {
    return Math.min(100, (usage.count / usage.countLimit) * 100);
  }
  if (usage.bytesLimit != null && usage.bytesLimit > 0) {
    return Math.min(100, (usage.bytes / usage.bytesLimit) * 100);
  }
  return 0;
}

export function LibraryScreenshotsPage() {
  const { session } = useAuth();
  const token = session?.access_token;
  const [shots, setShots] = useState<CloudScreenshot[]>([]);
  const [usage, setUsage] = useState<ScreenshotUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const [list, nextUsage] = await Promise.all([fetchUserScreenshots(token), fetchScreenshotUsage(token)]);
        if (cancelled) return;
        setShots(list.screenshots);
        setUsage(nextUsage);
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load screenshots.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function copyLink(shot: CloudScreenshot) {
    const url = shot.shareUrl || screenshotShareUrl(shot.slug);
    try {
      await navigator.clipboard.writeText(url);
      setNotice("Link copied");
    } catch {
      setError("Could not copy that link.");
    }
  }

  async function remove(shot: CloudScreenshot) {
    if (!token) return;
    if (!window.confirm("Delete this cloud screenshot? The share link will stop working.")) return;
    try {
      await deleteUserScreenshot(shot.id, token);
      setShots((current) => current.filter((item) => item.id !== shot.id));
      setNotice("Screenshot deleted");
      setUsage(await fetchScreenshotUsage(token).catch(() => usage));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not delete that screenshot.");
    }
  }

  const trimWhen = usage?.trimAfter ? new Date(usage.trimAfter) : null;
  const trimLabel =
    trimWhen && !Number.isNaN(trimWhen.getTime())
      ? trimWhen.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
      : null;

  return (
    <main className="page library-page">
      <Seo title="Screenshots — Replayr" description="Cloud screenshots captured from the Windows app." robots="noindex" />
      <LibraryFolderTabs />
      <div className="library-head">
        <div>
          <p className="eyebrow">Your uploads</p>
          <h1>Screenshots</h1>
          <p className="muted">Captured on Windows. Oldest Free images rotate out as you take new ones.</p>
        </div>
        {usage ? (
          <div className="quota bubble">
            <div className="quota-bar" aria-hidden="true">
              <span style={{ width: `${usagePercent(usage)}%` }} />
            </div>
            <p className="muted">{usageLabel(usage)}</p>
          </div>
        ) : null}
      </div>
      {usage?.trimAfter ? (
        <p className="error" role="status">
          You have more cloud screenshots than Free allows. Oldest images will be removed
          {trimLabel ? ` after ${trimLabel}` : " soon"}. <Link to="/pricing">Upgrade to keep them</Link>.
        </p>
      ) : null}
      {error ? <p className="error">{error}</p> : null}
      {notice ? <p className="ok">{notice}</p> : null}
      {loading ? (
        <p className="muted">Loading screenshots…</p>
      ) : shots.length === 0 ? (
        <div className="empty-bubble">
          <h2>No cloud screenshots yet</h2>
          <p className="muted">Take a region screenshot in the Windows app while signed in.</p>
        </div>
      ) : (
        <div className="clip-grid">
          {shots.map((shot) => (
            <article key={shot.id} className="clip-card">
              <a href={shot.shareUrl || screenshotShareUrl(shot.slug)}>
                {shot.status === "ready" ? (
                  <img src={screenshotImageUrl(shot.slug)} alt="" width={shot.width} height={shot.height} />
                ) : (
                  <span className="muted">{shot.status}</span>
                )}
              </a>
              <strong>
                {shot.width}×{shot.height}
              </strong>
              <span className="muted">{formatClipDate(shot.createdAt)}</span>
              <div className="clip-card-actions">
                <button type="button" className="btn" onClick={() => void copyLink(shot)} disabled={shot.status !== "ready"}>
                  Copy link
                </button>
                <button type="button" className="btn danger" onClick={() => void remove(shot)}>
                  Delete
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </main>
  );
}
