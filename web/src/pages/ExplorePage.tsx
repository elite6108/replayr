import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ClipThumb } from "../components/ClipThumb";
import { Seo } from "../components/Seo";
import { fetchBillingStatus } from "../lib/billing";
import { useAuth } from "../lib/auth";
import { formatCount, formatDurationMs, formatHandle } from "../lib/format";
import { fetchFriendClips, fetchPublicClips, type PublicClipCard } from "../lib/games";

export function ExplorePage() {
  const { session } = useAuth();
  const [clips, setClips] = useState<PublicClipCard[]>([]);
  const [friendClips, setFriendClips] = useState<PublicClipCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAd, setShowAd] = useState(true);

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

  useEffect(() => {
    const token = session?.access_token;
    if (!token) {
      setFriendClips([]);
      return;
    }
    let cancelled = false;
    void fetchFriendClips(token)
      .then((next) => {
        if (!cancelled) setFriendClips(next);
      })
      .catch(() => {
        if (!cancelled) setFriendClips([]);
      });
    return () => {
      cancelled = true;
    };
  }, [session?.access_token]);

  useEffect(() => {
    if (!session?.access_token) {
      setShowAd(true);
      return;
    }
    void fetchBillingStatus(session.access_token)
      .then((status) => setShowAd(status.ads))
      .catch(() => setShowAd(true));
  }, [session?.access_token]);

  return (
    <main className="page">
      <Seo
        title="Explore — Replayr"
        description="Public Replayr clips from other players. Like and comment here. Unlisted links never appear."
      />
      <h1>For You</h1>
      <p className="muted">Public clips only. Unlisted links never show up here, and share URLs stay /c/…</p>
      {showAd ? (
        <aside className="house-ad">
          <strong>Replayr Premium — $4.99/mo</strong>
          <p className="muted">100 GB, original-quality uploads, and no Replayr.tv watermark.</p>
          <Link className="btn primary" to="/pricing">
            See Premium
          </Link>
        </aside>
      ) : null}
      <section className="discover-rail">
        <h2>From friends</h2>
        {!session ? (
          <p className="muted">
            Add friends to see their clips here. <Link to="/signin">Sign in</Link>
          </p>
        ) : friendClips === null ? (
          <p className="muted">Loading friends’ clips…</p>
        ) : friendClips.length === 0 ? (
          <p className="muted">
            Add friends to see their clips here. <Link to="/friends">Find people</Link>
          </p>
        ) : (
          <ul className="discover-rail-track">
            {friendClips.map((clip) => (
              <li key={clip.id}>
                <Link className="feed-card" to={`/c/${clip.slug}`}>
                  <ClipThumb title={clip.title || "Clip"} thumbnailUrl={clip.thumbnailUrl} playbackUrl={null} />
                  <h2>{clip.title || "Untitled clip"}</h2>
                  <p className="muted">{formatHandle(clip.author)}</p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
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
