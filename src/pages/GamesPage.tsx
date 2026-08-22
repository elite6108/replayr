import { FormEvent, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { GameCover } from "../components/common/GameCover";
import { EmptyState } from "../components/common/EmptyState";
import { PageHeader } from "../components/common/PageHeader";
import { IconGames } from "../components/icons";
import { useDetectionStore } from "../stores/detectionStore";

export function GamesPage() {
  const catalog = useDetectionStore((state) => state.catalog);
  const ready = useDetectionStore((state) => state.ready);
  const error = useDetectionStore((state) => state.error);
  const [query, setQuery] = useState("");

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const games = [...catalog].sort((a, b) => a.name.localeCompare(b.name));
    if (!needle) return games;
    return games.filter((game) => `${game.name} ${game.publisher ?? ""} ${game.slug}`.toLowerCase().includes(needle));
  }, [catalog, query]);

  return (
    <>
      <PageHeader title="Games" subtitle="Cover art from the catalog. Open a title to watch public clips from other players.">
        <form className="games-search" onSubmit={(event: FormEvent) => event.preventDefault()} role="search">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search games"
            aria-label="Search games"
          />
        </form>
      </PageHeader>

      {error ? <p className="error-text">{error}</p> : null}

      {!ready && catalog.length === 0 ? <p className="muted">Loading games…</p> : null}

      {ready && catalog.length === 0 ? (
        <section className="panel">
          <EmptyState
            icon={<IconGames size={26} />}
            title="No games in the catalog"
            body="The local catalog is empty. Sign in so Replayr can sync titles and covers from the cloud."
          />
        </section>
      ) : null}

      {catalog.length > 0 && visible.length === 0 ? <p className="muted">No games match that search.</p> : null}

      {visible.length > 0 ? (
        <ul className="game-grid">
          {visible.map((game) => (
            <li key={game.slug}>
              <Link className="game-card" to={`/games/${game.slug}`}>
                <GameCover name={game.name} coverUrl={game.coverUrl} />
                <div className="game-card-meta">
                  <strong>{game.name}</strong>
                  <span className="muted">{game.publisher || "Game"}</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}
