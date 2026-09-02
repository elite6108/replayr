import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { PageHeader } from "../components/common/PageHeader";
import { PlayerVideo } from "../components/common/ReplayrWatermark";
import { SocialAvatar } from "../components/common/SocialAvatar";
import { clipShareUrl } from "../branding";
import {
  createProfilePost,
  deleteProfilePost,
  fetchUserProfile,
} from "../services/api.friends";
import {
  acceptFollowRequest,
  declineFollowRequest,
  emptyFollowState,
  followLabel,
  followUser,
  unfollowUser,
} from "../services/api.follows";
import { createConversation } from "../services/api.messages";
import { fetchClipPlayback } from "../services/social";
import type { PublicClipCard, UserProfileResponse } from "../services/social-types";
import { useAuthStore } from "../stores/authStore";
import { formatCount, formatDuration, formatHandle } from "../utils/format";
import { useToastStore } from "../stores/toastStore";

export function UserProfilePage() {
  const { username = "" } = useParams();
  const navigate = useNavigate();
  const token = useAuthStore((state) => state.session?.access_token);
  const myId = useAuthStore((state) => state.user?.id);
  const [profile, setProfile] = useState<UserProfileResponse | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openClip, setOpenClip] = useState<PublicClipCard | null>(null);
  const [tab, setTab] = useState<"clips" | "posts">("clips");
  const [draft, setDraft] = useState("");
  const [attachId, setAttachId] = useState("");

  async function load() {
    const next = await fetchUserProfile(token, username);
    setProfile(next);
    setMissing(false);
  }

  useEffect(() => {
    let cancelled = false;
    setProfile(null);
    setMissing(false);
    setError(null);
    void load().catch((caught) => {
      if (cancelled) return;
      const message = caught instanceof Error ? caught.message : "That account was not found.";
      if (/not found/i.test(message)) {
        setMissing(true);
        setError(null);
      } else {
        setError(message);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [username, token, myId]);

  const mine = Boolean(profile && myId && profile.user.id === myId);
  const name = profile ? profile.user.displayName || profile.user.username || username : username;
  const follow = profile?.follow ?? emptyFollowState();

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await work();
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That action failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title={missing ? "Profile unavailable" : name}
        subtitle={
          missing
            ? "That account was not found."
            : profile?.locked
              ? "This account is private."
              : profile?.user.bio || undefined
        }
      />
      {error && !profile ? <p className="error-text">{error}</p> : null}
      {!missing && !profile && !error ? <p className="muted">Loading…</p> : null}
      {profile ? (
        <>
          <section className="panel stack">
            <div className="profile-hero">
              <SocialAvatar person={profile.user} size="lg" />
              <div>
                <p className="muted">{profile.user.username ? `@${profile.user.username}` : "Player"}</p>
                <div className="stat-value">
                  {name}
                  {profile.user.verified ? <span className="verified-dot" title="Verified" /> : null}
                </div>
                {profile.isPrivate ? <p className="muted">Private account</p> : null}
                {profile.locked ? (
                  <p className="muted">This account is private.</p>
                ) : (
                  <p className="muted">
                    {formatCount(profile.user.clipCount)} public clips
                    {mine ? " · This is you" : ""}
                  </p>
                )}
                {error ? <p className="error-text">{error}</p> : null}
                <div className="row">
                  {mine ? (
                    <Link className="btn" to="/profile">
                      Account
                    </Link>
                  ) : !token ? (
                    <Link className="btn primary" to="/profile">
                      Sign in to follow
                    </Link>
                  ) : (
                    <>
                      {follow.incomingPending ? (
                        <>
                          <button
                            className="btn primary"
                            type="button"
                            disabled={busy}
                            onClick={() => void run(async () => {
                              await acceptFollowRequest(token, username);
                            })}
                          >
                            Accept
                          </button>
                          <button
                            className="btn"
                            type="button"
                            disabled={busy}
                            onClick={() => void run(() => declineFollowRequest(token, username))}
                          >
                            Decline
                          </button>
                        </>
                      ) : null}
                      {follow.viewerFollows || follow.viewerFollowPending ? (
                        <button
                          className="btn"
                          type="button"
                          disabled={busy}
                          onClick={() => void run(async () => { await unfollowUser(token, username); })}
                        >
                          {followLabel(follow)}
                        </button>
                      ) : (
                        <button
                          className="btn primary"
                          type="button"
                          disabled={busy}
                          onClick={() => void run(async () => { await followUser(token, username); })}
                        >
                          {followLabel(follow)}
                        </button>
                      )}
                      {profile.relationship === "friends" || follow.mutual ? (
                        <button
                          className="btn primary"
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            void createConversation(token, { type: "dm", userId: profile.user.id })
                              .then((conversation) => navigate(`/messages/${conversation.id}`))
                              .catch((caught) => {
                                setError(caught instanceof Error ? caught.message : "Could not open that chat.");
                              });
                          }}
                        >
                          Message
                        </button>
                      ) : null}
                    </>
                  )}
                </div>
              </div>
            </div>
          </section>

          {profile.locked ? null : (
            <>
          <div className="row">
            <button className={`btn ${tab === "clips" ? "primary" : ""}`} type="button" onClick={() => setTab("clips")}>
              Clips
            </button>
            <button className={`btn ${tab === "posts" ? "primary" : ""}`} type="button" onClick={() => setTab("posts")}>
              Posts
            </button>
          </div>
          {tab === "clips" && profile.clips.length === 0 ? (
            <section className="panel">
              <p className="muted">Only public uploads show here. Unlisted links stay off this profile.</p>
            </section>
          ) : tab === "clips" ? (
            <div className="explore-grid">
              {profile.clips.map((clip) => (
                <article key={clip.id} className="feed-card">
                  <div className="feed-card-head">
                    <strong>{formatHandle(clip.author)}</strong>
                    <span className="muted">{clip.game?.name || "Public"}</span>
                  </div>
                  <button
                    className="clip-open"
                    type="button"
                    onClick={() => {
                      void (async () => {
                        if (clip.playbackUrl) {
                          setOpenClip(clip);
                          return;
                        }
                        try {
                          const next = await fetchClipPlayback(clip.slug, token);
                          setOpenClip({ ...clip, playbackUrl: next.playbackUrl, watermark: next.watermark ?? clip.watermark });
                        } catch (caught) {
                          useToastStore.getState().show(caught instanceof Error ? caught.message : "Could not play that clip");
                        }
                      })();
                    }}
                  >
                    {clip.thumbnailUrl ? <img src={clip.thumbnailUrl} alt="" /> : <div className="feed-thumb-empty" />}
                    {clip.durationMs ? <span className="clip-duration">{formatDuration(clip.durationMs)}</span> : null}
                  </button>
                  <h2>{clip.title || "Untitled clip"}</h2>
                  <p className="muted">
                    {formatCount(clip.likeCount)} likes · {formatCount(clip.commentCount)} comments
                  </p>
                </article>
              ))}
            </div>
          ) : tab === "posts" ? (
            <>
              {mine && token ? (
                <section className="panel">
                  <textarea
                    rows={3}
                    maxLength={500}
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    placeholder="Write a post"
                  />
                  {profile.clips.length > 0 ? (
                    <select value={attachId} onChange={(event) => setAttachId(event.target.value)}>
                      <option value="">No clip attached</option>
                      {profile.clips.map((clip) => (
                        <option key={clip.id} value={clip.id}>
                          {clip.title || "Untitled clip"}
                        </option>
                      ))}
                    </select>
                  ) : null}
                  <button
                    className="btn primary"
                    type="button"
                    disabled={!draft.trim()}
                    onClick={() =>
                      void (async () => {
                        try {
                          await createProfilePost(token, draft.trim(), attachId || undefined);
                          setDraft("");
                          setAttachId("");
                          setProfile(await fetchUserProfile(token, username));
                        } catch (caught) {
                          useToastStore.getState().show(caught instanceof Error ? caught.message : "Could not publish");
                        }
                      })()
                    }
                  >
                    Post
                  </button>
                </section>
              ) : null}
              {profile.posts.length === 0 ? (
                <section className="panel">
                  <p className="muted">No posts yet.</p>
                </section>
              ) : (
                profile.posts.map((post) => (
                  <article className="panel" key={post.id}>
                    <p>{post.body}</p>
                    <p className="muted">{new Date(post.createdAt).toLocaleString()}</p>
                    {mine && token ? (
                      <button
                        className="btn"
                        type="button"
                        onClick={() =>
                          void (async () => {
                            try {
                              await deleteProfilePost(token, post.id);
                              setProfile(await fetchUserProfile(token, username));
                            } catch (caught) {
                              useToastStore.getState().show(caught instanceof Error ? caught.message : "Could not delete");
                            }
                          })()
                        }
                      >
                        Delete
                      </button>
                    ) : null}
                    {post.clip ? (
                      <button
                        className="clip-open"
                        type="button"
                        onClick={() => {
                          void (async () => {
                            if (post.clip?.playbackUrl) {
                              setOpenClip(post.clip);
                              return;
                            }
                            try {
                              const next = await fetchClipPlayback(post.clip!.slug, token);
                              setOpenClip({ ...post.clip!, playbackUrl: next.playbackUrl, watermark: next.watermark ?? post.clip!.watermark });
                            } catch (caught) {
                              useToastStore.getState().show(caught instanceof Error ? caught.message : "Could not play that clip");
                            }
                          })();
                        }}
                      >
                        {post.clip.thumbnailUrl ? <img src={post.clip.thumbnailUrl} alt="" /> : <div className="feed-thumb-empty" />}
                        <h2>{post.clip.title || "Untitled clip"}</h2>
                      </button>
                    ) : null}
                  </article>
                ))
              )}
            </>
          ) : null}
            </>
          )}
        </>
      ) : null}
      {openClip ? (
        <div className="player-overlay" role="dialog" aria-modal="true" aria-label={openClip.title || "Public clip"}>
          <button type="button" className="player-backdrop" aria-label="Close" onClick={() => setOpenClip(null)} />
          <section className="player-card">
            <div className="player-stage">
              {openClip.playbackUrl ? (
                <PlayerVideo showWatermark={openClip.watermark !== false}>
                  <video src={openClip.playbackUrl} controls autoPlay />
                </PlayerVideo>
              ) : (
                <p className="muted">Playback is unavailable.</p>
              )}
            </div>
            <div className="player-side">
              <h2>{openClip.title || "Untitled clip"}</h2>
              <p className="muted">{formatHandle(openClip.author)}</p>
              <a className="btn" href={clipShareUrl(openClip.slug)} target="_blank" rel="noreferrer">
                Open link
              </a>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
