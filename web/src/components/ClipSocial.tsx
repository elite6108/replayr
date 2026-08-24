import { FormEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { SendClipSheet } from "./SendClipSheet";
import {
  deleteClipComment,
  fetchClipComments,
  postClipComment,
  setClipLiked,
  type ClipComment,
} from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatCount, formatHandle } from "../lib/format";

export function ClipSocial({
  slug,
  publicClip,
  liked: likedProp,
  likeCount: likeCountProp,
  commentCount: commentCountProp,
}: {
  slug: string;
  publicClip: boolean;
  liked?: boolean;
  likeCount?: number;
  commentCount?: number;
}) {
  const { session } = useAuth();
  const token = session?.access_token;
  const [liked, setLiked] = useState(Boolean(likedProp));
  const [likeCount, setLikeCount] = useState(likeCountProp ?? 0);
  const [commentCount, setCommentCount] = useState(commentCountProp ?? 0);
  const [comments, setComments] = useState<ClipComment[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);

  useEffect(() => {
    setLiked(Boolean(likedProp));
    setLikeCount(likeCountProp ?? 0);
    setCommentCount(commentCountProp ?? 0);
  }, [likedProp, likeCountProp, commentCountProp]);

  useEffect(() => {
    if (!publicClip) return;
    let cancelled = false;
    void fetchClipComments(slug, token)
      .then((next) => {
        if (!cancelled) setComments(next);
      })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load comments.");
      });
    return () => {
      cancelled = true;
    };
  }, [slug, token, publicClip]);

  async function toggleLike() {
    if (!token) return;
    const next = !liked;
    setLiked(next);
    setLikeCount((count) => Math.max(0, count + (next ? 1 : -1)));
    try {
      const result = await setClipLiked(slug, next, token);
      setLiked(result.liked);
      setLikeCount(result.likeCount);
    } catch (caught) {
      setLiked(!next);
      setLikeCount((count) => Math.max(0, count + (next ? -1 : 1)));
      setError(caught instanceof Error ? caught.message : "Could not update that like.");
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!token) return;
    const body = draft.trim();
    if (!body) return;
    setBusy(true);
    setError(null);
    try {
      const next = await postClipComment(slug, body, token);
      setComments(next.comments);
      setCommentCount(next.commentCount);
      setDraft("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not post that comment.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(comment: ClipComment) {
    if (!token) return;
    try {
      const next = await deleteClipComment(slug, comment.id, token);
      setComments((current) => current.filter((item) => item.id !== comment.id));
      setCommentCount(next.commentCount);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not delete that comment.");
    }
  }

  return (
    <section className="clip-social">
      <div className="clip-social-actions">
        {publicClip ? (
          token ? (
            <button className={`btn ${liked ? "liked" : ""}`} type="button" onClick={() => void toggleLike()}>
              {liked ? "Liked" : "Like"} · {formatCount(likeCount)}
            </button>
          ) : (
            <Link className="btn" to="/signin">
              Like · {formatCount(likeCount)}
            </Link>
          )
        ) : null}
        {token ? (
          <button className="btn" type="button" onClick={() => setSendOpen(true)}>
            Send
          </button>
        ) : (
          <Link className="btn" to="/signin">
            Send
          </Link>
        )}
        {publicClip ? <span className="muted">{formatCount(commentCount)} comments</span> : null}
      </div>
      {error ? <p className="error">{error}</p> : null}
      {publicClip ? (
        <>
          <ul className="comment-list">
            {comments.map((comment) => (
              <li key={comment.id}>
                <strong>{formatHandle(comment.author)}</strong>
                <span>{comment.body}</span>
                {comment.canDelete ? (
                  <button className="btn ghost" type="button" onClick={() => void remove(comment)}>
                    Delete
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
          {token ? (
            <form className="comment-form" onSubmit={(event) => void submit(event)}>
              <input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                maxLength={500}
                placeholder="Add a comment"
                aria-label="Add a comment"
              />
              <button className="btn" type="submit" disabled={busy || !draft.trim()}>
                {busy ? "Posting…" : "Comment"}
              </button>
            </form>
          ) : (
            <p className="muted">
              <Link to="/signin">Sign in</Link> to like or comment. Share links stay <code>/c/…</code> — no username in the
              URL.
            </p>
          )}
        </>
      ) : null}
      {sendOpen ? <SendClipSheet slug={slug} onClose={() => setSendOpen(false)} /> : null}
    </section>
  );
}
