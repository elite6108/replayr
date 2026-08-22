import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Seo } from "../components/Seo";
import { GameCover } from "../components/GameCover";
import { fetchGames, type CatalogGame } from "../lib/games";

export function GamesPage() {
  const [games, setGames] = useState<CatalogGame[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchGames()
      .then((next) => {
        if (!cancelled) setGames(next);
      })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load games.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return games;
    return games.filter((game) => `${game.name} ${game.publisher ?? ""} ${game.slug}`.toLowerCase().includes(needle));
  }, [games, query]);

  return (
    <main className="page games-page">
      <Seo
        title="Games — Replayr"
        description="Browse supported games and watch public clips from other players. Unlisted clips never appear here."
      />
      <div className="library-head">
        <div>
          <p className="eyebrow">Public catalog</p>
          <h1>Games</h1>
          <p className="muted">Cover art from the catalog. Open a title to see public clips only.</p>
        </div>
        <form
          className="games-search"
          onSubmit={(event: FormEvent) => event.preventDefault()}
          role="search"
        >
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search games"
            aria-label="Search games"
          />
        </form>
      </div>
      {error ? <p className="error">{error}</p> : null}
      {games.length === 0 && !error ? <p className="muted">Loading games…</p> : null}
      {games.length > 0 && visible.length === 0 ? <p className="muted">No games match that search.</p> : null}
      <ul className="game-grid">
        {visible.map((game) => (
          <li key={game.id}>
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
    </main>
  );
}
