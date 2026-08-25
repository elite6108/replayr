import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ClipCard } from "../components/common/ClipCard";
import { ClipGrid } from "../components/common/ClipGrid";
import { ClipRail } from "../components/common/ClipRail";
import { DetectedGamePanel } from "../components/common/DetectedGamePanel";
import { SocialAvatar } from "../components/common/SocialAvatar";
import { IconSearch } from "../components/icons";
import { searchUsers } from "../services/api.friends";
import { fetchPublicFeed, type PublicFeedClip } from "../services/social";
import type { Relationship, SocialUser } from "../services/social-types";
import { useAuthStore } from "../stores/authStore";
import { useDetectionStore } from "../stores/detectionStore";
import { useLibraryStore } from "../stores/libraryStore";
import { useRecordingStore } from "../stores/recordingStore";
import { formatBytes, formatCount, formatDuration, formatHandle } from "../utils/format";

export function HomePage() {
  const navigate = useNavigate();
  const user = useAuthStore((state) => state.user);
  const profile = useAuthStore((state) => state.profile);
  const storage = useAuthStore((state) => state.storage);
  const snapshot = useDetectionStore((state) => state.snapshot);
  const clips = useLibraryStore((state) => state.clips);
  const play = useLibraryStore((state) => state.play);
  const favorite = useLibraryStore((state) => state.favorite);
  const upload = useLibraryStore((state) => state.upload);
  const rename = useLibraryStore((state) => state.rename);
  const remove = useLibraryStore((state) => state.remove);
  const download = useLibraryStore((state) => state.download);
  const copyLink = useLibraryStore((state) => state.copyLink);
  const removeFromCloud = useLibraryStore((state) => state.removeFromCloud);
  const toggleSelect = useLibraryStore((state) => state.toggleSelect);
  const selected = useLibraryStore((state) => state.selectedIds);
  const replay = useRecordingStore((state) => state.replay);
  const recording = useRecordingStore((state) => state.status);
  const recentClips = clips.slice(0, 10);
  const used = storage?.storage_used_bytes ?? 0;
  const limit = storage?.storage_limit_bytes ?? 0;
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const name = profile?.display_name || profile?.username || user?.email?.split("@")[0];
  const running = snapshot.running.filter((game) => game.slug !== snapshot.slug);
  const token = useAuthStore((state) => state.session?.access_token);
  const [feed, setFeed] = useState<PublicFeedClip[]>([]);

  useEffect(() => {
    void fetchPublicFeed(token)
      .then(setFeed)
      .catch(() => undefined);
  }, [token]);

  return (
    <div className="home-layout">
      <div className="home-main">
        <header className="home-greeting">
          <div>
            <p className="eyebrow">{snapshot.name ? "In session" : "Home"}</p>
            <h1>{name ? `Hey, ${name}` : "Ready to clip"}</h1>
          </div>
          {user ? <HomePeopleSearch /> : null}
        </header>

        <DetectedGamePanel snapshot={snapshot} />

        {recentClips.length === 0 ? (
          <section className="panel">
            <ClipGrid title="Your first clip lands here" body="Save an Instant Replay from the top bar or start a full recording. Finished files stay on this PC." />
          </section>
        ) : (
          <ClipRail
            title="Recent clips"
            action={
              <Link className="btn ghost" to="/library">
                {selected.length > 0 ? `${selected.length} selected · Open library` : "Open library"}
              </Link>
            }
          >
            {recentClips.map((clip) => (
              <ClipCard
                key={clip.localId}
                clip={clip}
                selected={selected.includes(clip.localId)}
                onPlay={(item) => play(item.localId)}
                onFavorite={(item) => void favorite(item.localId, !item.favorite)}
                onUpload={user ? (item) => void upload(item.localId) : undefined}
                onSelect={(item) => toggleSelect(item.localId)}
                onRename={(item, title) => void rename(item.localId, title)}
                  onDelete={(item) => {
                    if (window.confirm("Delete this clip from this PC and the cloud?")) void remove(item.localId);
                  }}
                  onRemoveFromCloud={(item) => {
                    if (
                      window.confirm(
                        "Remove this cloud copy? The file on this PC stays. The share link will stop working.",
                      )
                    ) {
                      void removeFromCloud(item.localId);
                    }
                  }}
                  onDownload={(item) => void download(item.localId)}
                onCopyLink={(item) => void copyLink(item.localId)}
                onEdit={(item) => navigate(`/editor/${item.localId}`)}
              />
            ))}
          </ClipRail>
        )}

        {feed.length > 0 ? (
          <ClipRail
            title="For You"
            action={
              <Link className="btn ghost" to="/explore">
                See all
              </Link>
            }
          >
            {feed.slice(0, 8).map((clip) => (
              <Link key={clip.id} className="feed-home-card" to="/explore">
                {clip.thumbnailUrl ? <img src={clip.thumbnailUrl} alt="" loading="lazy" /> : <div className="feed-thumb-empty" />}
                <strong>{clip.title || "Untitled clip"}</strong>
                <span className="muted">
                  {formatHandle(clip.author)} · {formatCount(clip.likeCount)} likes
                </span>
              </Link>
            ))}
          </ClipRail>
        ) : null}
      </div>

      <aside className="home-aside">
        <section className="panel widget">
          <div className="panel-head">
            <h2>Capture</h2>
            <span className={`badge ${recording.active || replay.active ? "live" : ""}`}>
              {recording.active ? "Recording" : replay.active ? "Replay" : "Idle"}
            </span>
          </div>
          {recording.active ? (
            <div className="stat-value">{formatDuration(recording.durationMs)}</div>
          ) : replay.active ? (
            <div className="stat-value">{formatDuration(replay.bufferedMs)}</div>
          ) : (
            <div className="stat-value">Standby</div>
          )}
          <p className="muted">
            {recording.active
              ? "Writing a full session to disk."
              : replay.active
                ? `${formatDuration(replay.durationMs)} Instant Replay buffer.`
                : "Launch a game and the buffer starts filling."}
          </p>
          <Link className="btn" to="/record">
            Open record
          </Link>
        </section>

        <section className="panel widget">
          <div className="panel-head">
            <h2>Library</h2>
            <Link className="btn ghost" to="/library">
              Open
            </Link>
          </div>
          <div className="stat-value">{clips.length}</div>
          <p className="muted">Clips saved on this PC.</p>
        </section>

        <section className="panel widget">
          <div className="panel-head">
            <h2>Account</h2>
            <Link className="btn ghost" to="/profile">
              {user ? "Edit" : "Sign in"}
            </Link>
          </div>
          {user ? (
            <>
              <div className="stat-value">{profile?.display_name || profile?.username || "Signed in"}</div>
              <p className="muted">{user.email}</p>
              {storage ? (
                <>
                  <p className="muted">
                    {formatBytes(used)} of {formatBytes(limit)} cloud
                  </p>
                  <div className="meter" aria-label="Cloud storage used">
                    <span style={{ width: `${pct}%` }} />
                  </div>
                </>
              ) : (
                <p className="muted">Storage appears after the profile loads.</p>
              )}
            </>
          ) : (
            <p className="muted">Capture works offline. Sign in only when you want a cloud copy.</p>
          )}
        </section>

        {running.length > 0 ? (
          <section className="panel widget">
            <h2>Also running</h2>
            {running.map((game) => (
              <p key={game.slug} className="muted">
                {game.name}
              </p>
            ))}
          </section>
        ) : null}
      </aside>
    </div>
  );
}

type SearchHit = SocialUser & { relationship: Relationship };

function HomePeopleSearch() {
  const token = useAuthStore((state) => state.session?.access_token);
  const navigate = useNavigate();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    const needle = query.replace(/^@/, "").trim();
    if (needle.length < 2) {
      setHits([]);
      return;
    }
    const handle = window.setTimeout(() => {
      void searchUsers(token, needle)
        .then((users) => {
          setHits(users);
          setOpen(true);
          setError(null);
        })
        .catch((caught) => setError(caught instanceof Error ? caught.message : "Could not search accounts."));
    }, 280);
    return () => window.clearTimeout(handle);
  }, [query, token]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  return (
    <div className="home-search" ref={wrapRef}>
      <form className="find-search" onSubmit={(event) => event.preventDefault()} role="search">
        <IconSearch size={16} />
        <input
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder="Search people"
          aria-label="Search people"
        />
      </form>
      {open && (query.trim().length >= 2 || error) ? (
        <div className="home-search-results">
          {error ? <p className="error-text">{error}</p> : null}
          {hits.length === 0 && !error ? <p className="muted">No accounts match that username.</p> : null}
          {hits.map((hit) => (
            <button
              key={hit.id}
              className="home-search-hit"
              type="button"
              onClick={() => {
                if (hit.username) navigate(`/u/${hit.username}`);
                setOpen(false);
                setQuery("");
              }}
            >
              <SocialAvatar person={hit} size="sm" />
              <span>
                <strong>{hit.displayName || hit.username || "Player"}</strong>
                <span className="muted">{hit.username ? `@${hit.username}` : "No username"}</span>
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
