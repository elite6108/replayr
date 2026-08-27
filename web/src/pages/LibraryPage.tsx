import { FormEvent, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Seo } from "../components/Seo";
import { ClipThumb } from "../components/ClipThumb";
import { PlayerVideo } from "../components/ReplayrWatermark";
import { deleteCloudClip, downloadCloudClip, fetchLibrary, fetchPlayback, type ManagedClip, type PlaybackClip } from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatBytes, formatClipDate, formatDurationMs } from "../lib/format";
import { clipShareUrl, getSupabase } from "../lib/supabase";
import { fetchBillingStatus } from "../lib/billing";

const PAGE_SIZE = 24;

interface Quota {
  storage_used_bytes: number;
  storage_limit_bytes: number;
}

export function LibraryPage() {
  const { session } = useAuth();
  const userId = session?.user.id ?? "";
  const token = session?.access_token;
  const [clips, setClips] = useState<ManagedClip[]>([]);
  const [total, setTotal] = useState(0);
  const [quota, setQuota] = useState<Quota | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [playing, setPlaying] = useState<PlaybackClip | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<{
    message: string;
    progress: number;
  } | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [playBusy, setPlayBusy] = useState(false);
  const [premium, setPremium] = useState(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<HTMLElement | null>(null);
  const loadingMoreRef = useRef(false);
  const clipsLengthRef = useRef(0);
  const totalRef = useRef(0);

  clipsLengthRef.current = clips.length;
  totalRef.current = total;

  useEffect(() => {
    if (!token) {
      setPremium(false);
      return;
    }
    let cancelled = false;
    void fetchBillingStatus(token)
      .then((status) => {
        if (!cancelled) setPremium(Boolean(status.premium));
      })
      .catch(() => {
        if (!cancelled) setPremium(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    if (!userId || !token) return;
    let cancelled = false;
    setLoading(true);
    setClips([]);
    setTotal(0);
    void (async () => {
      try {
        const [library, quotaResult] = await Promise.all([
          fetchLibrary(token, { page: 1, limit: PAGE_SIZE }),
          getSupabase().from("user_storage").select("storage_used_bytes, storage_limit_bytes").eq("user_id", userId).maybeSingle(),
        ]);
        if (cancelled) return;
        setClips(library.clips);
        setTotal(library.total);
        if (!quotaResult.error && quotaResult.data) setQuota(quotaResult.data as Quota);
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load cloud clips.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, token]);

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || loading || !token) return;

    async function loadMore() {
      if (!token || loadingMoreRef.current) return;
      if (clipsLengthRef.current >= totalRef.current) return;
      const nextPage = Math.floor(clipsLengthRef.current / PAGE_SIZE) + 1;
      loadingMoreRef.current = true;
      setLoadingMore(true);
      try {
        const library = await fetchLibrary(token, { page: nextPage, limit: PAGE_SIZE });
        setTotal(library.total);
        setClips((current) => {
          const seen = new Set(current.map((clip) => clip.id));
          return [...current, ...library.clips.filter((clip) => !seen.has(clip.id))];
        });
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not load more clips.");
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
  }, [loading, clips.length, total, token]);

  async function setVisibility(clip: ManagedClip, visibility: ManagedClip["visibility"]) {
    setNotice(null);
    setError(null);
    const { error: next } = await getSupabase().from("clips").update({ visibility }).eq("id", clip.id).eq("user_id", userId);
    if (next) {
      setError(next.message);
      return;
    }
    setClips((current) => current.map((item) => (item.id === clip.id ? { ...item, visibility } : item)));
    if (playing && activeId === clip.id) {
      setPlaying({ ...playing, visibility });
    }
    setNotice(
      visibility === "private"
        ? "Private — only you can watch"
        : visibility === "unlisted"
          ? "Unlisted — anyone with the link can watch"
          : "Public — listed for everyone",
    );
  }

  async function saveTitle(clip: ManagedClip) {
    const title = draftTitle.trim();
    if (!title) {
      setError("Clip name cannot be empty.");
      return;
    }
    setNotice(null);
    const { error: next } = await getSupabase().from("clips").update({ title }).eq("id", clip.id).eq("user_id", userId);
    if (next) {
      setError(next.message);
      return;
    }
    setEditingId(null);
    setClips((current) => current.map((item) => (item.id === clip.id ? { ...item, title } : item)));
    if (playing?.slug === clip.slug) setPlaying({ ...playing, title });
    setNotice("Clip renamed");
  }

  async function download(clip: ManagedClip) {
    if (!token || clip.status !== "ready") return;
    setBusy(true);
    setError(null);
    setDownloadProgress({
      message: "Download will begin within about 30 seconds…",
      progress: 0.12,
    });
    try {
      await downloadCloudClip(clip.slug, clip.title, token, (update) => {
        setDownloadProgress({ message: update.message, progress: update.progress });
      });
      setNotice("Download started");
      setDownloadProgress(null);
    } catch (caught) {
      setDownloadProgress(null);
      setError(caught instanceof Error ? caught.message : "Could not download that clip.");
    } finally {
      setBusy(false);
    }
  }

  async function copyLink(clip: ManagedClip) {
    if (clip.visibility === "private") {
      setNotice("Private clips have no share link. Set Unlisted or Public first.");
      return;
    }
    try {
      await navigator.clipboard.writeText(clipShareUrl(clip.slug));
      setNotice(clip.visibility === "public" ? "Public link copied" : "Unlisted link copied");
    } catch {
      setNotice(clipShareUrl(clip.slug));
    }
  }

  async function play(clip: ManagedClip) {
    if (clip.status !== "ready" || !token) return;
    setError(null);
    setActiveId(clip.id);
    setPlayBusy(true);
    try {
      const next = await fetchPlayback(clip.slug, token);
      setPlaying({ ...next, thumbnailUrl: next.thumbnailUrl || clip.thumbnailUrl });
      queueMicrotask(() => playerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    } catch (caught) {
      setPlaying(null);
      setError(caught instanceof Error ? caught.message : "Could not play this clip.");
    } finally {
      setPlayBusy(false);
    }
  }

  function toggleSelect(clipId: string) {
    setSelectedIds((current) =>
      current.includes(clipId) ? current.filter((id) => id !== clipId) : [...current, clipId],
    );
  }

  async function remove(clip: ManagedClip, skipConfirm = false) {
    if (!token) return;
    if (
      !skipConfirm &&
      !window.confirm("Delete this clip from the cloud and the Windows app? The share link will stop working.")
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await deleteCloudClip(clip.id, token);
      setClips((current) => current.filter((item) => item.id !== clip.id));
      setTotal((current) => Math.max(0, current - 1));
      if (activeId === clip.id) {
        setActiveId(null);
        setPlaying(null);
      }
      if (quota && clip.fileSizeBytes) {
        setQuota({
          ...quota,
          storage_used_bytes: Math.max(0, quota.storage_used_bytes - clip.fileSizeBytes),
        });
      }
      setSelectedIds((current) => current.filter((id) => id !== clip.id));
      setNotice("Deleted from the cloud. The Windows app will remove the local file when it next opens.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not remove that clip.");
    } finally {
      setBusy(false);
    }
  }

  async function removeSelected() {
    const chosen = clips.filter((clip) => selectedIds.includes(clip.id));
    if (chosen.length === 0) return;
    if (
      !window.confirm(
        `Delete ${chosen.length} clip${chosen.length === 1 ? "" : "s"} from the cloud and the Windows app?`,
      )
    ) {
      return;
    }
    for (const clip of chosen) {
      await remove(clip, true);
    }
  }

  async function downloadSelected() {
    const chosen = clips.filter((clip) => selectedIds.includes(clip.id) && clip.status === "ready");
    if (!token || chosen.length === 0) return;
    setBusy(true);
    setError(null);
    setDownloadProgress({
      message: "Download will begin within about 30 seconds…",
      progress: 0.12,
    });
    try {
      for (const clip of chosen) {
        await downloadCloudClip(clip.slug, clip.title, token, (update) => {
          setDownloadProgress({ message: update.message, progress: update.progress });
        });
      }
      setNotice(chosen.length === 1 ? "Download started" : `${chosen.length} downloads started`);
      setSelectedIds([]);
      setDownloadProgress(null);
    } catch (caught) {
      setDownloadProgress(null);
      setError(caught instanceof Error ? caught.message : "Could not download those clips.");
    } finally {
      setBusy(false);
    }
  }

  const used = quota?.storage_used_bytes ?? 0;
  const limit = quota?.storage_limit_bytes ?? 0;
  const percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const active = clips.find((clip) => clip.id === activeId) ?? null;

  return (
    <main className="page library-page">
      <Seo title="Cloud library — Replayr" description="Watch and manage cloud copies uploaded from the Windows app." robots="noindex" />
      <div className="library-head">
        <div>
          <p className="eyebrow">Your uploads</p>
          <h1>Cloud library</h1>
          <p className="muted">Watch here. Capture still happens on Windows. Deleting a clip here also removes it from the Windows app when it next opens.</p>
        </div>
        {quota ? (
          <div className="quota bubble">
            <div className="quota-bar" aria-hidden="true">
              <span style={{ width: `${percent}%` }} />
            </div>
            <p className="muted">
              {formatBytes(used)} of {formatBytes(limit)} used
            </p>
          </div>
        ) : null}
      </div>
      {error ? <p className="error">{error}</p> : null}
      {notice ? <p className="ok">{notice}</p> : null}
      {downloadProgress ? (
        <aside className="download-prep" aria-live="polite">
          <div className="download-prep-copy">
            <strong>{downloadProgress.message}</strong>
            {!premium ? (
              <p className="muted">
                Upgrade to Premium for instant downloads without a watermark.{" "}
                <Link to="/pricing">View Premium</Link>
              </p>
            ) : null}
          </div>
          <div
            className="download-prep-bar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(downloadProgress.progress * 100)}
          >
            <span style={{ width: `${Math.round(downloadProgress.progress * 100)}%` }} />
          </div>
        </aside>
      ) : null}

      {loading ? (
        <p className="muted">Loading cloud clips…</p>
      ) : clips.length === 0 ? (
        <div className="empty-bubble">
          <h2>Nothing in the cloud yet</h2>
          <p className="muted">Install the Windows app to capture. This page only plays and manages uploads.</p>
        </div>
      ) : (
        <>
          {playBusy && !playing ? (
            <section className="player-stage" ref={playerRef}>
              <p className="muted">Loading clip…</p>
            </section>
          ) : playing ? (
            <section className="player-stage" ref={playerRef}>
              <PlayerVideo showWatermark={playing.watermark !== false}>
                <video className="player" key={playing.playbackUrl} src={playing.playbackUrl} poster={playing.thumbnailUrl || undefined} controls playsInline autoPlay />
              </PlayerVideo>
              <div className="player-meta">
                <div>
                  <h2>{playing.title || "Untitled clip"}</h2>
                  <p className="muted">
                    {playing.width && playing.height ? `${playing.width}×${playing.height}` : ""}
                    {active?.durationMs ? `${playing.width && playing.height ? " · " : ""}${formatDurationMs(active.durationMs)}` : ""}
                  </p>
                  {active ? (
                    <label className="player-visibility">
                      Visibility
                      <select
                        value={active.visibility}
                        aria-label="Clip visibility"
                        onChange={(event) =>
                          void setVisibility(active, event.target.value as ManagedClip["visibility"])
                        }
                      >
                        <option value="private">Private — only you</option>
                        <option value="unlisted">Unlisted — link only</option>
                        <option value="public">Public — everyone</option>
                      </select>
                    </label>
                  ) : null}
                </div>
                <button
                  className="btn"
                  type="button"
                  onClick={() => {
                    setPlaying(null);
                    setActiveId(null);
                  }}
                >
                  Close
                </button>
              </div>
            </section>
          ) : null}

          {selectedIds.length > 0 ? (
            <div className="selection-bar" role="toolbar" aria-label="Selected clips">
              <span>{selectedIds.length} selected</span>
              <button type="button" className="btn ghost" onClick={() => setSelectedIds(clips.map((clip) => clip.id))}>
                Select all
              </button>
              <button className="btn" type="button" disabled={busy} onClick={() => void downloadSelected()}>
                Download
              </button>
              <button className="btn danger" type="button" disabled={busy} onClick={() => void removeSelected()}>
                Delete
              </button>
              <button type="button" className="btn ghost" onClick={() => setSelectedIds([])}>
                Clear
              </button>
            </div>
          ) : null}

          <ul className="clip-grid">
            {clips.map((clip) => (
              <li key={clip.id}>
                <article className={`web-clip-card${activeId === clip.id ? " active" : ""}${selectedIds.includes(clip.id) ? " selected" : ""}`}>
                  <label className="clip-check">
                    <input
                      type="checkbox"
                      checked={selectedIds.includes(clip.id)}
                      aria-label={`Select ${clip.title || "clip"}`}
                      onChange={() => toggleSelect(clip.id)}
                    />
                  </label>
                  <button className="clip-open" type="button" disabled={clip.status !== "ready"} onClick={() => void play(clip)}>
                    <div className="clip-thumb">
                      <ClipThumb title={clip.title || "Clip"} thumbnailUrl={clip.thumbnailUrl} playbackUrl={clip.playbackUrl} />
                      {clip.durationMs ? <span className="clip-duration">{formatDurationMs(clip.durationMs)}</span> : null}
                      <span className="clip-flag">{clip.visibility}</span>
                    </div>
                  </button>
                  <div className="clip-meta">
                    {editingId === clip.id ? (
                      <form
                        className="rename-form"
                        onSubmit={(event: FormEvent) => {
                          event.preventDefault();
                          void saveTitle(clip);
                        }}
                      >
                        <input
                          value={draftTitle}
                          onChange={(event) => setDraftTitle(event.target.value)}
                          autoFocus
                          aria-label="Clip title"
                          onKeyDown={(event) => {
                            if (event.key === "Escape") setEditingId(null);
                          }}
                        />
                        <button className="btn primary" type="submit">
                          Save
                        </button>
                        <button className="btn" type="button" onClick={() => setEditingId(null)}>
                          Cancel
                        </button>
                      </form>
                    ) : (
                      <button
                        className="clip-title"
                        type="button"
                        title="Rename"
                        onClick={() => {
                          setEditingId(clip.id);
                          setDraftTitle(clip.title || "");
                        }}
                      >
                        {clip.title || "Untitled clip"}
                      </button>
                    )}
                    <div className="clip-date">
                      {formatClipDate(clip.createdAt) || clip.status}
                      {clip.fileSizeBytes ? ` · ${formatBytes(clip.fileSizeBytes)}` : ""}
                    </div>
                  </div>
                  <div className="clip-card-actions">
                    <select
                      value={clip.visibility}
                      onChange={(event) => void setVisibility(clip, event.target.value as ManagedClip["visibility"])}
                      disabled={clip.status !== "ready"}
                      aria-label="Visibility"
                    >
                      <option value="private">Private — only you</option>
                      <option value="unlisted">Unlisted — link only</option>
                      <option value="public">Public — everyone</option>
                    </select>
                    <button
                      className="btn"
                      type="button"
                      onClick={() => {
                        setEditingId(clip.id);
                        setDraftTitle(clip.title || "");
                      }}
                    >
                      Rename
                    </button>
                    <button
                      className="btn"
                      type="button"
                      onClick={() => void copyLink(clip)}
                      disabled={clip.status !== "ready" || clip.visibility === "private"}
                      title={clip.visibility === "private" ? "Private clips have no share link" : "Copy share link"}
                    >
                      Copy
                    </button>
                    <button
                      className="btn"
                      type="button"
                      disabled={busy || clip.status !== "ready"}
                      onClick={() => void download(clip)}
                    >
                      Download
                    </button>
                    <button className="btn danger" type="button" disabled={busy} onClick={() => void remove(clip)}>
                      Delete
                    </button>
                  </div>
                </article>
              </li>
            ))}
          </ul>
          {clips.length < total ? <div ref={sentinelRef} className="library-sentinel" aria-hidden="true" /> : null}
          {loadingMore ? <p className="muted">Loading more…</p> : null}
        </>
      )}
    </main>
  );
}
