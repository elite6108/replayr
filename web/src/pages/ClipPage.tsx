import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ClipSocial } from "../components/ClipSocial";
import { SendClipSheet } from "../components/SendClipSheet";
import { Seo } from "../components/Seo";
import { PlayerVideo } from "../components/ReplayrWatermark";
import { downloadCloudClip, fetchPlayback, type PlaybackClip } from "../lib/api";
import { fetchBillingStatus, type BillingStatus } from "../lib/billing";
import { useAuth } from "../lib/auth";
import { formatHandle } from "../lib/format";
import { getSupabase, supabaseConfigured } from "../lib/supabase";

export function ClipPage() {
  const { slug = "" } = useParams();
  const [clip, setClip] = useState<PlaybackClip | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const { session } = useAuth();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const token = supabaseConfigured()
          ? (await getSupabase().auth.getSession()).data.session?.access_token
          : undefined;
        const next = await fetchPlayback(slug, token);
        if (!cancelled) setClip(next);
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Clip unavailable");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  useEffect(() => {
    if (!session?.access_token) {
      setBilling(null);
      return;
    }
    void fetchBillingStatus(session.access_token).then(setBilling).catch(() => undefined);
  }, [session?.access_token]);

  const hidden = !clip || clip.visibility !== "public";
  const title = error ? "Clip unavailable" : clip ? `${clip.title || "Untitled clip"} · Replayr` : "Clip · Replayr";
  const description = error
    ? "This clip is not available."
    : clip
      ? "Watch a Replayr cloud clip."
      : "Loading clip.";

  return (
    <main className="page">
      <Seo title={title} description={description} robots={hidden ? "noindex,nofollow" : "index,follow"} />
      {error ? (
        <>
          <h1>Clip unavailable</h1>
          <p className="muted">{error}</p>
        </>
      ) : !clip ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <h1>{clip.title || "Untitled clip"}</h1>
          <p className="muted">
            {clip.visibility === "public" ? formatHandle(clip.author) : clip.visibility}
            {clip.width && clip.height ? ` · ${clip.width}×${clip.height}` : ""}
          </p>
          <div className="row" style={{ marginBottom: 16 }}>
            <button
              className="btn"
              type="button"
              disabled={downloading}
              onClick={() => {
                void (async () => {
                  setDownloading(true);
                  setError(null);
                  try {
                    const token = supabaseConfigured()
                      ? (await getSupabase().auth.getSession()).data.session?.access_token
                      : undefined;
                    await downloadCloudClip(clip.slug, clip.title, token);
                  } catch (caught) {
                    setError(caught instanceof Error ? caught.message : "Could not download that clip.");
                  } finally {
                    setDownloading(false);
                  }
                })();
              }}
            >
              {downloading ? "Downloading…" : "Download"}
            </button>
            {session ? (
              <button className="btn" type="button" onClick={() => setSendOpen(true)}>
                Send
              </button>
            ) : null}
          </div>
          <div className="player-stage">
            <PlayerVideo showWatermark={clip.watermark !== false}>
              <video className="player" src={clip.playbackUrl} controls playsInline autoPlay />
            </PlayerVideo>
          </div>
          {!session || billing?.ads ? (
            <aside className="house-ad">
              <strong>Replayr Premium</strong>
              <p className="muted">Remove the watermark and upload original quality for $4.99/mo.</p>
              <Link className="btn primary" to="/pricing">
                Upgrade
              </Link>
            </aside>
          ) : null}
          <ClipSocial
            slug={clip.slug}
            publicClip={clip.visibility === "public" || clip.visibility === "unlisted"}
            liked={clip.liked}
            likeCount={clip.likeCount}
            commentCount={clip.commentCount}
          />
          {sendOpen ? <SendClipSheet slug={clip.slug} onClose={() => setSendOpen(false)} /> : null}
        </>
      )}
    </main>
  );
}
