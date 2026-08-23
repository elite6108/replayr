import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ClipThumb } from "../components/ClipThumb";
import { Seo } from "../components/Seo";
import { useAuth } from "../lib/auth";
import { formatCount, formatDurationMs, formatHandle } from "../lib/format";
import { fetchPublicClips, type PublicClipCard } from "../lib/games";

export function ExplorePage() {
  const { session } = useAuth();
  const [clips, setClips] = useState<PublicClipCard[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchPublicClips(session?.access_token)
      .then((next) => {
        if (!cancelled) setClips(next);
      })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load public clips.");
      });
    return () => {
      cancelled = true;
    };
  }, [session?.access_token]);

  return (
    <main className="page">
      <Seo
        title="Explore — Replayr"
        description="Public Replayr clips from other players. Like and comment here. Unlisted links never appear."
      />
      <h1>For You</h1>
      <p className="muted">Public clips only. Unlisted links never show up here, and share URLs stay /c/…</p>
      {error ? <p className="error">{error}</p> : null}
      {clips.length === 0 && !error ? (
        <div className="empty-bubble">
          <h2>Nothing public yet</h2>
          <p className="muted">When someone uploads a clip and sets it to Public, it lands in this feed.</p>
        </div>
      ) : (
        <ul className="feed-grid">
          {clips.map((clip) => (
            <li key={clip.id}>
              <article className="feed-card">
                <div className="feed-card-head">
                  <strong>{formatHandle(clip.author)}</strong>
                  <span className="muted">{clip.game?.name || "Public"}</span>
                </div>
                <Link to={`/c/${clip.slug}`}>
                  <div className="clip-thumb">
                    <ClipThumb title={clip.title || "Clip"} thumbnailUrl={clip.thumbnailUrl} playbackUrl={null} />
                    {clip.durationMs ? <span className="clip-duration">{formatDurationMs(clip.durationMs)}</span> : null}
                  </div>
                  <h2>{clip.title || "Untitled clip"}</h2>
                </Link>
                <p className="muted">
                  {formatCount(clip.likeCount)} likes · {formatCount(clip.commentCount)} comments
                </p>
              </article>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
