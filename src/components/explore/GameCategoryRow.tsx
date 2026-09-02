import { Link } from "react-router-dom";
import { GameCover } from "../common/GameCover";
import { SectionHeader } from "../ui/SectionHeader";

export function GameCategoryRow({
  games,
}: {
  games: { slug: string; name: string; coverUrl: string | null; clipCount: number }[];
}) {
  if (games.length === 0) return null;
  return (
    <section>
      <SectionHeader title="Trending games" action={<Link className="btn ghost" to="/games">All games</Link>} />
      <div className="game-category-row">
        {games.map((game) => (
          <Link key={game.slug} className="game-category-card" to={`/games/${game.slug}`}>
            <GameCover name={game.name} coverUrl={game.coverUrl} />
            <strong>{game.name}</strong>
            <span className="muted">{game.clipCount} clips</span>
          </Link>
        ))}
      </div>
    </section>
  );
}
