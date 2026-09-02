import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { open } from "@tauri-apps/plugin-dialog";
import { publicSiteUrl, APP_NAME } from "../branding";
import { CloudSettings } from "../components/settings/CloudSettings";
import { PageHeader } from "../components/common/PageHeader";
import { HotkeyRecorder } from "../components/common/HotkeyRecorder";
import { DEFAULT_HOTKEYS, findHotkeyConflicts, HOTKEY_ACTIONS, HOTKEY_LABELS } from "../utils/hotkeys";
import { displayHotkey } from "../utils/format";
import { useRecordingStore } from "../stores/recordingStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useDetectionStore } from "../stores/detectionStore";
import { useToastStore } from "../stores/toastStore";
import { AudioSourceRow } from "../components/settings/AudioSourceRow";
import { MicrophoneControls } from "../components/settings/MicrophoneControls";
import { RecordingSources } from "../components/sources/RecordingSources";
import { addExtraAudioApp, getAudioStatus, getDiscordPresenceStatus, listAudioSessions } from "../services/tauri";
import type { AudioEngineStatus, AudioSession } from "../types/audio";
import type { AppSettings, ExtraAudioApp } from "../types/settings";
import type { DiscordPresenceStatus } from "../types/discord";
import { useUpdateStore, type UpdateStatus } from "../stores/updateStore";
import { useAuthStore } from "../stores/authStore";
import { useBillingStore } from "../stores/billingStore";
import { startCheckout, startPortal, type BillingStatus } from "../services/billing";
import { planLabel } from "../utils/format";
import { ThemePicker } from "../theme/ThemePicker";
import { parseThemePreference } from "../theme/theme";

const SECTIONS = [
  { id: "general", label: "General" },
  { id: "account", label: "Account" },
  { id: "recording", label: "Recording" },
  { id: "audio", label: "Audio" },
  { id: "storage", label: "Storage" },
  { id: "cloud", label: "Cloud" },
  { id: "hotkeys", label: "Shortcuts" },
] as const;

type SettingsSection = (typeof SECTIONS)[number]["id"];

function parseSection(value: string | null): SettingsSection {
  return SECTIONS.some((item) => item.id === value) ? (value as SettingsSection) : "general";
}

export function SettingsPage() {
  const [params, setParams] = useSearchParams();
  const section = parseSection(params.get("section"));
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
  const session = useAuthStore((state) => state.session);
  const billing = useBillingStore((state) => state.status);

  function setSection(next: SettingsSection) {
    setParams(next === "general" ? {} : { section: next }, { replace: true });
  }

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

  const active = SECTIONS.find((item) => item.id === section) ?? SECTIONS[0];

  return (
    <>
      <PageHeader title="Settings" />
      <div className="settings-shell">
        <nav className="settings-nav" aria-label="Settings">
          {SECTIONS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={item.id === section ? "active" : undefined}
              onClick={() => setSection(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <section className="settings-pane">
          <h2>{active.label}</h2>
          {section === "general" ? (
            <GeneralPane
              settings={settings}
              catalogCount={catalog.length}
              catalogBusy={catalogBusy}
              detectionError={detectionError}
              appVersion={appVersion}
              updateStatus={updateStatus}
              availableVersion={availableVersion}
              updateNotes={updateNotes}
              downloadPercent={downloadPercent}
              updateError={updateError}
              checkingUpdates={checkingUpdates}
              downloadingUpdate={downloadingUpdate}
              onChange={onChange}
              onCheckUpdates={() => void checkForUpdates()}
              onInstall={() => void installAndRelaunch()}
              onRefreshCatalog={() => {
                setCatalogBusy(true);
                void refreshCatalog()
                  .then(() => showToast("Game catalog updated"))
                  .catch((caught) => showToast(caught instanceof Error ? caught.message : "Could not refresh catalog"))
                  .finally(() => setCatalogBusy(false));
              }}
            />
          ) : null}
          {section === "account" ? (
            <AccountPane
              session={session}
              billing={billing}
              showToast={showToast}
            />
          ) : null}
          {section === "recording" ? (
            <RecordingPane settings={settings} onChange={onChange} onBrowse={() => void chooseSaveLocation()} />
          ) : null}
          {section === "audio" ? <AudioPanel settings={settings} update={update} showToast={showToast} /> : null}
          {section === "storage" ? (
            <StoragePane settings={settings} onChange={onChange} onBrowse={() => void chooseSaveLocation()} />
          ) : null}
          {section === "cloud" ? <CloudSettings settings={settings} onChange={onChange} /> : null}
          {section === "hotkeys" ? (
            <HotkeysPane settings={settings} conflicts={conflicts} onChange={onChange} />
          ) : null}
        </section>
      </div>
    </>
  );
}

function AccountPane({
  session,
  billing,
  showToast,
}: {
  session: { access_token: string } | null;
  billing: BillingStatus | null;
  showToast: (message: string) => void;
}) {
  const token = session?.access_token ?? "";
  return (
    <div className="settings-group">
      <div className="settings-group-label">Replayr Premium</div>
      <div className="setting-row">
        <span className="setting-copy">
          {billing ? planLabel(billing.plan) : "Free"}
          <small>
            {billing?.premium
              ? billing.cancelAtPeriodEnd
                ? "Cancels at period end"
                : "100 GB · original uploads · no watermark"
              : "$4.99/mo · 100 GB, original uploads, no watermark"}
          </small>
        </span>
        {billing?.premium ? (
          <button
            type="button"
            className="btn sm"
            disabled={!token}
            onClick={() => {
              void startPortal(token, "replayr://billing?status=portal")
                .then((url) => import("@tauri-apps/plugin-opener").then(({ openUrl }) => openUrl(url)))
                .catch((caught: unknown) => showToast(caught instanceof Error ? caught.message : "Could not open billing."));
            }}
          >
            Manage
          </button>
        ) : (
          <button
            type="button"
            className="btn sm primary"
            disabled={!token}
            onClick={() => {
              void startCheckout(token, "month", { successUrl: "replayr://billing?status=success" })
                .then((url) => import("@tauri-apps/plugin-opener").then(({ openUrl }) => openUrl(url)))
                .catch((caught: unknown) => showToast(caught instanceof Error ? caught.message : "Could not start checkout."));
            }}
          >
            Upgrade
          </button>
        )}
      </div>
      <div className="setting-row">
        <span className="setting-copy">
          Profile
          <small>Username, display name, and quota</small>
        </span>
        <Link className="settings-link" to="/profile">
          Open
        </Link>
      </div>
    </div>
  );
}

function DiscordPresenceDebug({ enabled }: { enabled: boolean }) {
  const [status, setStatus] = useState<DiscordPresenceStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      const next = await getDiscordPresenceStatus();
      if (!cancelled) setStatus(next);
    }
    void tick();
    const timer = window.setInterval(() => void tick(), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [enabled]);

  const updated = status?.lastPresenceUpdate
    ? new Date(status.lastPresenceUpdate).toISOString()
    : "—";

  return (
    <p className="muted">
      discordConnected={String(status?.discordConnected ?? false)} · mode={status?.mode ?? "disconnected"} ·
      currentPresenceGame={status?.currentPresenceGame ?? "—"} · lastDetails={status?.lastDetails ?? "—"} · lastState=
      {status?.lastState ?? "—"} · lastLargeImage={status?.lastLargeImage ?? "—"} · lastPresenceUpdate={updated} ·
      lastPresenceError={status?.lastPresenceError ?? "—"}
    </p>
  );
}

function GeneralPane({
  settings,
  catalogCount,
  catalogBusy,
  detectionError,
  appVersion,
  updateStatus,
  availableVersion,
  updateNotes,
  downloadPercent,
  updateError,
  checkingUpdates,
  downloadingUpdate,
  onChange,
  onCheckUpdates,
  onInstall,
  onRefreshCatalog,
}: {
  settings: AppSettings;
  catalogCount: number;
  catalogBusy: boolean;
  detectionError: string | null;
  appVersion: string;
  updateStatus: UpdateStatus;
  availableVersion: string | null;
  updateNotes: string | null;
  downloadPercent: number | null;
  updateError: string | null;
  checkingUpdates: boolean;
  downloadingUpdate: boolean;
  onChange: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => Promise<void>;
  onCheckUpdates: () => void;
  onInstall: () => void;
  onRefreshCatalog: () => void;
}) {
  return (
    <>
      <div className="settings-group">
        <div className="settings-group-label">Appearance</div>
        <div className="setting-row">
          <span className="setting-copy">
            Theme
            <small>Dark is the Replayr default. System follows Windows.</small>
          </span>
          <ThemePicker
            value={parseThemePreference(settings.theme)}
            onChange={(value) => void onChange("theme", value)}
          />
        </div>
      </div>

      <div className="settings-group">
        <div className="settings-group-label">Application</div>
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
        <label className="setting-row">
          <span>Show Replayr status on Discord</span>
          <input
            className="switch"
            type="checkbox"
            checked={settings.discordRichPresence}
            onChange={(event) => void onChange("discordRichPresence", event.target.checked)}
          />
        </label>
        {import.meta.env.DEV ? <DiscordPresenceDebug enabled={settings.discordRichPresence} /> : null}
      </div>

      <div className="settings-group">
        <div className="settings-group-label">Updates</div>
        <div className="setting-row">
          <span className="setting-copy">
            Installed version
            <small>{appVersion || "Unknown"}</small>
          </span>
          <span className="muted">{updateStatusLabel(updateStatus, availableVersion, downloadPercent, updateError)}</span>
        </div>
        {updateNotes && updateStatus === "ready" ? <p className="muted">{updateNotes}</p> : null}
        <div className="row">
          <button type="button" className="btn" disabled={checkingUpdates || downloadingUpdate} onClick={onCheckUpdates}>
            {checkingUpdates ? "Checking…" : "Check for updates"}
          </button>
          {updateStatus === "ready" || downloadingUpdate ? (
            <button type="button" className="btn primary" disabled={downloadingUpdate} onClick={onInstall}>
              {downloadingUpdate
                ? downloadPercent != null
                  ? `Downloading ${downloadPercent}%`
                  : "Downloading…"
                : "Restart to update"}
            </button>
          ) : null}
        </div>
      </div>

      <div className="settings-group">
        <div className="settings-group-label">Legal</div>
        <div className="setting-row">
          <span>Privacy Policy</span>
          <a className="settings-link" href={`${publicSiteUrl()}/privacy`} target="_blank" rel="noreferrer">
            Open
          </a>
        </div>
        <div className="setting-row">
          <span>Terms of Service</span>
          <a className="settings-link" href={`${publicSiteUrl()}/terms`} target="_blank" rel="noreferrer">
            Open
          </a>
        </div>
      </div>

      <div className="settings-group">
        <div className="settings-group-label">Game catalog</div>
        <div className="setting-row">
          <span className="setting-copy">
            Detection titles
            <small>
              {catalogCount} {catalogCount === 1 ? "title" : "titles"}
            </small>
          </span>
          <button type="button" className="btn sm" disabled={catalogBusy} onClick={onRefreshCatalog}>
            {catalogBusy ? "Refreshing…" : "Refresh"}
          </button>
        </div>
        {detectionError ? <div className="error-text">{detectionError}</div> : null}
      </div>
    </>
  );
}

function RecordingPane({
  settings,
  onChange,
  onBrowse,
}: {
  settings: AppSettings;
  onChange: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => Promise<void>;
  onBrowse: () => void;
}) {
  const composedActive = useRecordingStore(
    (state) => Boolean((state.status.active && state.status.composed) || state.startingComposed),
  );
  return (
    <>
      <p className="muted">Instant Replay keeps a rolling buffer. Start/stop still writes a full session file.</p>
      <label className="setting-row">
        <span className="setting-copy">
          Instant Replay
          {composedActive ? <small>Stop composed recording before enabling Instant Replay.</small> : null}
        </span>
        <input
          className="switch"
          type="checkbox"
          checked={settings.instantReplayEnabled}
          disabled={composedActive}
          onChange={(event) => {
            if (composedActive && event.target.checked) return;
            void onChange("instantReplayEnabled", event.target.checked);
          }}
        />
      </label>
      <RecordingSources
        settings={settings}
        previewing
        onWebcamChange={(webcam) => onChange("webcam", webcam)}
      />
      <div className="settings-group">
        <div className="settings-group-label">Quality</div>
      </div>
      <div className="settings-fields">
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
      </div>
      <label className="setting-row">
        <span>Show overlay when a clip is saved</span>
        <input
          className="switch"
          type="checkbox"
          checked={settings.clipSavedNotification}
          onChange={(event) => void onChange("clipSavedNotification", event.target.checked)}
        />
      </label>
      <LocalSaveLocation path={settings.saveLocation} onBrowse={onBrowse} />
    </>
  );
}

function LocalSaveLocation({ path, onBrowse }: { path: string; onBrowse: () => void }) {
  const showToast = useToastStore((state) => state.show);

  async function showFolder() {
    if (!path) {
      showToast("Choose a folder first.");
      return;
    }
    try {
      const { openPath } = await import("@tauri-apps/plugin-opener");
      await openPath(path);
    } catch (caught) {
      showToast(caught instanceof Error ? caught.message : "Could not open that folder.");
    }
  }

  return (
    <div className="settings-group">
      <div className="settings-group-label">Saved on this PC</div>
      <p className="muted">Clips and session recordings write to this folder.</p>
      <div className="field">
        <label htmlFor="save-location">Folder</label>
        <div className="row">
          <input id="save-location" readOnly value={path || "Default Videos folder"} title={path} />
          <button type="button" className="btn" onClick={onBrowse}>
            Browse
          </button>
          <button type="button" className="btn" disabled={!path} onClick={() => void showFolder()}>
            Show
          </button>
        </div>
      </div>
    </div>
  );
}

function StoragePane({
  settings,
  onChange,
  onBrowse,
}: {
  settings: AppSettings;
  onChange: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => Promise<void>;
  onBrowse: () => void;
}) {
  return (
    <>
      <LocalSaveLocation path={settings.saveLocation} onBrowse={onBrowse} />
      <div className="settings-fields">
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
      </div>
    </>
  );
}

function HotkeysPane({
  settings,
  conflicts,
  onChange,
}: {
  settings: AppSettings;
  conflicts: Partial<Record<(typeof HOTKEY_ACTIONS)[number], (typeof HOTKEY_ACTIONS)[number]>>;
  onChange: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => Promise<void>;
}) {
  return (
    <>
      <p className="muted">Click a shortcut, then press the keys. These work while a game is focused.</p>
      {HOTKEY_ACTIONS.map((action) => (
        <div key={action}>
          <label className="setting-row" htmlFor={`hotkey-${action}`}>
            <span className="setting-copy">
              {HOTKEY_LABELS[action]}
              <small>{displayHotkey(settings.hotkeys[action]) || "Not set"}</small>
            </span>
            <HotkeyRecorder
              id={`hotkey-${action}`}
              value={settings.hotkeys[action]}
              onChange={(next) => onChange("hotkeys", { ...settings.hotkeys, [action]: next })}
            />
          </label>
          {conflicts[action] ? (
            <span className="error-text">Conflicts with {HOTKEY_LABELS[conflicts[action]]}</span>
          ) : null}
        </div>
      ))}
      <button type="button" className="btn" onClick={() => void onChange("hotkeys", { ...DEFAULT_HOTKEYS })}>
        Reset defaults
      </button>
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
    <div className="stack">
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
    </div>
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
