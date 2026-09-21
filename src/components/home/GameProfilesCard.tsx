import { Link } from "react-router-dom";
import { useDetectionStore } from "../../stores/detectionStore";
import { useSettingsStore } from "../../stores/settingsStore";

function qualityLabel(resolution: string, fps: number) {
  if (resolution === "auto" || resolution === "native") return `${fps}p auto`;
  return `${resolution}${fps}`;
}

function replayLabel(seconds: number) {
  return seconds % 60 === 0 ? `${seconds / 60} min replay` : `${seconds}s replay`;
}

export function GameProfilesCard() {
  const snapshot = useDetectionStore((state) => state.snapshot);
  const catalog = useDetectionStore((state) => state.catalog);
  const settings = useSettingsStore((state) => state.settings);
  const detected = catalog.find((item) => item.slug === snapshot.slug);
  const game = detected ?? catalog[0] ?? (snapshot.name ? { name: snapshot.name, coverUrl: null, iconUrl: null } : null);
  const art = game?.iconUrl || game?.coverUrl;

  return (
    <article className="home-dash-card game-profiles-card">
      <div className="home-dash-head">
        <h2>Game profiles</h2>
        <span className="muted">Your settings. Remembered.</span>
      </div>
      {game ? (
        <Link className="home-dash-inner game-profile-row" to="/games">
          {art ? <img src={art} alt="" /> : <span className="game-profile-mark">{game.name.slice(0, 1)}</span>}
          <strong>{game.name}</strong>
          <span className="game-profile-meta">
            <span className="pip on" />
            {replayLabel(settings.replayDurationSeconds)} · {qualityLabel(settings.resolution, settings.fps)}
          </span>
          <span className="game-profile-chevron" aria-hidden="true">
            ›
          </span>
        </Link>
      ) : (
        <div className="home-dash-inner">
          <p className="muted last-session-empty">Settings remembered when a game is detected.</p>
        </div>
      )}
    </article>
  );
}
