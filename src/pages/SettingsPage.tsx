import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { open } from "@tauri-apps/plugin-dialog";
import { publicAppUrl, APP_NAME } from "../branding";
import { PageHeader } from "../components/common/PageHeader";
import { DEFAULT_HOTKEYS, findHotkeyConflicts, HOTKEY_ACTIONS, HOTKEY_LABELS } from "../utils/hotkeys";
import { displayHotkey } from "../utils/format";
import { useSettingsStore } from "../stores/settingsStore";
import { useDetectionStore } from "../stores/detectionStore";
import { useToastStore } from "../stores/toastStore";
import { AudioSourceRow } from "../components/settings/AudioSourceRow";
import { MicrophoneControls } from "../components/settings/MicrophoneControls";
import { addExtraAudioApp, getAudioStatus, listAudioSessions } from "../services/tauri";
import type { AudioEngineStatus, AudioSession } from "../types/audio";
import type { AppSettings, ExtraAudioApp } from "../types/settings";
import { useUpdateStore } from "../stores/updateStore";

export function SettingsPage() {
  const settings = useSettingsStore((state) => state.settings);
  const update = useSettingsStore((state) => state.update);
  const catalog = useDetectionStore((state) => state.catalog);
  const refreshCatalog = useDetectionStore((state) => state.refreshCatalog);
  const detectionError = useDetectionStore((state) => state.error);
  const showToast = useToastStore((state) => state.show);
  const conflicts = findHotkeyConflicts(settings.hotkeys);
  const [catalogBusy, setCatalogBusy] = useState(false);
  const appVersion = useUpdateStore((state) => state.version);
  const updateStatus = useUpdateStore((state) => state.status);
  const availableVersion = useUpdateStore((state) => state.availableVersion);
  const updateNotes = useUpdateStore((state) => state.notes);
  const downloadPercent = useUpdateStore((state) => state.downloadPercent);
  const updateError = useUpdateStore((state) => state.error);
  const checkForUpdates = useUpdateStore((state) => state.check);
  const installAndRelaunch = useUpdateStore((state) => state.installAndRelaunch);
  const checkingUpdates = updateStatus === "checking";
  const downloadingUpdate = updateStatus === "downloading";

  async function onChange<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    try {
      await update(key, value);
      showToast("Settings saved");
    } catch (caught) {
      showToast(caught instanceof Error ? caught.message : "Could not save that setting.");
    }
  }

  async function chooseSaveLocation() {
    const selected = await open({ directory: true, multiple: false, title: "Choose clip save location" });
    if (typeof selected === "string") {
      await onChange("saveLocation", selected);
    }
  }

  return (
    <>
      <PageHeader title="Settings" subtitle="These values persist locally and are used when you start a recording." />
      <div className="grid cols-2">
        <section className="panel stack">
          <h2>Application</h2>
          <label className="setting-row">
            <span>Close window to tray</span>
            <input
              className="switch"
              type="checkbox"
              checked={settings.closeToTray}
              onChange={(event) => void onChange("closeToTray", event.target.checked)}
            />
          </label>
          <label className="setting-row">
            <span>Launch at Windows startup</span>
            <input
              className="switch"
              type="checkbox"
              checked={settings.launchAtStartup}
              onChange={(event) => void onChange("launchAtStartup", event.target.checked)}
            />
          </label>
          <label className="setting-row">
            <span>Show {APP_NAME} on the desktop</span>
            <input
              className="switch"
              type="checkbox"
              checked={settings.desktopShortcut}
              onChange={(event) => void onChange("desktopShortcut", event.target.checked)}
            />
          </label>
        </section>

        <section className="panel stack">
          <h2>Updates</h2>
          <div className="setting-row">
            <span className="setting-copy">
              Installed version
              <small>{appVersion || "Unknown"}</small>
            </span>
          </div>
          <p className="muted">{updateStatusLabel(updateStatus, availableVersion, downloadPercent, updateError)}</p>
          {updateNotes && updateStatus === "ready" ? <p className="muted">{updateNotes}</p> : null}
          <div className="row">
            <button
              type="button"
              className="btn"
              disabled={checkingUpdates || downloadingUpdate}
              onClick={() => void checkForUpdates()}
            >
              {checkingUpdates ? "Checking…" : "Check for updates"}
            </button>
            {updateStatus === "ready" || downloadingUpdate ? (
              <button
                type="button"
                className="btn primary"
                disabled={downloadingUpdate}
                onClick={() => void installAndRelaunch()}
              >
                {downloadingUpdate
                  ? downloadPercent != null
                    ? `Downloading ${downloadPercent}%`
                    : "Downloading…"
                  : "Restart to update"}
              </button>
            ) : null}
          </div>
        </section>

        <section className="panel stack">
          <div className="panel-head">
            <h2>Game catalog</h2>
            <span className="badge">{catalog.length}</span>
          </div>
          <p className="muted">Detection matches running processes against this list.</p>
          {detectionError ? <div className="error-text">{detectionError}</div> : null}
          <ul className="catalog-list">
            {catalog.slice(0, 8).map((game) => (
              <li key={game.slug}>
                <span>{game.name}</span>
                {game.publisher ? <span className="muted">{game.publisher}</span> : null}
              </li>
            ))}
          </ul>
          {catalog.length > 8 ? <div className="muted">+{catalog.length - 8} more</div> : null}
          <button
            type="button"
            className="btn"
            disabled={catalogBusy}
            onClick={() => {
              setCatalogBusy(true);
              void refreshCatalog()
                .then(() => showToast("Game catalog updated"))
                .catch((caught) => showToast(caught instanceof Error ? caught.message : "Could not refresh catalog"))
                .finally(() => setCatalogBusy(false));
            }}
          >
            Refresh from cloud
          </button>
        </section>

        <section className="panel stack">
          <h2>Cloud</h2>
          <p className="muted">Sign-in uses Supabase. Uploads go to the Worker at this origin, then directly to R2.</p>
          <code>{publicAppUrl()}</code>
          <Link className="btn" to="/profile">
            Account
          </Link>
        </section>

        <section className="panel stack">
          <h2>Recording</h2>
          <p className="muted">Instant Replay keeps a rolling buffer. Start/stop still writes a full session file.</p>
          <label className="setting-row">
            <span>Instant Replay</span>
            <input
              className="switch"
              type="checkbox"
              checked={settings.instantReplayEnabled}
              onChange={(event) => void onChange("instantReplayEnabled", event.target.checked)}
            />
          </label>
          <div className="field">
            <label htmlFor="replay-length">Replay length</label>
            <select
              id="replay-length"
              value={settings.replayDurationSeconds}
              onChange={(event) => void onChange("replayDurationSeconds", Number(event.target.value) as AppSettings["replayDurationSeconds"])}
            >
              <option value={15}>15 seconds</option>
              <option value={30}>30 seconds</option>
              <option value={45}>45 seconds</option>
              <option value={60}>60 seconds</option>
              <option value={90}>90 seconds</option>
              <option value={120}>2 minutes</option>
              <option value={180}>3 minutes</option>
              <option value={300}>5 minutes</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="resolution">Resolution</label>
            <select
              id="resolution"
              value={settings.resolution}
              onChange={(event) => void onChange("resolution", event.target.value as AppSettings["resolution"])}
            >
              <option value="native">Native</option>
              <option value="1080p">1080p</option>
              <option value="720p">720p</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="fps">FPS</label>
            <select
              id="fps"
              value={settings.fps}
              onChange={(event) => void onChange("fps", Number(event.target.value) as AppSettings["fps"])}
            >
              <option value={30}>30</option>
              <option value={60}>60</option>
              <option value={120}>120</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="bitrate">Bitrate</label>
            <select
              id="bitrate"
              value={settings.bitrate}
              onChange={(event) => void onChange("bitrate", event.target.value as AppSettings["bitrate"])}
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="custom">Custom</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="codec">Codec</label>
            <select
              id="codec"
              value={settings.codec}
              onChange={(event) => void onChange("codec", event.target.value as AppSettings["codec"])}
            >
              <option value="h264">H.264</option>
              <option value="h265">H.265</option>
              <option value="av1">AV1 when supported</option>
            </select>
          </div>
        </section>

        <AudioPanel settings={settings} update={update} showToast={showToast} />

        <section className="panel stack">
          <h2>Storage and uploads</h2>
          <div className="field">
            <label>Save location</label>
            <div className="row">
              <input readOnly value={settings.saveLocation || "Default Videos folder"} />
              <button type="button" className="btn" onClick={() => void chooseSaveLocation()}>
                Browse
              </button>
            </div>
          </div>
          <div className="field">
            <label htmlFor="auto-upload">Automatically upload clips</label>
            <select
              id="auto-upload"
              value={settings.autoUpload}
              onChange={(event) => void onChange("autoUpload", event.target.value as AppSettings["autoUpload"])}
            >
              <option value="off">Off — keep clips on this PC only</option>
              <option value="favorites">Favorites only</option>
              <option value="all">All clips</option>
            </select>
            <div className="muted">Signed-in uploads go Desktop → R2. This PC still keeps the original file.</div>
          </div>
          <div className="field">
            <label htmlFor="bandwidth">Upload bandwidth</label>
            <select
              id="bandwidth"
              value={settings.uploadBandwidthLimit}
              onChange={(event) => void onChange("uploadBandwidthLimit", event.target.value as AppSettings["uploadBandwidthLimit"])}
            >
              <option value="unlimited">Unlimited</option>
              <option value="50">50 Mbps</option>
              <option value="25">25 Mbps</option>
              <option value="10">10 Mbps</option>
              <option value="5">5 Mbps</option>
              <option value="1">1 Mbps</option>
              <option value="custom">Custom</option>
            </select>
          </div>
          <label className="setting-row">
            <span>Pause uploads while gaming</span>
            <input
              className="switch"
              type="checkbox"
              checked={settings.pauseUploadsWhileGaming}
              onChange={(event) => void onChange("pauseUploadsWhileGaming", event.target.checked)}
            />
          </label>
          <div className="field">
            <label htmlFor="min-disk">Stop capture below</label>
            <select
              id="min-disk"
              value={settings.minFreeDiskBytes}
              onChange={(event) => void onChange("minFreeDiskBytes", Number(event.target.value))}
            >
              <option value={5 * 1024 * 1024 * 1024}>5 GB free</option>
              <option value={10 * 1024 * 1024 * 1024}>10 GB free</option>
              <option value={20 * 1024 * 1024 * 1024}>20 GB free</option>
              <option value={50 * 1024 * 1024 * 1024}>50 GB free</option>
            </select>
          </div>
        </section>

        <section className="panel stack">
          <h2>Hotkeys</h2>
          <p className="muted">Save Replay, start/stop, and screenshot work while a game is focused.</p>
          {HOTKEY_ACTIONS.map((action) => (
            <div className="field" key={action}>
              <label htmlFor={`hotkey-${action}`}>{HOTKEY_LABELS[action]}</label>
              <input
                id={`hotkey-${action}`}
                value={settings.hotkeys[action]}
                onChange={(event) => {
                  const next = { ...settings.hotkeys, [action]: event.target.value };
                  void onChange("hotkeys", next);
                }}
              />
              <div className="muted">{displayHotkey(settings.hotkeys[action])}</div>
              {conflicts[action] ? (
                <span className="error-text">Conflicts with {HOTKEY_LABELS[conflicts[action]]}</span>
              ) : null}
            </div>
          ))}
          <button type="button" className="btn" onClick={() => void onChange("hotkeys", { ...DEFAULT_HOTKEYS })}>
            Reset defaults
          </button>
        </section>
      </div>
    </>
  );
}

function AudioPanel({
  settings,
  update,
  showToast,
}: {
  settings: AppSettings;
  update: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => Promise<void>;
  showToast: (message: string) => void;
}) {
  const [status, setStatus] = useState<AudioEngineStatus | null>(null);
  const [sessions, setSessions] = useState<AudioSession[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setInterval(() => {
      void getAudioStatus().then((next) => {
        if (!cancelled && next) setStatus(next);
      });
    }, 200);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [settings.gameAudioEnabled, settings.discordAudioEnabled, settings.systemAudioEnabled, settings.extraApps]);

  async function toggleSource(key: "gameAudioEnabled" | "discordAudioEnabled" | "systemAudioEnabled", enabled: boolean, label: string) {
    try {
      await update(key, enabled);
      showToast(enabled ? `${label} on` : `${label} off`);
    } catch (caught) {
      showToast(caught instanceof Error ? caught.message : "Could not save that setting.");
    }
  }

  async function saveExtras(extras: ExtraAudioApp[], toast?: string) {
    try {
      await update("extraApps", extras);
      if (toast) showToast(toast);
    } catch (caught) {
      showToast(caught instanceof Error ? caught.message : "Could not save that setting.");
    }
  }

  async function addDetected(exe: string, displayName: string) {
    try {
      const next = await addExtraAudioApp(exe, displayName);
      useSettingsStore.setState({ settings: next });
      showToast(`${displayName} on`);
    } catch (caught) {
      showToast(caught instanceof Error ? caught.message : "Could not add that app.");
    }
  }

  async function openPicker() {
    setPickerOpen(true);
    setSessions(await listAudioSessions());
  }

  const isolatedOff = !status?.processLoopbackSupported;
  const extraRows = settings.extraApps;

  return (
    <section className="panel stack">
      <h2>Audio</h2>
      {isolatedOff ? (
        <p className="banner warning">
          Per-app capture needs Windows 10 version 2004 or later. Desktop and microphone still work. Replayr will not change your saved mix.
        </p>
      ) : null}
      <AudioSourceRow
        title="Game Audio"
        copy="Only the detected game. Silent when no game is running."
        enabled={settings.gameAudioEnabled}
        gain={settings.gameAudioGain}
        status={status?.game}
        disabled={isolatedOff}
        onEnabled={(enabled) => void toggleSource("gameAudioEnabled", enabled, "Game audio")}
        onGain={(gain) => void update("gameAudioGain", gain).catch((caught) => showToast(caught instanceof Error ? caught.message : "Could not save that setting."))}
        onUseDesktop={() => void toggleSource("systemAudioEnabled", true, "Desktop audio")}
      />
      <AudioSourceRow
        title="Desktop / System"
        copy="Full speaker mix. Includes Chrome, Discord, and everything else. Turn this off to use selected apps only."
        enabled={settings.systemAudioEnabled}
        status={status?.desktop}
        onEnabled={(enabled) => void toggleSource("systemAudioEnabled", enabled, "Desktop audio")}
      />
      <AudioSourceRow
        title="Discord"
        copy="Voice chat only when Discord is running."
        enabled={settings.discordAudioEnabled}
        gain={settings.discordAudioGain}
        status={status?.discord}
        disabled={isolatedOff}
        onEnabled={(enabled) => void toggleSource("discordAudioEnabled", enabled, "Discord")}
        onGain={(gain) => void update("discordAudioGain", gain).catch((caught) => showToast(caught instanceof Error ? caught.message : "Could not save that setting."))}
        onUseDesktop={() => void toggleSource("systemAudioEnabled", true, "Desktop audio")}
      />
      {status?.detectedExtras
        .filter((item) => !extraRows.some((app) => app.id === item.id || app.exe.toLowerCase() === item.exe.toLowerCase()))
        .map((item) => (
          <AudioSourceRow
            key={item.id}
            title={item.displayName}
            copy={item.running ? "Running. Turn on to add it to the mix." : "Previously added."}
            enabled={false}
            disabled={isolatedOff}
            onEnabled={(enabled) => {
              if (enabled) void addDetected(item.exe, item.displayName);
            }}
          />
        ))}
      {extraRows.map((app) => {
        const row = status?.extras.find((item) => item.id === app.id);
        return (
          <AudioSourceRow
            key={app.id}
            title={app.displayName || app.exe}
            copy={row?.status || app.exe}
            enabled={app.enabled}
            gain={app.gain}
            status={row}
            disabled={isolatedOff}
            onEnabled={(enabled) => {
              void saveExtras(
                extraRows.map((item) => (item.id === app.id ? { ...item, enabled } : item)),
                enabled ? `${app.displayName} on` : `${app.displayName} off`,
              );
            }}
            onGain={(gain) => {
              void saveExtras(extraRows.map((item) => (item.id === app.id ? { ...item, gain } : item)));
            }}
            onUseDesktop={() => void toggleSource("systemAudioEnabled", true, "Desktop audio")}
          />
        );
      })}
      <div className="row">
        <button type="button" className="btn" disabled={isolatedOff} onClick={() => void openPicker()}>
          Add App
        </button>
        {pickerOpen ? (
          <button type="button" className="btn ghost" onClick={() => setPickerOpen(false)}>
            Close
          </button>
        ) : null}
      </div>
      {pickerOpen ? (
        <div className="stack">
          <p className="muted">Pick a playing session. Replayr keeps Game and mic, and refuses a fifth extra app.</p>
          {sessions.length === 0 ? <p className="muted">No app sessions found.</p> : null}
          {sessions.map((session) => (
            <button
              key={`${session.pid}-${session.exe}`}
              type="button"
              className="btn"
              onClick={() => {
                void addDetected(session.exe || session.displayName, session.displayName || session.exe).then(() => setPickerOpen(false));
              }}
            >
              {session.displayName || session.exe}
              <small className="muted"> {session.exe}</small>
            </button>
          ))}
        </div>
      ) : null}
      <MicrophoneControls
        enabled={settings.micEnabled}
        deviceId={settings.microphoneId}
        gain={settings.micGain}
        onEnabled={(enabled) => {
          void update("micEnabled", enabled)
            .then(() => showToast(enabled ? "Microphone on" : "Microphone off"))
            .catch((caught) => showToast(caught instanceof Error ? caught.message : "Could not save that setting."));
        }}
        onDeviceId={(deviceId) => {
          void update("microphoneId", deviceId).catch((caught) =>
            showToast(caught instanceof Error ? caught.message : "Could not save that setting."),
          );
        }}
        onGain={(gain) => {
          void update("micGain", gain).catch((caught) =>
            showToast(caught instanceof Error ? caught.message : "Could not save that setting."),
          );
        }}
      />
      <p className="muted">
        Clips write one mixed AAC track. Turn Desktop off and leave Game, Discord, and Mic on to record those sources without Chrome or Spotify.
      </p>
    </section>
  );
}

function updateStatusLabel(
  status: "idle" | "checking" | "up-to-date" | "ready" | "downloading" | "error",
  availableVersion: string | null,
  downloadPercent: number | null,
  error: string | null,
) {
  if (status === "checking") return "Checking…";
  if (status === "up-to-date") return "Up to date";
  if (status === "ready") return availableVersion ? `Update ${availableVersion} ready` : "Update ready";
  if (status === "downloading") {
    return downloadPercent != null ? `Downloading ${downloadPercent}%` : "Downloading…";
  }
  if (status === "error") return error || "Could not check for updates.";
  return "Not checked yet";
}
