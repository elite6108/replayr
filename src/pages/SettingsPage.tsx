import { useState } from "react";
import { Link } from "react-router-dom";
import { open } from "@tauri-apps/plugin-dialog";
import { publicAppUrl } from "../branding";
import { PageHeader } from "../components/common/PageHeader";
import { DEFAULT_HOTKEYS, findHotkeyConflicts, HOTKEY_ACTIONS, HOTKEY_LABELS } from "../utils/hotkeys";
import { displayHotkey } from "../utils/format";
import { useSettingsStore } from "../stores/settingsStore";
import { useDetectionStore } from "../stores/detectionStore";
import { useToastStore } from "../stores/toastStore";
import type { AppSettings } from "../types/settings";

export function SettingsPage() {
  const settings = useSettingsStore((state) => state.settings);
  const update = useSettingsStore((state) => state.update);
  const catalog = useDetectionStore((state) => state.catalog);
  const refreshCatalog = useDetectionStore((state) => state.refreshCatalog);
  const detectionError = useDetectionStore((state) => state.error);
  const showToast = useToastStore((state) => state.show);
  const conflicts = findHotkeyConflicts(settings.hotkeys);
  const [catalogBusy, setCatalogBusy] = useState(false);

  async function onChange<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    await update(key, value);
    showToast("Settings saved");
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

        <section className="panel stack">
          <h2>Audio</h2>
          <label className="setting-row">
            <span>System audio</span>
            <input
              className="switch"
              type="checkbox"
              checked={settings.systemAudioEnabled}
              onChange={(event) => void onChange("systemAudioEnabled", event.target.checked)}
            />
          </label>
          <label className="setting-row">
            <span>Microphone</span>
            <input
              className="switch"
              type="checkbox"
              checked={settings.micEnabled}
              onChange={(event) => void onChange("micEnabled", event.target.checked)}
            />
          </label>
          <div className="muted">Device lists fill in when capture is implemented.</div>
        </section>

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
