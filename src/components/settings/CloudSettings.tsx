import { Link } from "react-router-dom";
import { publicAppUrl } from "../../branding";
import type { AppSettings } from "../../types/settings";

export function CloudSettings({
  settings,
  onChange,
}: {
  settings: AppSettings;
  onChange: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => Promise<void>;
}) {
  const autoOff = settings.autoUpload === "off";

  return (
    <>
      <p className="muted">Signed-in uploads go Desktop → R2. This PC still keeps the original file.</p>
      <div className="settings-fields">
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
        </div>
        <div className="field">
          <label htmlFor="cloud-upload-when">When to upload</label>
          <select
            id="cloud-upload-when"
            value={settings.cloudUploadWhen}
            disabled={autoOff}
            onChange={(event) => void onChange("cloudUploadWhen", event.target.value as AppSettings["cloudUploadWhen"])}
          >
            <option value="immediate">Right after recording</option>
            <option value="afterGame">After I exit the game</option>
          </select>
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
      </div>
      <p className="muted">Share, copy link, download, or send still uploads right away.</p>
      <div className="settings-group">
        <div className="settings-group-label">Account</div>
        <div className="setting-row">
          <span className="setting-copy">
            Origin
            <small>{publicAppUrl()}</small>
          </span>
          <Link className="settings-link" to="/profile">
            Account
          </Link>
        </div>
        <div className="setting-row">
          <span className="setting-copy">
            Replayr Premium
            <small>$4.99/mo · 100 GB, original uploads, no watermark</small>
          </span>
          <Link className="settings-link" to="/profile">
            Upgrade
          </Link>
        </div>
      </div>
    </>
  );
}
