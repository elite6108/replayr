import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ClipThumb } from "../components/ClipThumb";
import { GameCover } from "../components/GameCover";
import { Seo } from "../components/Seo";
import { useAuth } from "../lib/auth";
import { WINDOWS_DOWNLOAD_PATH } from "../lib/branding";
import { formatCount, formatDurationMs, formatHandle } from "../lib/format";
import { fetchGames, fetchPublicClips, type CatalogGame, type PublicClipCard } from "../lib/games";

export function HomePage() {
  const { session } = useAuth();
  const [games, setGames] = useState<CatalogGame[]>([]);
  const [clips, setClips] = useState<PublicClipCard[]>([]);

  useEffect(() => {
    void fetchGames()
      .then((next) => setGames(next.filter((game) => game.coverUrl).slice(0, 8)))
      .catch(() => undefined);
    void fetchPublicClips(session?.access_token)
      .then(setClips)
      .catch(() => undefined);
  }, [session?.access_token]);

  return (
    <main className="landing">
      <Seo
        title="Replayr — Windows gameplay clipper"
        description="The play already happened. Replayr keeps Instant Replay rolling on Windows, saves the clip on this PC, and shares a quiet unlisted link — no username in the URL."
      />

      <section className="landing-hero">
        <div className="landing-wrap landing-hero-grid">
          <div className="landing-hero-copy">
            <h1>Record and share your best gaming moments.</h1>
            <p className="lede">
              The play is already in the buffer. One hotkey saves it to this PC. Share only when you want — an unlisted
              link, no name attached.
            </p>
            <a className="btn glow" href={WINDOWS_DOWNLOAD_PATH}>
              Download and open Replayr
            </a>
            <p className="hero-note">Windows — download and open, no setup wizard</p>
          </div>
          <DesktopPreview />
        </div>
      </section>

      <section className="landing-stats">
        <div className="landing-wrap landing-stats-row">
          <div>
            <StatIcon kind="clip" />
            <div>
              <strong>Instant Replay</strong>
              <span>Last seconds, already captured</span>
            </div>
          </div>
          <div>
            <StatIcon kind="users" />
            <div>
              <strong>Local first</strong>
              <span>Library on this PC</span>
            </div>
          </div>
          <div>
            <StatIcon kind="pad" />
            <div>
              <strong>Game catalog</strong>
              <span>Titles Replayr can detect</span>
            </div>
          </div>
        </div>
      </section>

      <section className="landing-section">
        <div className="landing-wrap">
          <h2 className="landing-heading">Features</h2>
          <div className="feature-cards">
            <article className="feature-card">
              <span className="feature-icon" aria-hidden="true">
                <StatIcon kind="clock" />
              </span>
              <h3>Always ready</h3>
              <p>Instant Replay keeps a rolling buffer. One hotkey saves the play that already happened.</p>
              <div className="feature-shot buffer">
                <em>Buffer</em>
                <b>00:28</b>
                <span />
              </div>
            </article>
            <article className="feature-card">
              <span className="feature-icon" aria-hidden="true">
                <StatIcon kind="rocket" />
              </span>
              <h3>On the desktop</h3>
              <p>Capture, encoding, and Instant Replay run in the Windows app — not in this browser.</p>
              <div className="feature-shot session">
                <em>Capture</em>
                <b>Standby</b>
                <span />
              </div>
            </article>
            <article className="feature-card">
              <span className="feature-icon" aria-hidden="true">
                <StatIcon kind="share" />
              </span>
              <h3>Quiet sharing</h3>
              <p>Upload an unlisted copy and send `/c/…`. Public clips can appear on Games. Private stays owner-only.</p>
              <div className="feature-shot share">
                <em>Share</em>
                <b>/c/H7ks92L</b>
                <span />
              </div>
            </article>
          </div>
        </div>
      </section>

      <section className="landing-section">
        <div className="landing-wrap">
          <div className="landing-row">
            <h2 className="landing-heading flush">For You</h2>
            <Link className="btn" to="/explore">
              See all
            </Link>
          </div>
          {clips.length === 0 ? (
            <div className="empty-bubble">
              <h3>Nothing public yet</h3>
              <p className="muted">When someone uploads a clip and sets it to Public, it shows up here. Unlisted links never appear.</p>
            </div>
          ) : (
            <ul className="trending-rail">
              {clips.map((clip) => (
                <li key={clip.id}>
                  <Link className="trend-card" to={`/c/${clip.slug}`}>
                    <div className="clip-thumb">
                      <ClipThumb title={clip.title || "Clip"} thumbnailUrl={clip.thumbnailUrl} playbackUrl={null} />
                      {clip.durationMs ? <span className="clip-duration">{formatDurationMs(clip.durationMs)}</span> : null}
                    </div>
                    <strong>{clip.title || "Untitled clip"}</strong>
                    <span className="muted">{formatHandle(clip.author)}</span>
                    <span className="muted">
                      {formatCount(clip.likeCount)} likes · {formatCount(clip.commentCount)} comments
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {games.length > 0 ? (
        <section className="landing-section titles">
          <div className="landing-wrap">
            <ul className="title-strip">
              {games.map((game) => (
                <li key={game.id}>
                  <Link to={`/games/${game.slug}`} title={game.name}>
                    <GameCover name={game.name} coverUrl={game.coverUrl} />
                  </Link>
                </li>
              ))}
            </ul>
            <p className="title-caption">Supported titles from the Replayr catalog</p>
          </div>
        </section>
      ) : null}

      <section className="landing-cta">
        <div className="landing-wrap">
          <h2>Clip on the PC. Share a link when you want.</h2>
          <a className="btn glow" href={WINDOWS_DOWNLOAD_PATH}>
            Download and open Replayr
          </a>
        </div>
      </section>
    </main>
  );
}

function DesktopPreview() {
  return (
    <div className="app-preview" role="img" aria-label="Replayr desktop layout">
      <div className="app-preview-chrome">
        <span />
        <span />
        <span />
        <em>Replayr</em>
      </div>
      <div className="app-preview-body">
        <aside>
          <b>Home</b>
          <span>Library</span>
          <span>Games</span>
          <span>Record</span>
        </aside>
        <div>
          <p className="eyebrow">In session</p>
          <h3>Instant Replay is on</h3>
          <div className="preview-clips">
            <span />
            <span />
            <span />
          </div>
        </div>
      </div>
    </div>
  );
}

function StatIcon({ kind }: { kind: "clip" | "users" | "pad" | "clock" | "rocket" | "share" }) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      {kind === "clip" ? (
        <>
          <rect x="3" y="6" width="18" height="12" rx="2" />
          <path d="m10 10 5 2.5L10 15z" />
        </>
      ) : null}
      {kind === "users" ? (
        <>
          <circle cx="9" cy="8" r="3" />
          <path d="M4 19a5 5 0 0 1 10 0" />
          <circle cx="17" cy="9" r="2.2" />
        </>
      ) : null}
      {kind === "pad" ? (
        <path d="M6.5 16c-2 0-3.5-1.4-3.5-3.2C3 10.5 5 9 7.2 9.3c.6-2 2.4-3.3 4.8-3.3s4.2 1.3 4.8 3.3c2.2-.3 4.2 1.2 4.2 3.5 0 1.8-1.5 3.2-3.5 3.2z" />
      ) : null}
      {kind === "clock" ? (
        <>
          <circle cx="12" cy="12" r="8" />
          <path d="M12 8v4l3 2" />
        </>
      ) : null}
      {kind === "rocket" ? <path d="M14 4c3 1 6 5 6 9-4 0-8-3-9-6 0-1 .4-2.2 3-3zM8 14l2 2M5 19l3-1 4-4" /> : null}
      {kind === "share" ? <path d="M12 5v10M8 9l4-4 4 4M6 19h12" /> : null}
    </svg>
  );
}
