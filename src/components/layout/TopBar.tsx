import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { HotkeyRecorder } from "../common/HotkeyRecorder";
import { useAuthStore } from "../../stores/authStore";
import { useDetectionStore } from "../../stores/detectionStore";
import { useRecordingStore } from "../../stores/recordingStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useToastStore } from "../../stores/toastStore";
import type { AppSettings, ReplayDurationSeconds } from "../../types/settings";
import { APP_NAME } from "../../branding";
import { useBillingStore } from "../../stores/billingStore";
import { displayHotkey, formatBytes, initials } from "../../utils/format";
import { IconChevron } from "../icons";
import { NotificationBell } from "./NotificationBell";
import { WindowControls, WindowDragRegion } from "./WindowChrome";

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
  const premium = useBillingStore((state) => state.status?.premium);
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
      <WindowDragRegion className="topbar-drag" aria-label="Drag window" />
      <WindowDragRegion className="topbar-lead">
        <div className="topbar-brand">{APP_NAME}.</div>
        <div className={`topbar-status ${detected ? "live" : ""}`}>
          <span className={`topbar-status-dot ${detected ? "on" : ""}`} />
          <span className="topbar-title">{detected ? snapshot.name : "Waiting for game"}</span>
          {detected ? (
            <>
              <span className="topbar-sep" aria-hidden="true">
                ·
              </span>
              <span className="topbar-kicker">
                {recording ? "Recording" : replay.active ? "Capturing in background" : snapshot.focused ? "Playing" : "Running"}
              </span>
            </>
          ) : null}
        </div>
      </WindowDragRegion>

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
          disabled={saving || !bufferReady}
          actionTitle={bufferReady ? "Save Instant Replay" : "Instant Replay is still filling"}
          onAction={() => void saveClip()}
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
            <HotkeyRecorder
              id="topbar-clip-hotkey"
              value={settings.hotkeys.saveReplay}
              onChange={(next) => saveHotkey("saveReplay", next)}
            />
          </div>
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
          disabled={busy}
          actionTitle={recording ? "Stop recording" : "Start recording"}
          onAction={() => void (recording ? stop() : start())}
        >
          <div className="field">
            <label htmlFor="topbar-record-hotkey">Hotkey</label>
            <HotkeyRecorder
              id="topbar-record-hotkey"
              value={settings.hotkeys.toggleRecording}
              onChange={(next) => saveHotkey("toggleRecording", next)}
            />
          </div>
        </TopBarChip>
        {replay.diskBlocked && replay.diskFreeBytes != null ? (
          <div className="topbar-pill">Free {formatBytes(replay.diskFreeBytes)}</div>
        ) : null}
      </div>

      <div className="topbar-end">
        <NotificationBell />
        <Link to="/profile" className={`topbar-user ${user ? "" : "sign-in"}`} title={label}>
          <span className="avatar">{initials(profile?.username || profile?.display_name || user?.email || "R")}</span>
          <span className="topbar-user-name">{user ? label : "Sign in"}</span>
          {premium ? <span className="badge pro">PRO</span> : null}
        </Link>
        <WindowControls />
      </div>
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
  disabled,
  actionTitle,
  onAction,
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
  disabled?: boolean;
  actionTitle: string;
  onAction: () => void;
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
    <div className={`hotkey-chip-group${className ? ` ${className}` : ""}${isOpen ? " open" : ""}`} ref={wrapRef}>
      <button type="button" className="hotkey-chip" disabled={disabled} title={actionTitle} onClick={onAction}>
        <kbd>{kbd}</kbd>
        <span className="chip-copy">{label}</span>
      </button>
      <button
        type="button"
        className="hotkey-chip-menu"
        aria-expanded={isOpen}
        aria-controls={menuId}
        title={title}
        onClick={() => setOpen(isOpen ? null : id)}
      >
        <IconChevron size={10} />
      </button>
      {isOpen ? (
        <div className="topbar-chip-popover" id={menuId} role="dialog" aria-label={dialogLabel}>
          {children}
        </div>
      ) : null}
    </div>
  );
}
