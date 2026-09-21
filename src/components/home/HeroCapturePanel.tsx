import { Link } from "react-router-dom";
import { IconFit } from "../icons";
import { displayHotkey, formatDuration } from "../../utils/format";
import { useDetectionStore } from "../../stores/detectionStore";
import { useRecordingStore } from "../../stores/recordingStore";
import { useScreenshotStore } from "../../stores/screenshotStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useToastStore } from "../../stores/toastStore";
import type { AppSettings, ReplayDurationSeconds } from "../../types/settings";

const REPLAY_LENGTHS: { value: ReplayDurationSeconds; label: string }[] = [
  { value: 15, label: "15s" },
  { value: 30, label: "30s" },
  { value: 45, label: "45s" },
  { value: 60, label: "1 min" },
  { value: 90, label: "90s" },
  { value: 120, label: "2 min" },
  { value: 180, label: "3 min" },
  { value: 300, label: "5 min" },
];

function clock(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function replayShort(seconds: number) {
  return seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds}s`;
}

function axisLabel(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes > 0 && rest === 0) return `-${minutes}:00`;
  if (minutes > 0) return `-${minutes}:${String(rest).padStart(2, "0")}`;
  return `-${seconds}s`;
}

export function HeroCapturePanel() {
  const snapshot = useDetectionStore((state) => state.snapshot);
  const catalog = useDetectionStore((state) => state.catalog);
  const settings = useSettingsStore((state) => state.settings);
  const updateSettings = useSettingsStore((state) => state.update);
  const showToast = useToastStore((state) => state.show);
  const status = useRecordingStore((state) => state.status);
  const replay = useRecordingStore((state) => state.replay);
  const busy = useRecordingStore((state) => state.busy);
  const start = useRecordingStore((state) => state.start);
  const stop = useRecordingStore((state) => state.stop);
  const saveClip = useRecordingStore((state) => state.saveClip);
  const takeScreenshot = useScreenshotStore((state) => state.take);
  const detected = Boolean(snapshot.name);
  const cover = catalog.find((game) => game.slug === snapshot.slug)?.coverUrl;
  const bufferReady = replay.active && replay.bufferedMs >= 400;
  const saving = busy || replay.saving;
  const durationMs = replay.active ? replay.durationMs : settings.replayDurationSeconds * 1000;
  const bufferPct = durationMs > 0 ? Math.min(100, ((replay.active ? replay.bufferedMs : 0) / durationMs) * 100) : 0;
  const ticks = 36;
  const filled = Math.round((bufferPct / 100) * ticks);
  const savePlace = settings.saveLocation?.trim() || "This PC";
  const captureLabel = replay.saving ? "Saving…" : `Capture last ${replayShort(settings.replayDurationSeconds)}`;
  const span = Math.max(15, settings.replayDurationSeconds);

  async function saveSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    try {
      await updateSettings(key, value);
      showToast("Settings saved");
    } catch (caught) {
      showToast(caught instanceof Error ? caught.message : "Could not save that setting.");
    }
  }

  return (
    <section className="home-hero">
      <article className={`hero-session ${detected ? "live" : "idle"}`}>
        {cover ? <img className="hero-session-art" src={cover} alt="" /> : null}
        <div className="hero-session-shade" />
        <div className="hero-session-top">
          <p className="hero-session-kicker">
            <span className={`pip ${detected || replay.active || status.active ? "on" : ""}`} />
            Live Session
          </p>
          {detected || status.active || replay.active ? (
            <span className="hero-session-clock">{clock(status.active ? status.durationMs : replay.bufferedMs)}</span>
          ) : null}
        </div>
        <div className="hero-session-copy">
          {detected ? <span className="hero-session-flag">Game detected</span> : null}
          <h2>{detected ? snapshot.name : "Ready when you are."}</h2>
          <p className="hero-session-lead">
            {detected
              ? "You’re in the game. We’re on the highlights."
              : "Launch a supported game and Replayr will start buffering automatically."}
          </p>
          <div className="hero-session-meta">
            {settings.resolution !== "auto" && settings.resolution !== "native" ? <span>{settings.resolution}</span> : null}
            <span>{settings.fps} FPS</span>
            <span>{settings.gameAudioEnabled ? "Game audio" : "Game audio off"}</span>
            <span>{settings.micEnabled ? "Mic on" : "Mic off"}</span>
          </div>
        </div>
        <Link className="hero-session-orb" to="/record" title="Open Capture" aria-label="Open Capture">
          <IconFit size={12} />
        </Link>
      </article>

      <aside className="hero-replay-card">
        <div className="hero-replay-head">
          <h2>Instant Replay</h2>
          <span className={`hero-replay-state ${replay.active ? "on" : ""}`}>
            <span className="pip" />
            {replay.active ? "Buffer ready" : "Standby"}
          </span>
        </div>
        <div className="hero-replay-clock">
          <strong>
            {clock(durationMs)}
            <em>{replay.active ? "always rolling" : "standby"}</em>
          </strong>
          <select
            className="hero-replay-length"
            aria-label="Replay length"
            value={settings.replayDurationSeconds}
            onChange={(event) => void saveSetting("replayDurationSeconds", Number(event.target.value) as ReplayDurationSeconds)}
          >
            {REPLAY_LENGTHS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </div>
        <div className="hero-replay-timeline">
          <div className="hero-replay-ticks" aria-hidden="true">
            {Array.from({ length: ticks }, (_, index) => (
              <span key={index} className={index < filled ? "on" : ""} />
            ))}
          </div>
          <div className="hero-replay-axis">
            <span>{axisLabel(span)}</span>
            <span>{axisLabel(Math.round((span * 2) / 3))}</span>
            <span>{axisLabel(Math.round(span / 3))}</span>
            <span>NOW</span>
          </div>
        </div>
        <button
          type="button"
          className="btn primary lg hero-replay-cta"
          disabled={saving || !bufferReady}
          title={bufferReady ? "Save Instant Replay" : "Instant Replay is still filling"}
          onClick={() => void saveClip()}
        >
          {captureLabel}
          <kbd>{displayHotkey(settings.hotkeys.saveReplay)}</kbd>
        </button>
        <div className="hero-replay-secondary">
          <button type="button" className="hero-replay-ghost" disabled={saving} onClick={() => void (status.active ? stop() : start())}>
            {status.active ? "Stop" : "Record"}
            <span>{displayHotkey(settings.hotkeys.toggleRecording)}</span>
          </button>
          <button
            type="button"
            className="hero-replay-ghost"
            title="Drag to capture any part of your screen"
            onClick={() => void takeScreenshot()}
          >
            Screenshot
            <span>{displayHotkey(settings.hotkeys.regionScreenshot)}</span>
          </button>
        </div>
        <p className="hero-replay-help muted">
          {status.active
            ? `Recording ${formatDuration(status.durationMs)} · Saving to ${savePlace}`
            : `Saving to ${savePlace} · Private by default`}
        </p>
      </aside>
    </section>
  );
}
