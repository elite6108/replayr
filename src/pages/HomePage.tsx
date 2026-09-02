import { Link, useNavigate } from "react-router-dom";
import { ClipCard } from "../components/common/ClipCard";
import { ClipGrid } from "../components/common/ClipGrid";
import { ClipRail } from "../components/common/ClipRail";
import { HeroCapturePanel } from "../components/home/HeroCapturePanel";
import { HomePeopleSearch } from "../components/home/HomePeopleSearch";
import { StatCard } from "../components/ui/StatCard";
import { fetchPublicFeed } from "../services/social";
import type { PublicFeedClip } from "../services/social";
import { useAuthStore } from "../stores/authStore";
import { useLibraryStore } from "../stores/libraryStore";
import { useRecordingStore } from "../stores/recordingStore";
import { formatBytes, formatCount, formatDuration, formatHandle } from "../utils/format";
import { useEffect, useState } from "react";

export function HomePage() {
  const navigate = useNavigate();
  const user = useAuthStore((state) => state.user);
  const profile = useAuthStore((state) => state.profile);
  const storage = useAuthStore((state) => state.storage);
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
  const recentClips = clips.slice(0, 8);
  const used = storage?.storage_used_bytes ?? 0;
  const limit = storage?.storage_limit_bytes ?? 0;
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const name = profile?.display_name || profile?.username || user?.email?.split("@")[0];
  const token = useAuthStore((state) => state.session?.access_token);
  const [feed, setFeed] = useState<PublicFeedClip[]>([]);

  useEffect(() => {
    void fetchPublicFeed(token)
      .then(setFeed)
      .catch(() => undefined);
  }, [token]);

  return (
    <div className="home-command">
      <header className="home-greeting">
        <div>
          <p className="eyebrow">Command center</p>
        </div>
        {user ? <HomePeopleSearch /> : null}
      </header>

      <HeroCapturePanel name={name} />

      <div className="home-stat-row">
        <StatCard
          title="Capture"
          live={recording.active || replay.active}
          value={
            recording.active
              ? formatDuration(recording.durationMs)
              : replay.active
                ? formatDuration(replay.bufferedMs)
                : "Standby"
          }
          body={
            recording.active
              ? "Writing a full session to disk."
              : replay.active
                ? `${formatDuration(replay.durationMs)} Instant Replay buffer.`
                : "Launch a game and the buffer starts filling."
          }
          action={
            <Link className="btn" to="/record">
              Open record
            </Link>
          }
        />
        <StatCard
          title="Library"
          value={clips.length}
          body="Clips saved on this PC."
          action={
            <Link className="btn ghost" to="/library">
              Open
            </Link>
          }
        />
        <StatCard
          title="Account"
          value={user ? profile?.display_name || profile?.username || "Signed in" : "Guest"}
          body={
            user
              ? storage
                ? `${formatBytes(used)} of ${formatBytes(limit)} cloud`
                : user.email
              : "Capture works offline. Sign in only when you want a cloud copy."
          }
          action={
            <>
              {user && storage ? (
                <div className="meter" aria-label="Cloud storage used">
                  <span style={{ width: `${pct}%` }} />
                </div>
              ) : null}
              <Link className="btn ghost" to="/profile">
                {user ? "Edit" : "Sign in"}
              </Link>
            </>
          }
        />
      </div>

      {recentClips.length === 0 ? (
        <section className="panel">
          <ClipGrid title="Your first clip lands here" body="Save an Instant Replay from the top bar or start a full recording. Finished files stay on this PC." />
        </section>
      ) : (
        <ClipRail
          title="Recent highlights"
          action={
            <Link className="btn ghost" to="/library">
              {selected.length > 0 ? `${selected.length} selected · View all` : "View all"}
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
  );
}
