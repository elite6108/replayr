import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useAuthStore } from "../../stores/authStore";
import { useDetectionStore } from "../../stores/detectionStore";
import { useRecordingStore } from "../../stores/recordingStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useToastStore } from "../../stores/toastStore";
import type { AppSettings, ReplayDurationSeconds } from "../../types/settings";
import { displayHotkey, formatBytes, initials } from "../../utils/format";
import { NotificationBell } from "./NotificationBell";

type OpenChip = "clip" | "record" | null;

const REPLAY_LENGTHS: { value: ReplayDurationSeconds; label: string }[] = [
  { value: 15, label: "15 seconds" },
  { value: 30, label: "30 seconds" },
  { value: 45, label: "45 seconds" },
  { value: 60, label: "60 seconds" },
  { value: 90, label: "90 seconds" },
  { value: 120, label: "2 minutes" },
  { value: 180, label: "3 minutes" },
  { value: 300, label: "5 minutes" },
];

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
  const showToast = useToastStore((state) => state.show);
  const user = useAuthStore((state) => state.user);
  const profile = useAuthStore((state) => state.profile);
  const detected = Boolean(snapshot.name);
  const label = profile?.display_name || profile?.username || user?.email || "Sign in";
  const bufferReady = replay.active && replay.bufferedMs >= 400;
  const saving = busy || replay.saving;
  const [open, setOpen] = useState<OpenChip>(null);

  async function saveSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    try {
      await updateSettings(key, value);
      showToast("Settings saved");
    } catch (caught) {
      showToast(caught instanceof Error ? caught.message : "Could not save that setting.");
    }
  }

  async function saveHotkey(action: "saveReplay" | "toggleRecording", value: string) {
    await saveSetting("hotkeys", { ...settings.hotkeys, [action]: value });
  }

  return (
    <header className="topbar">
      <div className={`topbar-game ${detected ? "live" : ""}`}>
        <div>
          <div className="topbar-kicker">{detected ? (snapshot.focused ? "Playing" : "Running") : "Waiting"}</div>
          <div className="topbar-title">{detected ? snapshot.name : "Waiting for game"}</div>
        </div>
      </div>

      <div className="topbar-actions">
        <TopBarChip
          id="clip"
          open={open}
          setOpen={setOpen}
          className=""
          kbd={displayHotkey(settings.hotkeys.saveReplay)}
          label={replay.saving ? "Saving…" : `Clip ${replayLabel(settings.replayDurationSeconds)}`}
          title="Instant Replay settings"
          dialogLabel="Instant Replay"
        >
          <div className="field">
            <label htmlFor="topbar-replay-length">Replay length</label>
            <select
              id="topbar-replay-length"
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
          <div className="field">
            <label htmlFor="topbar-clip-hotkey">Hotkey</label>
            <input
              id="topbar-clip-hotkey"
              value={settings.hotkeys.saveReplay}
              onChange={(event) => void saveHotkey("saveReplay", event.target.value)}
            />
            <div className="muted">{displayHotkey(settings.hotkeys.saveReplay)}</div>
          </div>
          <button
            type="button"
            className="btn primary"
            disabled={saving || !bufferReady}
            title={bufferReady ? "Save Instant Replay" : "Instant Replay is still filling"}
            onClick={() => void saveClip()}
          >
            {replay.saving ? "Saving…" : "Clip"}
          </button>
        </TopBarChip>
        <TopBarChip
          id="record"
          open={open}
          setOpen={setOpen}
          className={recording ? "live" : ""}
          kbd={displayHotkey(settings.hotkeys.toggleRecording)}
          label={recording ? "Stop" : "Record"}
          title="Recording settings"
          dialogLabel="Long recording"
        >
          <div className="field">
            <label htmlFor="topbar-record-hotkey">Hotkey</label>
            <input
              id="topbar-record-hotkey"
              value={settings.hotkeys.toggleRecording}
              onChange={(event) => void saveHotkey("toggleRecording", event.target.value)}
            />
            <div className="muted">{displayHotkey(settings.hotkeys.toggleRecording)}</div>
          </div>
          <button type="button" className={`btn ${recording ? "danger" : "primary"}`} disabled={busy} onClick={() => void (recording ? stop() : start())}>
            {recording ? "Stop" : "Record"}
          </button>
        </TopBarChip>
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

function TopBarChip({
  id,
  open,
  setOpen,
  className,
  kbd,
  label,
  title,
  dialogLabel,
  children,
}: {
  id: Exclude<OpenChip, null>;
  open: OpenChip;
  setOpen: (next: OpenChip) => void;
  className: string;
  kbd: string;
  label: string;
  title: string;
  dialogLabel: string;
  children: ReactNode;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const isOpen = open === id;

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(null);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(null);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [isOpen, setOpen]);

  return (
    <div className="topbar-chip-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`hotkey-chip${className ? ` ${className}` : ""}`}
        aria-expanded={isOpen}
        aria-controls={menuId}
        title={title}
        onClick={() => setOpen(isOpen ? null : id)}
      >
        <kbd>{kbd}</kbd>
        <span className="chip-copy">{label}</span>
      </button>
      {isOpen ? (
        <div className="topbar-chip-popover" id={menuId} role="dialog" aria-label={dialogLabel}>
          {children}
        </div>
      ) : null}
    </div>
  );
}
