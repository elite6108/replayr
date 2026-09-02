import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { PageHeader } from "../components/common/PageHeader";
import { PlayerVideo } from "../components/common/ReplayrWatermark";
import { SendClipSheet } from "../components/common/SendClipSheet";
import { ExploreCreatorCard } from "../components/explore/ExploreCreatorCard";
import { GameCategoryRow } from "../components/explore/GameCategoryRow";
import { SearchToolbar } from "../components/ui/SearchToolbar";
import { SectionHeader } from "../components/ui/SectionHeader";
import { clipShareUrl } from "../branding";
import {
  deleteClipComment,
  fetchClipComments,
  fetchFriendClips,
  fetchPublicFeed,
  fetchClipPlayback,
  postClipComment,
  setClipLiked,
  type ClipComment,
  type PublicFeedClip,
} from "../services/social";
import { useAuthStore } from "../stores/authStore";
import { useBillingStore } from "../stores/billingStore";
import { useToastStore } from "../stores/toastStore";
import { formatCount, formatDuration, formatHandle } from "../utils/format";

type ExploreMode = "foryou" | "trending" | "friends";

export function ExplorePage() {
  const token = useAuthStore((state) => state.session?.access_token);
  const signedIn = Boolean(useAuthStore((state) => state.user));
  const showAd = useBillingStore((state) => state.status?.ads !== false);
  const showToast = useToastStore((state) => state.show);
  const [clips, setClips] = useState<PublicFeedClip[]>([]);
  const [friendClips, setFriendClips] = useState<PublicFeedClip[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openSlug, setOpenSlug] = useState<string | null>(null);
  const [mode, setMode] = useState<ExploreMode>("foryou");
  const [query, setQuery] = useState("");
  const open = clips.find((clip) => clip.slug === openSlug) ?? friendClips?.find((clip) => clip.slug === openSlug) ?? null;

  useEffect(() => {
    let cancelled = false;
    void fetchPublicFeed(token)
      .then((next) => {
        if (!cancelled) setClips(next);
      })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load public clips.");
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
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
  }, [token]);

  async function toggleLike(clip: PublicFeedClip) {
    if (!token) {
      showToast("Sign in to like public clips");
      return;
    }
    const next = !clip.liked;
    setClips((current) =>
      current.map((item) =>
        item.id === clip.id
          ? { ...item, liked: next, likeCount: Math.max(0, item.likeCount + (next ? 1 : -1)) }
          : item,
      ),
    );
    try {
      const result = await setClipLiked(clip.slug, next, token);
      setClips((current) =>
        current.map((item) =>
          item.id === clip.id ? { ...item, liked: result.liked, likeCount: result.likeCount } : item,
        ),
      );
    } catch (caught) {
      setClips((current) => current.map((item) => (item.id === clip.id ? clip : item)));
      showToast(caught instanceof Error ? caught.message : "Could not update that like.");
    }
  }

  function onComments(slug: string, count: number) {
    setClips((current) => current.map((item) => (item.slug === slug ? { ...item, commentCount: count } : item)));
  }

  const pool = mode === "friends" ? friendClips ?? [] : clips;
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = mode === "trending" ? [...pool].sort((a, b) => b.likeCount - a.likeCount) : pool;
    if (!needle) return list;
    return list.filter((clip) => {
      const title = (clip.title || "").toLowerCase();
      const author = formatHandle(clip.author).toLowerCase();
      const game = (clip.game?.name || "").toLowerCase();
      return title.includes(needle) || author.includes(needle) || game.includes(needle);
    });
  }, [mode, pool, query]);
  const featured = filtered.slice(0, 3);
  const popular = filtered.slice(3);
  const games = useMemo(() => {
    const counts = new Map<string, { slug: string; name: string; coverUrl: string | null; clipCount: number }>();
    for (const clip of clips) {
      if (!clip.game) continue;
      const current = counts.get(clip.game.slug);
      if (current) current.clipCount += 1;
      else counts.set(clip.game.slug, { ...clip.game, clipCount: 1 });
    }
    return [...counts.values()].sort((a, b) => b.clipCount - a.clipCount).slice(0, 8);
  }, [clips]);

  return (
    <div className="explore-page">
      <PageHeader title="Explore" subtitle="Discover epic plays. From real players.">
        <Link className="btn primary" to="/library">
          Post clip
        </Link>
      </PageHeader>
      <SearchToolbar value={query} onChange={setQuery} placeholder="Search creators or clips" />
      {showAd ? (
        <aside className="house-ad">
          <strong>Replayr Premium — $4.99/mo</strong>
          <p className="muted">100 GB, original-quality uploads, and no Replayr.tv watermark.</p>
          <Link className="btn primary" to="/profile">
            Upgrade
          </Link>
        </aside>
      ) : null}
      <div className="chip-row explore-modes">
        <button type="button" className={`chip ${mode === "foryou" ? "on" : ""}`} onClick={() => setMode("foryou")}>
          For You
        </button>
        <button type="button" className={`chip ${mode === "trending" ? "on" : ""}`} onClick={() => setMode("trending")}>
          Trending
        </button>
        <button type="button" className={`chip ${mode === "friends" ? "on" : ""}`} onClick={() => setMode("friends")}>
          Following
        </button>
      </div>
      {error ? <p className="error-text">{error}</p> : null}
      {mode === "friends" && !signedIn ? (
        <p className="muted">
          Follow people to see their clips here. <Link to="/profile">Sign in</Link>
        </p>
      ) : mode === "friends" && friendClips === null ? (
        <p className="muted">Loading following clips…</p>
      ) : filtered.length === 0 ? (
        <section className="panel">
          <p className="muted">
            {mode === "friends"
              ? "Follow people to see their clips here."
              : "When someone makes a clip public, it lands here."}
          </p>
        </section>
      ) : (
        <>
          {featured.length > 0 ? (
            <section>
              <SectionHeader title="Featured" />
              <div className="creator-card-row">
                {featured.map((clip) => (
                  <ExploreCreatorCard
                    key={clip.id}
                    clip={clip}
                    onOpen={() => setOpenSlug(clip.slug)}
                    onLike={() => void toggleLike(clip)}
                  />
                ))}
              </div>
            </section>
          ) : null}
          {popular.length > 0 ? (
            <section>
              <SectionHeader title="Popular this week" />
              <div className="explore-grid">
                {popular.map((clip) => (
                  <article key={clip.id} className="feed-card">
                    <button className="clip-open" type="button" onClick={() => setOpenSlug(clip.slug)}>
                      {clip.thumbnailUrl ? <img src={clip.thumbnailUrl} alt="" /> : <div className="feed-thumb-empty" />}
                      {clip.durationMs ? <span className="clip-duration">{formatDuration(clip.durationMs)}</span> : null}
                    </button>
                    <h2>{clip.title || "Untitled clip"}</h2>
                    <div className="feed-card-head">
                      <strong>{formatHandle(clip.author)}</strong>
                      <span className="muted">{clip.game?.name || "Public"}</span>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          ) : null}
        </>
      )}
      <GameCategoryRow games={games} />
      {open ? (
        <PublicClipPanel
          clip={open}
          token={token}
          signedIn={signedIn}
          onClose={() => setOpenSlug(null)}
          onLike={() => void toggleLike(open)}
          onComments={onComments}
        />
      ) : null}
    </div>
  );
}

function PublicClipPanel({
  clip,
  token,
  signedIn,
  onClose,
  onLike,
  onComments,
}: {
  clip: PublicFeedClip;
  token?: string;
  signedIn: boolean;
  onClose: () => void;
  onLike: () => void;
  onComments: (slug: string, count: number) => void;
}) {
  const [comments, setComments] = useState<ClipComment[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sendOpen, setSendOpen] = useState(false);
  const [playbackUrl, setPlaybackUrl] = useState(clip.playbackUrl);

  useEffect(() => {
    let cancelled = false;
    setPlaybackUrl(clip.playbackUrl);
    if (clip.playbackUrl) return;
    void fetchClipPlayback(clip.slug, token)
      .then((next) => {
        if (!cancelled) setPlaybackUrl(next.playbackUrl);
      })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load that clip.");
      });
    return () => {
      cancelled = true;
    };
  }, [clip.slug, clip.playbackUrl, token]);

  useEffect(() => {
    let cancelled = false;
    void fetchClipComments(clip.slug, token)
      .then((next) => {
        if (!cancelled) setComments(next);
      })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load comments.");
      });
    return () => {
      cancelled = true;
    };
  }, [clip.slug, token]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!token) return;
    const body = draft.trim();
    if (!body) return;
    try {
      const next = await postClipComment(clip.slug, body, token);
      setComments(next.comments);
      setDraft("");
      onComments(clip.slug, next.commentCount);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not post that comment.");
    }
  }

  return (
    <div className="player-overlay" role="dialog" aria-modal="true" aria-label={clip.title || "Public clip"}>
      <button type="button" className="player-backdrop" aria-label="Close" onClick={onClose} />
      <section className="player-card">
        <div className="player-stage">
          {playbackUrl ? (
            <PlayerVideo showWatermark={clip.watermark !== false}>
              <video src={playbackUrl} controls autoPlay />
            </PlayerVideo>
          ) : (
            <p className="muted">{error || "Loading playback…"}</p>
          )}
        </div>
        <div className="player-side">
          <h2>{clip.title || "Untitled clip"}</h2>
          <p className="muted">{formatHandle(clip.author)}</p>
          <div className="row">
            <button className={`btn ${clip.liked ? "liked" : ""}`} type="button" onClick={onLike}>
              {clip.liked ? "Liked" : "Like"} · {formatCount(clip.likeCount)}
            </button>
            {signedIn ? (
              <button className="btn" type="button" onClick={() => setSendOpen(true)}>
                Send
              </button>
            ) : null}
            <a className="btn" href={clipShareUrl(clip.slug)} target="_blank" rel="noreferrer">
              Open link
            </a>
          </div>
          {error ? <p className="error-text">{error}</p> : null}
          <ul className="comment-list">
            {comments.map((comment) => (
              <li key={comment.id}>
                <strong>{formatHandle(comment.author)}</strong>
                <span>{comment.body}</span>
                {comment.canDelete && token ? (
                  <button
                    className="btn ghost"
                    type="button"
                    onClick={() => {
                      void deleteClipComment(clip.slug, comment.id, token).then((next) => {
                        setComments((current) => current.filter((item) => item.id !== comment.id));
                        onComments(clip.slug, next.commentCount);
                      });
                    }}
                  >
                    Delete
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
          {signedIn ? (
            <form className="comment-form" onSubmit={(event) => void submit(event)}>
              <input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                maxLength={500}
                placeholder="Add a comment"
                aria-label="Add a comment"
              />
              <button className="btn primary" type="submit">
                Comment
              </button>
            </form>
          ) : (
            <p className="muted">
              <Link to="/profile">Sign in</Link> to like or comment.
            </p>
          )}
        </div>
      </section>
      {sendOpen ? <SendClipSheet slug={clip.slug} onClose={() => setSendOpen(false)} /> : null}
    </div>
  );
}
