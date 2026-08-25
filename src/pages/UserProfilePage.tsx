import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { PageHeader } from "../components/common/PageHeader";
import { PlayerVideo } from "../components/common/ReplayrWatermark";
import { SocialAvatar } from "../components/common/SocialAvatar";
import { clipShareUrl } from "../branding";
import {
  acceptFriendRequest,
  cancelFriendRequest,
  createFriendRequest,
  declineFriendRequest,
  fetchFriendRequests,
  fetchUserProfile,
} from "../services/api.friends";
import { createConversation } from "../services/api.messages";
import type { FriendRequest, PublicClipCard, UserProfileResponse } from "../services/social-types";
import { useAuthStore } from "../stores/authStore";
import { useBillingStore } from "../stores/billingStore";
import { formatCount, formatDuration, formatHandle } from "../utils/format";

export function UserProfilePage() {
  const { username = "" } = useParams();
  const navigate = useNavigate();
  const token = useAuthStore((state) => state.session?.access_token);
  const myId = useAuthStore((state) => state.user?.id);
  const watermark = useBillingStore((state) => state.status?.watermark ?? true);
  const [profile, setProfile] = useState<UserProfileResponse | null>(null);
  const [incoming, setIncoming] = useState<FriendRequest[]>([]);
  const [outgoing, setOutgoing] = useState<FriendRequest[]>([]);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openClip, setOpenClip] = useState<PublicClipCard | null>(null);

  async function load() {
    const next = await fetchUserProfile(token, username);
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
    <>
      <PageHeader title={missing ? "Profile unavailable" : name} subtitle={missing ? "That account was not found." : profile?.user.bio || undefined} />
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
                <p className="muted">
                  {formatCount(profile.user.clipCount)} public clips
                  {mine ? " · This is you" : ""}
                </p>
                {error ? <p className="error-text">{error}</p> : null}
                <div className="row">
                  {mine ? (
                    <Link className="btn" to="/profile">
                      Account
                    </Link>
                  ) : !token ? (
                    <Link className="btn primary" to="/profile">
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
          </section>

          <PageHeader title="Public clips" />
          {profile.clips.length === 0 ? (
            <section className="panel">
              <p className="muted">Only public uploads show here. Unlisted links stay off this profile.</p>
            </section>
          ) : (
            <div className="explore-grid">
              {profile.clips.map((clip) => (
                <article key={clip.id} className="feed-card">
                  <div className="feed-card-head">
                    <strong>{formatHandle(clip.author)}</strong>
                    <span className="muted">{clip.game?.name || "Public"}</span>
                  </div>
                  <button className="clip-open" type="button" onClick={() => setOpenClip(clip)}>
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
          )}
        </>
      ) : null}
      {openClip ? (
        <div className="player-overlay" role="dialog" aria-modal="true" aria-label={openClip.title || "Public clip"}>
          <button type="button" className="player-backdrop" aria-label="Close" onClick={() => setOpenClip(null)} />
          <section className="player-card">
            <div className="player-stage">
              {openClip.playbackUrl ? (
                <PlayerVideo showWatermark={watermark}>
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
