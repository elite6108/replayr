import { Link } from "react-router-dom";
import { useAuthStore } from "../../stores/authStore";
import { useDetectionStore } from "../../stores/detectionStore";
import { useRecordingStore } from "../../stores/recordingStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { displayHotkey, formatBytes, initials } from "../../utils/format";
import { NotificationBell } from "./NotificationBell";

function replayLabel(seconds: number) {
  return seconds % 60 === 0 ? `${seconds / 60}m` : `${seconds}s`;
}

export function TopBar() {
  const snapshot = useDetectionStore((state) => state.snapshot);
  const recording = useRecordingStore((state) => state.status.active);
  const replay = useRecordingStore((state) => state.replay);
  const busy = useRecordingStore((state) => state.busy);
  const start = useRecordingStore((state) => state.start);
  const stop = useRecordingStore((state) => state.stop);
  const saveClip = useRecordingStore((state) => state.saveClip);
  const settings = useSettingsStore((state) => state.settings);
  const updateSettings = useSettingsStore((state) => state.update);
  const user = useAuthStore((state) => state.user);
  const profile = useAuthStore((state) => state.profile);
  const detected = Boolean(snapshot.name);
  const label = profile?.display_name || profile?.username || user?.email || "Sign in";
  const bufferReady = replay.active && replay.bufferedMs >= 400;
  const saving = busy || replay.saving;

  return (
    <header className="topbar">
      <div className={`topbar-game ${detected ? "live" : ""}`}>
        <div>
          <div className="topbar-kicker">{detected ? (snapshot.focused ? "Playing" : "Running") : "Waiting"}</div>
          <div className="topbar-title">{detected ? snapshot.name : "Waiting for game"}</div>
        </div>
      </div>

      <div className="topbar-actions">
        <button
          type="button"
          className="hotkey-chip"
          disabled={saving || !bufferReady}
          title={bufferReady ? "Save Instant Replay" : "Instant Replay is still filling"}
          onClick={() => void saveClip()}
        >
          <kbd>{displayHotkey(settings.hotkeys.saveReplay)}</kbd>
          <span className="chip-copy">
            <span>{replay.saving ? "Saving…" : `Clip ${replayLabel(settings.replayDurationSeconds)}`}</span>
            <small>Instant Replay</small>
          </span>
        </button>
        <button
          type="button"
          className={`hotkey-chip ${recording ? "live" : ""}`}
          disabled={busy}
          onClick={() => void (recording ? stop() : start())}
        >
          <kbd>{displayHotkey(settings.hotkeys.toggleRecording)}</kbd>
          <span className="chip-copy">
            <span>{recording ? "Stop" : "Record"}</span>
            <small>Long session</small>
          </span>
        </button>
        <button
          type="button"
          className={`hotkey-chip ${settings.instantReplayEnabled ? "on" : ""}`}
          onClick={() => void updateSettings("instantReplayEnabled", !settings.instantReplayEnabled)}
        >
          <span className="chip-copy">
            <span>Auto Replay {settings.instantReplayEnabled ? "ON" : "OFF"}</span>
            <small>{settings.instantReplayEnabled ? "Buffering in background" : "Clips stay manual"}</small>
          </span>
        </button>
        {replay.diskBlocked && replay.diskFreeBytes != null ? (
          <div className="topbar-pill">Free {formatBytes(replay.diskFreeBytes)}</div>
        ) : null}
      </div>

      <NotificationBell />
      <Link to="/profile" className={`topbar-user ${user ? "" : "sign-in"}`} title={label}>
        <span className="avatar">{initials(profile?.username || profile?.display_name || user?.email || "R")}</span>
        <span className="topbar-user-name">{user ? label : "Sign in"}</span>
      </Link>
    </header>
  );
}
