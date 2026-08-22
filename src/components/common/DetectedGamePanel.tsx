import type { DetectedGameSnapshot } from "../../types/game";
import { displayHotkey } from "../../utils/format";
import { useSettingsStore } from "../../stores/settingsStore";
import { useRecordingStore } from "../../stores/recordingStore";

function formatDuration(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function DetectedGamePanel({
  snapshot,
  showControls = true,
}: {
  snapshot: DetectedGameSnapshot;
  showControls?: boolean;
}) {
  const hotkeys = useSettingsStore((state) => state.settings.hotkeys);
  const status = useRecordingStore((state) => state.status);
  const replay = useRecordingStore((state) => state.replay);
  const busy = useRecordingStore((state) => state.busy);
  const start = useRecordingStore((state) => state.start);
  const stop = useRecordingStore((state) => state.stop);
  const saveClip = useRecordingStore((state) => state.saveClip);
  const screenshot = useRecordingStore((state) => state.screenshot);
  const detected = Boolean(snapshot.name);
  const others = snapshot.running.filter((game) => game.slug !== snapshot.slug);
  const bufferReady = replay.active && replay.bufferedMs >= 400;
  const saving = busy || replay.saving;

  return (
    <section className={`panel hero ${detected ? "" : "idle"}`}>
      <div>
        <div className="hero-kicker">{detected ? "Detected game" : "Waiting for a game"}</div>
        <h2>{detected ? snapshot.name : "No game detected"}</h2>
        <div className="hero-meta">
          {detected ? (
            <>
              {snapshot.publisher ? `${snapshot.publisher} · ` : null}
              {snapshot.processName}
              {snapshot.focused ? " · focused" : " · running"}
              {others.length > 0 ? ` · also ${others.map((game) => game.name).join(", ")}` : null}
            </>
          ) : (
            "Launch a supported title, then save a clip or start a full recording."
          )}
        </div>
        {status.active ? (
          <div className="hero-status">
            <span className="badge live">Recording</span>
            {formatDuration(status.durationMs)}
            {status.target ? ` · ${status.target}` : null}
          </div>
        ) : replay.saving ? (
          <div className="hero-status">
            <span className="badge">Saving</span>
            Writing clip to your library…
          </div>
        ) : replay.active ? (
          <div className="hero-status">
            <span className="badge live">Replay</span>
            {formatDuration(replay.bufferedMs)} / {formatDuration(replay.durationMs)} buffered
          </div>
        ) : replay.diskBlocked ? (
          <div className="hero-status">
            <span className="badge">Disk</span>
            Not enough free space for Instant Replay.
          </div>
        ) : replay.error ? (
          <div className="hero-status">
            <span className="badge">Replay</span>
            {replay.error}
          </div>
        ) : null}
        {showControls ? (
          <div className="row">
            <button
              type="button"
              className="btn primary"
              disabled={saving || !bufferReady}
              title={replay.saving ? "Saving clip" : bufferReady ? "Save the last few seconds" : "Instant Replay is still filling"}
              onClick={() => void saveClip()}
            >
              {replay.saving ? "Saving…" : `Save Clip  ${displayHotkey(hotkeys.saveReplay)}`}
            </button>
            <button
              type="button"
              className="btn"
              disabled={saving}
              onClick={() => void (status.active ? stop() : start())}
            >
              {status.active ? "Stop Recording" : "Start Recording"}
            </button>
            <button type="button" className="btn" disabled={saving || (!replay.active && !status.active)} onClick={() => void screenshot()}>
              Screenshot
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
