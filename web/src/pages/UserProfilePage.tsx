import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ClipThumb } from "../components/ClipThumb";
import { Seo } from "../components/Seo";
import { SocialAvatar } from "../components/SocialAvatar";
import {
  acceptFriendRequest,
  cancelFriendRequest,
  createFriendRequest,
  createProfilePost,
  declineFriendRequest,
  deleteProfilePost,
  fetchFriendRequests,
  fetchUserProfile,
  personName,
  type FriendRequest,
  type UserProfileResponse,
} from "../lib/api.friends";
import { createConversation } from "../lib/api.messages";
import { useAuth } from "../lib/auth";
import { formatCount, formatDurationMs, formatHandle } from "../lib/format";

export function UserProfilePage() {
  const { username = "" } = useParams();
  const { session } = useAuth();
  const navigate = useNavigate();
  const token = session?.access_token;
  const myId = session?.user.id;
  const [profile, setProfile] = useState<UserProfileResponse | null>(null);
  const [incoming, setIncoming] = useState<FriendRequest[]>([]);
  const [outgoing, setOutgoing] = useState<FriendRequest[]>([]);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"clips" | "posts">("clips");
  const [draft, setDraft] = useState("");
  const [attachId, setAttachId] = useState("");

  async function load() {
    const next = await fetchUserProfile(username, token);
    setProfile(next);
    setMissing(false);
    if (token && next.relationship !== "none" && next.user.id !== myId) {
      const requests = await fetchFriendRequests(token);
      setIncoming(requests.incoming);
      setOutgoing(requests.outgoing);
    } else {
      setIncoming([]);
      setOutgoing([]);
    }
  }

  useEffect(() => {
    let cancelled = false;
    setProfile(null);
    setMissing(false);
    setError(null);
    void load()
      .catch((caught) => {
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
  const name = profile ? personName(profile.user) : username;
  const incomingRequest = incoming.find((item) => item.from.id === profile?.user.id);
  const outgoingRequest = outgoing.find((item) => item.to.id === profile?.user.id);

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
    <main className="page social-page">
      <Seo
        title={missing ? "Profile — Replayr" : `${name} — Replayr`}
        description={
          missing
            ? "That Replayr profile is not available."
            : profile?.locked
              ? "This account is private."
              : profile?.user.bio || `Public Replayr profile for ${name}.`
        }
        robots={missing ? "noindex,nofollow" : "index,follow"}
      />
      {missing ? (
        <>
          <h1>Profile unavailable</h1>
          <p className="muted">That account was not found.</p>
        </>
      ) : error && !profile ? (
        <>
          <h1>Profile</h1>
          <p className="error">{error}</p>
        </>
      ) : !profile ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <div className="profile-hero">
            <SocialAvatar name={name} avatarUrl={profile.user.avatarUrl} size={72} />
            <div>
              <p className="eyebrow">{profile.user.username ? `@${profile.user.username}` : "Player"}</p>
              <h1>
                {name}
                {profile.user.verified ? <span className="verified-mark">Verified</span> : null}
                {profile.isPrivate ? <span className="verified-mark">Private</span> : null}
              </h1>
              {profile.locked ? (
                <p className="lede">This account is private.</p>
              ) : (
                <>
                  {profile.user.bio ? <p className="lede">{profile.user.bio}</p> : null}
                  <p className="muted">
                    {formatCount(profile.user.clipCount)} public clips
                    {mine ? " · This is you" : ""}
                  </p>
                </>
              )}
              {error ? <p className="error">{error}</p> : null}
              <div className="row">
                {mine ? (
                  <Link className="btn" to="/account">
                    Account
                  </Link>
                ) : !token ? (
                  <Link className="btn primary" to="/signin">
                    Sign in to follow
                  </Link>
                ) : (
                  <>
                    {profile.relationship === "incoming" && incomingRequest ? (
                      <>
                        <button
                          className="btn primary"
                          type="button"
                          disabled={busy}
                          onClick={() => void run(async () => {
                            await acceptFriendRequest(token, incomingRequest.id);
                          })}
                        >
                          Accept
                        </button>
                        <button
                          className="btn"
                          type="button"
                          disabled={busy}
                          onClick={() => void run(() => declineFriendRequest(token, incomingRequest.id))}
                        >
                          Decline
                        </button>
                      </>
                    ) : null}
                    {profile.relationship === "outgoing" || profile.follow?.viewerFollowPending ? (
                      <button
                        className="btn"
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void run(() =>
                            outgoingRequest
                              ? cancelFriendRequest(token, outgoingRequest.id)
                              : Promise.resolve(),
                          )
                        }
                      >
                        Requested
                      </button>
                    ) : profile.relationship === "following" || profile.follow?.viewerFollows ? (
                      <span className="muted">Following</span>
                    ) : (
                      <button
                        className="btn primary"
                        type="button"
                        disabled={busy}
                        onClick={() => void run(async () => {
                          await createFriendRequest(token, { userId: profile.user.id });
                        })}
                      >
                        {profile.relationship === "follower" || profile.follow?.followsViewer ? "Follow back" : "Follow"}
                      </button>
                    )}
                    {profile.relationship === "friends" || profile.follow?.mutual ? (
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
              {tab === "clips" ? (
                profile.clips.length === 0 ? (
                  <div className="empty-bubble">
                    <h2>No public clips yet</h2>
                    <p className="muted">Only public uploads show here. Unlisted links stay off this profile.</p>
                  </div>
                ) : (
                  <ul className="feed-grid">
                    {profile.clips.map((clip) => (
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
                )
              ) : (
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
                        disabled={!draft.trim() || busy}
                        onClick={() =>
                          void run(async () => {
                            await createProfilePost(token, draft.trim(), attachId || undefined);
                            setDraft("");
                            setAttachId("");
                          })
                        }
                      >
                        Post
                      </button>
                    </section>
                  ) : null}
                  {profile.posts.length === 0 ? (
                    <div className="empty-bubble">
                      <h2>No posts yet</h2>
                    </div>
                  ) : (
                    <ul className="feed-grid">
                      {profile.posts.map((post) => (
                        <li key={post.id}>
                          <article className="feed-card">
                            <p>{post.body}</p>
                            <p className="muted">{new Date(post.createdAt).toLocaleString()}</p>
                            {mine && token ? (
                              <button
                                className="btn"
                                type="button"
                                disabled={busy}
                                onClick={() => void run(() => deleteProfilePost(token, post.id))}
                              >
                                Delete
                              </button>
                            ) : null}
                            {post.clip ? (
                              <Link to={`/c/${post.clip.slug}`}>
                                <div className="clip-thumb">
                                  <ClipThumb title={post.clip.title || "Clip"} thumbnailUrl={post.clip.thumbnailUrl} playbackUrl={null} />
                                </div>
                                <h2>{post.clip.title || "Untitled clip"}</h2>
                              </Link>
                            ) : null}
                          </article>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </>
          )}
        </>
      )}
    </main>
  );
}
