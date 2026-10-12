import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  IconCamera,
  IconCheck,
  IconClock,
  IconFolder,
  IconLightning,
  IconLock,
  IconMic,
  IconMicOff,
  IconMonitor,
  IconRecordCircle,
  IconSliders,
  IconSpeaker,
  IconSpeakerOff,
} from "../icons";
import { displayHotkey } from "../../utils/format";
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

function sessionClock(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
}

function replayShort(seconds: number) {
  return seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} sec`;
}

function friendlySavePlace(value: string) {
  const parts = value
    .trim()
    .split(/[\\/]+/)
    .filter(Boolean);
  if (parts.length === 0) return "Videos / Replayr";
  return parts.slice(-2).join(" / ");
}

function resolutionLabel(value: AppSettings["resolution"]) {
  if (value === "auto") return "Auto";
  if (value === "native") return "Native";
  return value.toUpperCase();
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
  const sessionStartedAt = useDetectionStore((state) => state.sessionStartedAt);
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
  const savePlace = friendlySavePlace(settings.saveLocation || "");
  const captureLabel = replay.saving ? "Saving…" : `Capture last ${replayShort(settings.replayDurationSeconds)}`;
  const span = Math.max(15, settings.replayDurationSeconds);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!sessionStartedAt) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [sessionStartedAt]);

  const sessionElapsedMs = sessionStartedAt ? Math.max(0, now - sessionStartedAt) : 0;

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
          {detected && sessionStartedAt ? (
            <span className="hero-session-clock">
              <IconClock size={13} />
              {sessionClock(sessionElapsedMs)}
            </span>
          ) : null}
        </div>
        <div className="hero-session-copy">
          {detected ? (
            <span className="hero-session-flag">
              <IconCheck size={11} weight="bold" />
              Game detected
            </span>
          ) : null}
          <h2>{detected ? snapshot.name : "Ready when you are."}</h2>
          <p className="hero-session-lead">
            {detected
              ? "You’re in the game. We’re on the highlights."
              : "Launch a supported game and Replayr will start buffering automatically."}
          </p>
          <div className="hero-session-meta">
            <span>
              <IconMonitor size={13} />
              {resolutionLabel(settings.resolution)}
            </span>
            <span>
              <IconClock size={13} />
              {settings.fps} FPS
            </span>
            <span>
              {settings.gameAudioEnabled ? <IconSpeaker size={13} /> : <IconSpeakerOff size={13} />}
              {settings.gameAudioEnabled ? "Game audio" : "Game audio off"}
            </span>
            <span>
              {settings.micEnabled ? <IconMic size={13} /> : <IconMicOff size={13} />}
              {settings.micEnabled ? "Mic on" : "Mic off"}
            </span>
          </div>
        </div>
        <Link className="hero-session-orb" to="/record" title="Open Capture" aria-label="Open Capture">
          <IconSliders size={12} />
        </Link>
      </article>

      <aside className="hero-replay-card">
        <div className="hero-replay-head">
          <h2>Instant Replay</h2>
          <span className={`hero-replay-state ${replay.active ? "on" : ""}`}>
            <span className="pip" />
            {bufferReady ? "Buffer ready" : replay.active ? "Filling…" : "Standby"}
          </span>
        </div>
        <div className="hero-replay-clock">
          <div className="hero-replay-time">
            <strong>{clock(durationMs)}</strong>
            <span>{replay.active ? "always rolling" : "standby"}</span>
          </div>
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
          className="btn primary hero-replay-cta"
          disabled={saving || !bufferReady}
          title={bufferReady ? "Save Instant Replay" : "Instant Replay is still filling"}
          onClick={() => void saveClip()}
        >
          <span className="hero-replay-cta-copy">
            <IconLightning size={15} weight="fill" />
            {captureLabel}
          </span>
          <kbd>{displayHotkey(settings.hotkeys.saveReplay)}</kbd>
        </button>
        <div className="hero-replay-secondary">
          <button type="button" className="hero-replay-ghost" disabled={saving} onClick={() => void (status.active ? stop() : start())}>
            <span className="hero-replay-ghost-copy">
              <IconRecordCircle size={13} weight="fill" />
              {status.active ? "Stop" : "Record"}
            </span>
            <kbd>{displayHotkey(settings.hotkeys.toggleRecording)}</kbd>
          </button>
          <button
            type="button"
            className="hero-replay-ghost"
            title="Drag to capture any part of your screen"
            onClick={() => void takeScreenshot()}
          >
            <span className="hero-replay-ghost-copy">
              <IconCamera size={13} />
              Screenshot
            </span>
            <kbd>{displayHotkey(settings.hotkeys.regionScreenshot)}</kbd>
          </button>
        </div>
        <div className="hero-replay-help">
          <span title={savePlace}>
            <IconFolder size={13} weight="fill" />
            Saving to {savePlace}
          </span>
          <span>
            <IconLock size={13} weight="fill" />
            Private by default
          </span>
        </div>
      </aside>
    </section>
  );
}
