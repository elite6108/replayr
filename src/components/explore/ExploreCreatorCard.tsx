import { formatCount, formatDuration, formatHandle } from "../../utils/format";
import type { PublicFeedClip } from "../../services/social";

export function ExploreCreatorCard({
  clip,
  onOpen,
  onLike,
}: {
  clip: PublicFeedClip;
  onOpen: () => void;
  onLike: () => void;
}) {
  return (
    <article className="creator-card">
      <button className="creator-card-media" type="button" onClick={onOpen}>
        {clip.thumbnailUrl ? <img src={clip.thumbnailUrl} alt="" /> : <div className="feed-thumb-empty" />}
        {clip.durationMs ? <span className="clip-duration">{formatDuration(clip.durationMs)}</span> : null}
      </button>
      <div className="creator-card-meta">
        <strong>{formatHandle(clip.author)}</strong>
        <p>{clip.title || "Untitled clip"}</p>
        <div className="row">
          <button className={`btn sm ${clip.liked ? "liked" : ""}`} type="button" onClick={onLike}>
            {formatCount(clip.likeCount)} likes
          </button>
          <button className="btn sm" type="button" onClick={onOpen}>
            {formatCount(clip.commentCount)} comments
          </button>
        </div>
      </div>
    </article>
  );
}
