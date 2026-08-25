import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Seo } from "../components/Seo";
import { ClipThumb } from "../components/ClipThumb";
import { GameCover } from "../components/GameCover";
import { downloadCloudClip, DownloadPreparingError } from "../lib/api";
import { fetchGameClips, type CatalogGame, type PublicGameClip } from "../lib/games";
import { useAuth } from "../lib/auth";
import { formatCount, formatDurationMs, formatHandle } from "../lib/format";

export function GamePage() {
  const { slug = "" } = useParams();
  const { session } = useAuth();
  const [game, setGame] = useState<CatalogGame | null>(null);
  const [clips, setClips] = useState<PublicGameClip[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function download(clip: PublicGameClip) {
    setNotice(null);
    void downloadCloudClip(clip.slug, clip.title).catch((caught) => {
      if (caught instanceof DownloadPreparingError) {
        setNotice(caught.message);
      } else {
        setNotice(caught instanceof Error ? caught.message : "Could not download that clip.");
      }
    });
  }

  useEffect(() => {
    let cancelled = false;
    setGame(null);
    setClips([]);
    setError(null);
    void fetchGameClips(slug, session?.access_token)
      .then((next) => {
        if (cancelled) return;
        setGame(next.game);
        setClips(next.clips);
      })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load this game.");
      });
    return () => {
      cancelled = true;
    };
  }, [slug, session?.access_token]);

  return (
    <main className="page games-page">
      <Seo
        title={game ? `${game.name} — Replayr` : "Game — Replayr"}
        description={
          game
            ? `Public Replayr clips from ${game.name}. Unlisted clips are not listed.`
            : "Public clips for a Replayr catalog game."
        }
      />
      <p>
        <Link to="/games">All games</Link>
      </p>
      {error ? <p className="error">{error}</p> : null}
      {notice ? <p className="muted">{notice}</p> : null}
      {game ? (
        <div className="game-hero">
          <div className="game-hero-cover">
            <GameCover name={game.name} coverUrl={game.coverUrl} />
          </div>
          <div>
            <p className="eyebrow">{game.publisher || "Catalog"}</p>
            <h1>{game.name}</h1>
            <p className="muted">Public clips only. Unlisted and private uploads stay off this page.</p>
          </div>
        </div>
      ) : !error ? (
        <p className="muted">Loading game…</p>
      ) : null}

      {game && clips.length === 0 ? (
        <div className="empty-bubble">
          <h2>No public clips yet</h2>
          <p className="muted">When someone uploads a {game.name} clip and sets it to Public, it shows up here.</p>
        </div>
      ) : null}

      {clips.length > 0 ? (
        <ul className="clip-grid">
          {clips.map((clip) => (
            <li key={clip.id}>
              <article className="web-clip-card">
                <Link className="clip-open" to={`/c/${clip.slug}`}>
                  <div className="clip-thumb">
                    <ClipThumb title={clip.title || "Clip"} thumbnailUrl={clip.thumbnailUrl} playbackUrl={clip.playbackUrl} />
                    {clip.durationMs ? <span className="clip-duration">{formatDurationMs(clip.durationMs)}</span> : null}
                  </div>
                  <div className="clip-meta">
                    <div className="clip-title">{clip.title || "Untitled clip"}</div>
                    <div className="muted">
                      {formatHandle(clip.author)} · {formatCount(clip.likeCount)} likes · {formatCount(clip.commentCount)}{" "}
                      comments
                    </div>
                  </div>
                </Link>
                <div className="clip-card-actions">
                  <button
                    className="btn"
                    type="button"
                    title={clip.downloadReady === false ? "The watermarked download is still being prepared." : undefined}
                    onClick={() => download(clip)}
                  >
                    {clip.downloadReady === false ? "Preparing…" : "Download"}
                  </button>
                </div>
              </article>
            </li>
          ))}
        </ul>
      ) : null}
    </main>
  );
}
