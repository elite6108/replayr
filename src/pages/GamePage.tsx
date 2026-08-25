import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { save } from "@tauri-apps/plugin-dialog";
import { clipShareUrl } from "../branding";
import { GameCover } from "../components/common/GameCover";
import { EmptyState } from "../components/common/EmptyState";
import { PageHeader } from "../components/common/PageHeader";
import { PlayerVideo } from "../components/common/ReplayrWatermark";
import { IconGames, IconPlay } from "../components/icons";
import { fetchPublicGameClips, type PublicGame, type PublicGameClip } from "../services/games";
import { downloadUrlToFile } from "../services/tauri";
import { useDetectionStore } from "../stores/detectionStore";
import { useToastStore } from "../stores/toastStore";
import { suggestedFileName } from "../utils/files";
import { formatDuration, invokeErrorMessage } from "../utils/format";

export function GamePage() {
  const { slug = "" } = useParams();
  const catalog = useDetectionStore((state) => state.catalog);
  const localGame = catalog.find((game) => game.slug === slug);
  const [game, setGame] = useState<PublicGame | null>(
    localGame
      ? {
          id: localGame.cloudId ?? localGame.slug,
          slug: localGame.slug,
          name: localGame.name,
          publisher: localGame.publisher,
          coverUrl: localGame.coverUrl,
        }
      : null,
  );
  const [clips, setClips] = useState<PublicGameClip[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [playing, setPlaying] = useState<PublicGameClip | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setPlaying(null);
    void fetchPublicGameClips(slug)
      .then((next) => {
        if (cancelled) return;
        setGame(next.game);
        setClips(next.clips);
        setLoading(false);
      })
      .catch((caught) => {
        if (cancelled) return;
        setError(caught instanceof Error ? caught.message : "Could not load this game.");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  useEffect(() => {
    if (!playing) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setPlaying(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [playing]);

  async function copyLink(clip: PublicGameClip) {
    try {
      await navigator.clipboard.writeText(clipShareUrl(clip.slug));
      useToastStore.getState().show("Link copied");
    } catch {
      useToastStore.getState().show("Could not copy link");
    }
  }

  async function download(clip: PublicGameClip) {
    if (!clip.playbackUrl) {
      useToastStore.getState().show("That clip is not ready to download");
      return;
    }
    try {
      const dest = await save({
        defaultPath: suggestedFileName(clip.title, "clip", "mp4"),
        title: "Download public clip",
      });
      if (!dest) return;
      await downloadUrlToFile(clip.playbackUrl, dest);
      useToastStore.getState().show("Saved to disk");
    } catch (caught) {
      useToastStore.getState().show(invokeErrorMessage(caught, "Could not download clip"));
    }
  }

  return (
    <>
      <PageHeader
        title={game?.name || localGame?.name || "Game"}
        subtitle="Public clips only. Unlisted and private uploads stay off this page."
      >
        <Link className="btn" to="/games">
          All games
        </Link>
      </PageHeader>

      {game ? (
        <section className="game-hero">
          <div className="game-hero-cover">
            <GameCover name={game.name} coverUrl={game.coverUrl} />
          </div>
          <div>
            <p className="eyebrow">{game.publisher || "Catalog"}</p>
            <h2>{game.name}</h2>
            <p className="muted">Clips other players set to Public for this title.</p>
          </div>
        </section>
      ) : null}

      {error ? <p className="error-text">{error}</p> : null}
      {loading ? <p className="muted">Loading public clips…</p> : null}

      {!loading && game && clips.length === 0 ? (
        <section className="panel">
          <EmptyState
            icon={<IconGames size={26} />}
            title="No public clips yet"
            body={`When someone uploads a ${game.name} clip and sets it to Public, it shows up here.`}
          />
        </section>
      ) : null}

      {clips.length > 0 ? (
        <div className="clip-grid">
          {clips.map((clip) => (
            <article key={clip.id} className="clip-card live">
              <button type="button" className="clip-open" onClick={() => setPlaying(clip)}>
                <div className="clip-thumb">
                  {clip.thumbnailUrl ? <img src={clip.thumbnailUrl} alt="" /> : null}
                  <div className="clip-play">
                    <span>
                      <IconPlay size={18} />
                    </span>
                  </div>
                  {clip.durationMs ? <span className="clip-duration">{formatDuration(clip.durationMs)}</span> : null}
                  <span className="clip-flag">Public</span>
                </div>
                <div className="clip-meta">
                  <strong>{clip.title || "Untitled clip"}</strong>
                </div>
              </button>
              <div className="row clip-card-actions">
                <button type="button" className="btn" onClick={() => void copyLink(clip)}>
                  Copy link
                </button>
                <button type="button" className="btn" onClick={() => void download(clip)}>
                  Download
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : null}

      {playing?.playbackUrl ? (
        <div className="player-overlay" role="dialog" aria-modal="true" aria-label={playing.title || "Public clip"}>
          <button type="button" className="player-backdrop" aria-label="Close player" onClick={() => setPlaying(null)} />
          <section className="player-card">
            <div className="player-stage">
              <PlayerVideo showWatermark={playing.watermark !== false}>
                <video src={playing.playbackUrl} controls autoPlay />
              </PlayerVideo>
            </div>
            <div className="player-side">
              <h2>{playing.title || "Untitled clip"}</h2>
              <p className="muted">{game?.name} · Public</p>
              <div className="row">
                <button type="button" className="btn" onClick={() => void copyLink(playing)}>
                  Copy link
                </button>
                <button type="button" className="btn" onClick={() => void download(playing)}>
                  Download
                </button>
                <button type="button" className="btn" onClick={() => setPlaying(null)}>
                  Close
                </button>
              </div>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
