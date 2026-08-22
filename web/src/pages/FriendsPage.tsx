import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Seo } from "../components/Seo";
import { useAuth } from "../lib/auth";
import { formatDurationMs } from "../lib/format";
import { clipShareUrl, getSupabase } from "../lib/supabase";

interface ShareClip {
  id: string;
  title: string | null;
  slug: string;
  visibility: string;
  duration_ms: number | null;
}

export function FriendsPage() {
  const { session } = useAuth();
  const userId = session?.user.id ?? "";
  const [clips, setClips] = useState<ShareClip[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    void getSupabase()
      .from("clips")
      .select("id, title, slug, status, visibility, duration_ms, width, height, file_size_bytes, created_at")
      .eq("user_id", userId)
      .eq("status", "ready")
      .in("visibility", ["unlisted", "public"])
      .order("created_at", { ascending: false })
      .limit(8)
      .then(({ data }) => {
        if (!cancelled) setClips((data as ShareClip[]) ?? []);
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  async function copyLink(slug: string) {
    try {
      await navigator.clipboard.writeText(clipShareUrl(slug));
      setNotice("Link copied — they do not need an account to watch an unlisted clip.");
    } catch {
      setNotice(clipShareUrl(slug));
    }
  }

  return (
    <main className="page">
      <Seo title="Friends — Replayr" description="Share unlisted clip links. Follows come later." robots="noindex" />
      <h1>Share with people, not a feed</h1>
      <p className="lede">
        Send an unlisted link. The watcher does not need an account. Follows, friend requests, and activity ship in Phase
        8 — they are not on this page yet.
      </p>
      {notice ? <p className="muted">{notice}</p> : null}

      <section className="section">
        <h2 className="section-title">Copy a recent cloud clip</h2>
        {clips.length === 0 ? (
          <p className="muted">
            No ready cloud clips yet. Upload from the Windows app, then copy a link here or from{" "}
            <Link to="/library">Library</Link>.
          </p>
        ) : (
          <ul className="clip-list">
            {clips.map((clip) => (
              <li key={clip.id} className="clip-row">
                <div>
                  <Link to={`/c/${clip.slug}`}>{clip.title || "Untitled clip"}</Link>
                  <div className="muted">
                    {clip.visibility}
                    {clip.duration_ms ? ` · ${formatDurationMs(clip.duration_ms)}` : ""}
                  </div>
                </div>
                <button className="btn primary" type="button" onClick={() => void copyLink(clip.slug)}>
                  Copy link
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2>Follows come later</h2>
        <p className="muted">
          Requests, a friends list, and activity will wait for Phase 8. Until then, unlisted URLs are how you send a play
          to someone.
        </p>
      </section>
    </main>
  );
}
