import { Link } from "react-router-dom";
import { useDetectionStore } from "../../stores/detectionStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { IconCaretRight } from "../icons";

function qualityLabel(resolution: string, fps: number) {
  if (resolution === "auto") return `auto · ${fps} FPS`;
  if (resolution === "native") return `native · ${fps} FPS`;
  return `${resolution}${fps}`;
}

function replayLabel(seconds: number) {
  return seconds % 60 === 0 ? `${seconds / 60} min replay` : `${seconds}s replay`;
}

export function GameProfilesCard({ recentGameIds }: { recentGameIds: string[] }) {
  const snapshot = useDetectionStore((state) => state.snapshot);
  const catalog = useDetectionStore((state) => state.catalog);
  const settings = useSettingsStore((state) => state.settings);
  const detected = catalog.find((item) => item.slug === snapshot.slug);
  const games: typeof catalog = [];
  const addGame = (game: (typeof catalog)[number] | undefined) => {
    if (game && !games.some((item) => item.slug === game.slug)) games.push(game);
  };
  addGame(detected);
  recentGameIds.forEach((id) => addGame(catalog.find((item) => item.slug === id || item.cloudId === id)));
  catalog.forEach(addGame);
  games.splice(3);
  if (games.length === 0 && snapshot.name) {
    games.push({
      slug: snapshot.slug || "detected-game",
      cloudId: null,
      name: snapshot.name,
      publisher: snapshot.publisher,
      coverUrl: null,
      iconUrl: null,
      processNames: snapshot.processName ? [snapshot.processName] : [],
    });
  }

  return (
    <article className="home-dash-card game-profiles-card">
      <div className="home-dash-head">
        <h2>Game profiles</h2>
        <span className="muted">Your settings. Remembered.</span>
      </div>
      {games.length > 0 ? (
        <div className="home-dash-inner game-profile-list">
          {games.map((game) => {
            const art = game.iconUrl || game.coverUrl;
            const active = game.slug === snapshot.slug;
            return (
              <Link className="game-profile-row" to="/games" key={game.slug}>
                {art ? <img src={art} alt="" /> : <span className="game-profile-mark">{game.name.slice(0, 1)}</span>}
                <strong>{game.name}</strong>
                <span className="game-profile-meta">
                  {active ? <span className="pip on" /> : null}
                  {replayLabel(settings.replayDurationSeconds)} · {qualityLabel(settings.resolution, settings.fps)}
                </span>
                <IconCaretRight className="game-profile-chevron" size={13} />
              </Link>
            );
          })}
        </div>
      ) : (
        <div className="home-dash-inner">
          <p className="muted last-session-empty">Settings remembered when a game is detected.</p>
        </div>
      )}
    </article>
  );
}
