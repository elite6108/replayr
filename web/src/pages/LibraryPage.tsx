import { FormEvent, useEffect, useState } from "react";
import { Seo } from "../components/Seo";
import { ClipThumb } from "../components/ClipThumb";
import { deleteCloudClip, downloadCloudClip, fetchLibrary, fetchPlayback, type ManagedClip, type PlaybackClip } from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatBytes, formatDurationMs } from "../lib/format";
import { clipShareUrl, getSupabase } from "../lib/supabase";

interface Quota {
  storage_used_bytes: number;
  storage_limit_bytes: number;
}

export function LibraryPage() {
  const { session } = useAuth();
  const userId = session?.user.id ?? "";
  const token = session?.access_token;
  const [clips, setClips] = useState<ManagedClip[]>([]);
  const [quota, setQuota] = useState<Quota | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [playing, setPlaying] = useState<PlaybackClip | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!userId || !token) return;
    let cancelled = false;
    void (async () => {
      try {
        const [nextClips, quotaResult] = await Promise.all([
          fetchLibrary(token),
          getSupabase().from("user_storage").select("storage_used_bytes, storage_limit_bytes").eq("user_id", userId).maybeSingle(),
        ]);
        if (cancelled) return;
        setClips(nextClips);
        if (!quotaResult.error && quotaResult.data) setQuota(quotaResult.data as Quota);
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load cloud clips.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, token]);

  async function setVisibility(clip: ManagedClip, visibility: ManagedClip["visibility"]) {
    setNotice(null);
    const { error: next } = await getSupabase().from("clips").update({ visibility }).eq("id", clip.id).eq("user_id", userId);
    if (next) {
      setError(next.message);
      return;
    }
    setClips((current) => current.map((item) => (item.id === clip.id ? { ...item, visibility } : item)));
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
    try {
      await downloadCloudClip(clip.slug, clip.title, token);
      setNotice("Download started");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not download that clip.");
    } finally {
      setBusy(false);
    }
  }

  async function copyLink(slug: string) {
    try {
      await navigator.clipboard.writeText(clipShareUrl(slug));
      setNotice("Link copied");
    } catch {
      setNotice(clipShareUrl(slug));
    }
  }

  async function play(clip: ManagedClip) {
    if (clip.status !== "ready" || !token) return;
    setError(null);
    setActiveId(clip.id);
    if (clip.playbackUrl) {
      setPlaying({
        slug: clip.slug,
        title: clip.title,
        durationMs: clip.durationMs,
        width: clip.width,
        height: clip.height,
        visibility: clip.visibility,
        status: clip.status,
        playbackUrl: clip.playbackUrl,
        thumbnailUrl: clip.thumbnailUrl,
      });
      return;
    }
    try {
      setPlaying(await fetchPlayback(clip.slug, token));
    } catch (caught) {
      setPlaying(null);
      setError(caught instanceof Error ? caught.message : "Could not play this clip.");
    }
  }

  async function remove(clip: ManagedClip) {
    if (!token) return;
    if (!window.confirm("Delete this cloud copy? The file on your PC stays. The share link will stop working.")) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await deleteCloudClip(clip.id, token);
      setClips((current) => current.filter((item) => item.id !== clip.id));
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
      setNotice("Cloud copy deleted. The file on your PC is unchanged.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not delete that clip.");
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
          <p className="muted">Watch here. Capture still happens on Windows. Delete removes the cloud copy only.</p>
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

      {clips.length === 0 ? (
        <div className="empty-bubble">
          <h2>Nothing in the cloud yet</h2>
          <p className="muted">Install the Windows app to capture. This page only plays and manages uploads.</p>
        </div>
      ) : (
        <>
          {playing ? (
            <section className="player-stage">
              <video className="player" key={playing.playbackUrl} src={playing.playbackUrl} poster={playing.thumbnailUrl || undefined} controls playsInline autoPlay />
              <div className="player-meta">
                <div>
                  <h2>{playing.title || "Untitled clip"}</h2>
                  <p className="muted">
                    {playing.visibility}
                    {playing.width && playing.height ? ` · ${playing.width}×${playing.height}` : ""}
                    {active?.durationMs ? ` · ${formatDurationMs(active.durationMs)}` : ""}
                  </p>
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

          <ul className="clip-grid">
            {clips.map((clip) => (
              <li key={clip.id}>
                <article className={`web-clip-card${activeId === clip.id ? " active" : ""}`}>
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
                    <div className="muted">
                      {clip.status}
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
                      <option value="unlisted">Unlisted</option>
                      <option value="private">Private</option>
                      <option value="public">Public</option>
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
                    <button className="btn" type="button" onClick={() => void copyLink(clip.slug)} disabled={clip.status !== "ready"}>
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
        </>
      )}
    </main>
  );
}
