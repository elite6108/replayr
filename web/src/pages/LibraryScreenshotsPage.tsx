import { useEffect, useRef, useState } from "react";
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

const PAGE_SIZE = 24;

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
  const [total, setTotal] = useState(0);
  const [usage, setUsage] = useState<ScreenshotUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadingMoreRef = useRef(false);
  const shotsLengthRef = useRef(0);
  const totalRef = useRef(0);

  shotsLengthRef.current = shots.length;
  totalRef.current = total;

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setLoading(true);
    setShots([]);
    setTotal(0);
    void (async () => {
      try {
        const [list, nextUsage] = await Promise.all([
          fetchUserScreenshots(token, 1, PAGE_SIZE),
          fetchScreenshotUsage(token),
        ]);
        if (cancelled) return;
        setShots(list.screenshots);
        setTotal(list.total);
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

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || loading || !token) return;

    async function loadMore() {
      if (!token || loadingMoreRef.current) return;
      if (shotsLengthRef.current >= totalRef.current) return;
      const nextPage = Math.floor(shotsLengthRef.current / PAGE_SIZE) + 1;
      loadingMoreRef.current = true;
      setLoadingMore(true);
      try {
        const list = await fetchUserScreenshots(token, nextPage, PAGE_SIZE);
        setTotal(list.total);
        setShots((current) => {
          const seen = new Set(current.map((shot) => shot.id));
          return [...current, ...list.screenshots.filter((shot) => !seen.has(shot.id))];
        });
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not load more screenshots.");
      } finally {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadMore();
      },
      { rootMargin: "240px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [loading, shots.length, total, token]);

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
      setTotal((current) => Math.max(0, current - 1));
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
        <>
          <ul className="clip-grid">
            {shots.map((shot) => (
              <li key={shot.id}>
                <article className="web-clip-card">
                  <a className="clip-open" href={shot.shareUrl || screenshotShareUrl(shot.slug)}>
                    <div className="clip-thumb">
                      {shot.status === "ready" ? (
                        <img
                          src={screenshotImageUrl(shot.slug)}
                          alt={`${shot.width}×${shot.height}`}
                          loading="lazy"
                          decoding="async"
                        />
                      ) : (
                        <span className="muted">{shot.status}</span>
                      )}
                    </div>
                  </a>
                  <div className="clip-meta">
                    <span className="clip-title">
                      {shot.width}×{shot.height}
                    </span>
                    <div className="clip-date">{formatClipDate(shot.createdAt)}</div>
                  </div>
                  <div className="clip-card-actions">
                    <button type="button" className="btn" onClick={() => void copyLink(shot)} disabled={shot.status !== "ready"}>
                      Copy link
                    </button>
                    <button type="button" className="btn danger" onClick={() => void remove(shot)}>
                      Delete
                    </button>
                  </div>
                </article>
              </li>
            ))}
          </ul>
          {shots.length < total ? <div ref={sentinelRef} className="library-sentinel" aria-hidden="true" /> : null}
          {loadingMore ? <p className="muted">Loading more…</p> : null}
        </>
      )}
    </main>
  );
}
