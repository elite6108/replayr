import { FormEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Seo } from "../components/Seo";
import { useAuth } from "../lib/auth";
import { getSupabase, supabaseConfigured } from "../lib/supabase";

interface ApplicationRow {
  display_name: string;
  channel_url: string;
  created_at: string;
}

export function CreatorsPage() {
  const { session } = useAuth();
  const [existing, setExisting] = useState<ApplicationRow | null | undefined>(undefined);
  const [displayName, setDisplayName] = useState("");
  const [channelUrl, setChannelUrl] = useState("");
  const [game, setGame] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!session?.user || !supabaseConfigured()) {
      setExisting(null);
      return;
    }
    let cancelled = false;
    setExisting(undefined);
    void getSupabase()
      .from("creator_applications")
      .select("display_name, channel_url, created_at")
      .eq("user_id", session.user.id)
      .maybeSingle()
      .then(({ data, error: next }) => {
        if (cancelled) return;
        if (next) {
          setExisting(null);
          return;
        }
        setExisting((data as ApplicationRow) ?? null);
      });
    return () => {
      cancelled = true;
    };
  }, [session?.user.id]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!session?.user) return;
    setBusy(true);
    setError(null);
    const { error: next } = await getSupabase().from("creator_applications").insert({
      user_id: session.user.id,
      display_name: displayName.trim(),
      channel_url: channelUrl.trim(),
      game: game.trim() || null,
      note: note.trim() || null,
    });
    setBusy(false);
    if (next) {
      setError(next.message);
      return;
    }
    setExisting({ display_name: displayName.trim(), channel_url: channelUrl.trim(), created_at: new Date().toISOString() });
  }

  return (
    <main className="page marketing">
      <Seo
        title="Creators — Replayr"
        description="Creator program for Replayr. Featured players will be real. Apply with a public channel."
      />
      <p className="eyebrow">Creators</p>
      <h1>Build with Replay, not a fake logo wall.</h1>
      <p className="lede">
        We will only feature people who actually clip with the Windows app. Until then this grid stays empty on purpose.
      </p>

      <section className="section">
        <h2 className="section-title">Featured</h2>
        <div className="featured-empty card">
          <p>No featured creators yet. When someone ships real gameplay with Replay in public, they belong here — not gray placeholders.</p>
        </div>
      </section>

      <section className="section grid2">
        <article className="card">
          <h2>What you get later</h2>
          <ul className="plain">
            <li>A featured slot on this page</li>
            <li>Early Windows builds</li>
            <li>Pro cloud storage when payments exist</li>
          </ul>
        </article>
        <article className="card">
          <h2>What we want</h2>
          <ul className="plain">
            <li>Real gameplay, not a scripted ad</li>
            <li>A public channel we can link</li>
            <li>Honest talk about local files vs cloud copies</li>
          </ul>
        </article>
      </section>

      <section className="section">
        <h2 className="section-title">Apply</h2>
        {session === undefined ? (
          <p className="muted">Loading…</p>
        ) : !session ? (
          <p>
            <Link className="btn primary" to="/signin">
              Sign in to apply
            </Link>
          </p>
        ) : existing === undefined ? (
          <p className="muted">Loading…</p>
        ) : existing ? (
          <p className="muted">
            We have your application for {existing.display_name}. Channel: {existing.channel_url}
          </p>
        ) : (
          <form className="stack apply-form" onSubmit={(event) => void onSubmit(event)}>
            <label className="field">
              Name
              <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} required maxLength={80} />
            </label>
            <label className="field">
              Channel URL
              <input
                type="url"
                value={channelUrl}
                onChange={(event) => setChannelUrl(event.target.value)}
                required
                placeholder="https://"
              />
            </label>
            <label className="field">
              Game you clip
              <input value={game} onChange={(event) => setGame(event.target.value)} maxLength={80} />
            </label>
            <label className="field">
              Note
              <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={4} maxLength={1000} />
            </label>
            {error ? <p className="error">{error}</p> : null}
            <button className="btn primary" type="submit" disabled={busy}>
              Submit application
            </button>
          </form>
        )}
      </section>
    </main>
  );
}
