import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ClipThumb } from "../components/ClipThumb";
import { Seo } from "../components/Seo";
import { SocialAvatar } from "../components/SocialAvatar";
import {
  acceptFriendRequest,
  cancelFriendRequest,
  createFriendRequest,
  declineFriendRequest,
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
              </h1>
              {profile.user.bio ? <p className="lede">{profile.user.bio}</p> : null}
              <p className="muted">
                {formatCount(profile.user.clipCount)} public clips
                {mine ? " · This is you" : ""}
              </p>
              {error ? <p className="error">{error}</p> : null}
              <div className="row">
                {mine ? (
                  <Link className="btn" to="/account">
                    Account
                  </Link>
                ) : !token ? (
                  <Link className="btn primary" to="/signin">
                    Sign in to add friends
                  </Link>
                ) : profile.relationship === "friends" ? (
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
                ) : profile.relationship === "outgoing" && outgoingRequest ? (
                  <button
                    className="btn"
                    type="button"
                    disabled={busy}
                    onClick={() => void run(() => cancelFriendRequest(token, outgoingRequest.id))}
                  >
                    Cancel request
                  </button>
                ) : profile.relationship === "outgoing" ? (
                  <span className="muted">Request sent</span>
                ) : profile.relationship === "incoming" && incomingRequest ? (
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
                ) : (
                  <button
                    className="btn primary"
                    type="button"
                    disabled={busy}
                    onClick={() => void run(async () => {
                      await createFriendRequest(token, { userId: profile.user.id });
                    })}
                  >
                    Add friend
                  </button>
                )}
              </div>
            </div>
          </div>

          <h2 className="section-title">Public clips</h2>
          {profile.clips.length === 0 ? (
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
          )}
        </>
      )}
    </main>
  );
}
