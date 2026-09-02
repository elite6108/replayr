import { useState } from "react";
import { Link } from "react-router-dom";
import { displayHotkey, formatDuration } from "../../utils/format";
import { useDetectionStore } from "../../stores/detectionStore";
import { useRecordingStore } from "../../stores/recordingStore";
import { useSettingsStore } from "../../stores/settingsStore";

const GREETINGS = [
  (name: string) => `Hey ${name}, did you clip it?`,
  (name: string) => `Hey ${name}, 3..2...1... ACTION!`,
  (name: string) => `Hey ${name}, press record!`,
  (name: string) => `Hey ${name}, lights, camera, clip.`,
  (name: string) => `Hey ${name}, that play isn't clipping itself.`,
  (name: string) => `Hey ${name}, ready to capture your moment?`,
];

const GREETINGS_ANON = [
  "Did you clip it?",
  "3..2...1... ACTION!",
  "Press record!",
  "Lights, camera, clip.",
  "That play isn't clipping itself.",
  "Ready to capture your moment?",
];

function clock(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function greetingFor(name: string | undefined, index: number) {
  if (name) {
    const make = GREETINGS[index % GREETINGS.length];
    return make ? make(name) : `Hey ${name}, ready to capture your moment?`;
  }
  return GREETINGS_ANON[index % GREETINGS_ANON.length] ?? "Ready to capture your moment?";
}

export function HeroCapturePanel({ name }: { name?: string }) {
  const [line] = useState(() => Math.floor(Math.random() * GREETINGS.length));
  const headline = greetingFor(name, line);
  const snapshot = useDetectionStore((state) => state.snapshot);
  const catalog = useDetectionStore((state) => state.catalog);
  const hotkeys = useSettingsStore((state) => state.settings.hotkeys);
  const status = useRecordingStore((state) => state.status);
  const replay = useRecordingStore((state) => state.replay);
  const busy = useRecordingStore((state) => state.busy);
  const start = useRecordingStore((state) => state.start);
  const stop = useRecordingStore((state) => state.stop);
  const saveClip = useRecordingStore((state) => state.saveClip);
  const detected = Boolean(snapshot.name);
  const cover = catalog.find((game) => game.slug === snapshot.slug)?.coverUrl;
  const bufferReady = replay.active && replay.bufferedMs >= 400;
  const saving = busy || replay.saving;
  const bufferPct = replay.durationMs > 0 ? Math.min(100, (replay.bufferedMs / replay.durationMs) * 100) : 0;

  return (
    <section className={`hero-capture ${detected ? "live" : "idle"}`}>
      {cover ? <img className="hero-capture-art" src={cover} alt="" /> : null}
      <div className="hero-capture-copy">
        <p className="eyebrow">{detected ? snapshot.name : "Ready when you are"}</p>
        <h1>{headline}</h1>
        <p className="muted">Instant capture. Cloud safe. Always yours.</p>
        <div className="row">
          <button
            type="button"
            className="btn primary"
            disabled={saving || !bufferReady}
            title={bufferReady ? "Save Instant Replay" : "Instant Replay is still filling"}
            onClick={() => void saveClip()}
          >
            {replay.saving ? "Saving…" : `Capture Clip  ${displayHotkey(hotkeys.saveReplay)}`}
          </button>
          <button type="button" className="btn" disabled={saving} onClick={() => void (status.active ? stop() : start())}>
            {status.active ? "Stop Recording" : "Record"}
          </button>
        </div>
        <Link className="hero-inline-link" to="/library">
          Open Library →
        </Link>
      </div>
      <aside className="hero-replay-card">
        <div className="panel-head">
          <h2>Instant Replay</h2>
          <span className={`badge ${replay.active ? "live" : ""}`}>{replay.active ? "ON" : "Idle"}</span>
        </div>
        <div
          className="hero-replay-ring"
          style={{ background: `conic-gradient(var(--accent) ${bufferPct}%, rgba(255,255,255,0.08) 0)` }}
          aria-hidden="true"
        >
          <div className="hero-replay-ring-inner">
            <strong>{replay.active ? clock(replay.bufferedMs) : "00:00"}</strong>
            <span>{replay.active ? "buffering" : "standby"}</span>
          </div>
        </div>
        <p className="muted">
          {status.active
            ? `Recording ${formatDuration(status.durationMs)}`
            : replay.active
              ? `${clock(replay.durationMs)} buffer`
              : "Launch a game and the buffer starts filling."}
        </p>
      </aside>
    </section>
  );
}
