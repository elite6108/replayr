import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { PlayerVideo } from "../components/ReplayrWatermark";
import { Seo } from "../components/Seo";
import { SocialAvatar } from "../components/SocialAvatar";
import { WINDOWS_DOWNLOAD_PATH } from "../lib/branding";
import {
  fetchPublicFolder,
  fetchPublicFolderDownload,
  fetchPublicFolderPlayback,
  type PublicFolder,
  type PublicFolderClip,
} from "../lib/api.folders";
import { formatDurationMs } from "../lib/format";

export function PublicFolderPage() {
  const { token = "" } = useParams();
  const [folder, setFolder] = useState<PublicFolder | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<PublicFolderClip | null>(null);
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFolder(null);
    setError(null);
    setActive(null);
    setPlaybackUrl(null);
    void fetchPublicFolder(token)
      .then((next) => {
        if (!cancelled) setFolder(next);
      })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "That folder was not found.");
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function play(clip: PublicFolderClip) {
    setBusy(true);
    try {
      const url = await fetchPublicFolderPlayback(token, clip.id);
      setActive(clip);
      setPlaybackUrl(url);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That clip was not found in this folder.");
    } finally {
      setBusy(false);
    }
  }

  async function download(clip: PublicFolderClip) {
    if (!folder?.allowDownloads) return;
    setBusy(true);
    try {
      const url = await fetchPublicFolderDownload(token, clip.id);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${clip.title || "clip"}.mp4`;
      link.rel = "noopener";
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Downloads are disabled for this folder.");
    } finally {
      setBusy(false);
    }
  }

  const missing = Boolean(error && !folder);
  const title = missing ? "Folder unavailable · Replayr" : folder ? `${folder.name} on Replayr` : "Folder · Replayr";
  const description = missing
    ? "This folder is not available."
    : folder?.description || "A Replayr public folder.";

  return (
    <main className="page public-folder-page">
      <Seo
        title={title}
        description={description}
        robots={missing ? "noindex,nofollow" : "index,follow"}
        image={missing ? undefined : folder?.coverThumbnailUrl}
      />
      {missing ? (
        <section className="public-folder-empty">
          <p className="eyebrow">Replayr.TV</p>
          <h1>Folder unavailable</h1>
          <p className="muted">This folder is not available.</p>
          <Link className="btn" to="/">
            Back to Replayr
          </Link>
        </section>
      ) : !folder ? (
        <p className="muted">Loading folder…</p>
      ) : (
        <>
          <header className="public-folder-hero">
            <p className="eyebrow">Replayr.TV</p>
            <div className="public-folder-title">
              <h1>{folder.name}</h1>
              <div className="row">
                <span className="badge">Public Folder</span>
                <span className="badge">{folder.clipCount === 1 ? "1 clip" : `${folder.clipCount} clips`}</span>
              </div>
            </div>
            {folder.description ? <p className="muted">{folder.description}</p> : null}
            {folder.owner ? (
              <div className="public-folder-owner">
                <SocialAvatar name={folder.owner.displayName} avatarUrl={folder.owner.avatarUrl} size={32} />
                <span>{folder.owner.displayName}</span>
              </div>
            ) : null}
          </header>

          {active && playbackUrl ? (
            <section className="public-folder-player">
              <PlayerVideo showWatermark>
                <video src={playbackUrl} controls playsInline autoPlay />
              </PlayerVideo>
              <div className="row">
                <strong>{active.title || "Untitled clip"}</strong>
                {folder.allowDownloads ? (
                  <button type="button" className="btn sm" disabled={busy} onClick={() => void download(active)}>
                    Download
                  </button>
                ) : null}
              </div>
            </section>
          ) : null}

          {folder.clips.length === 0 ? (
            <p className="muted">This folder is empty.</p>
          ) : (
            <ul className="clip-grid">
              {folder.clips.map((clip) => (
                <li key={clip.id}>
                  <article className="web-clip-card">
                    <button type="button" className="clip-open" disabled={busy} onClick={() => void play(clip)}>
                      <div className="clip-thumb">
                        {clip.thumbnailUrl ? <img src={clip.thumbnailUrl} alt="" /> : <span>Clip</span>}
                        {clip.durationMs ? <span className="clip-duration">{formatDurationMs(clip.durationMs)}</span> : null}
                      </div>
                      <strong>{clip.title || "Untitled clip"}</strong>
                    </button>
                    {folder.allowDownloads ? (
                      <div className="clip-card-actions">
                        <button type="button" className="btn sm" disabled={busy} onClick={() => void download(clip)}>
                          Download
                        </button>
                      </div>
                    ) : null}
                  </article>
                </li>
              ))}
            </ul>
          )}

          <p className="muted public-folder-cta">
            <a href={WINDOWS_DOWNLOAD_PATH}>Open Replayr</a>
            <span aria-hidden="true"> · </span>
            <Link to="/">Create your own clips</Link>
          </p>
        </>
      )}
    </main>
  );
}
