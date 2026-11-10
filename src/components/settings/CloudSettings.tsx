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
  const scheduleUploads = !settings.keepLocalClips || settings.autoUpload !== "off";

  return (
    <>
      <p className="muted">
        Signed-in clips upload to the cloud. With Keep a copy on this PC off, this PC’s file is removed after that
        upload succeeds.
      </p>
      <label className="setting-row">
        <span className="setting-copy">
          Keep a copy on this PC
          <small>
            Off removes this PC’s copy after the clip reaches the cloud. On keeps the file and follows the upload rules
            below. A failed upload or a signed-out save stays on this PC. The original recording stays either way.
          </small>
        </span>
        <input
          className="switch"
          type="checkbox"
          checked={settings.keepLocalClips}
          onChange={(event) => void onChange("keepLocalClips", event.target.checked)}
        />
      </label>
      <div className="settings-fields">
        <div className="field">
          <label htmlFor="auto-upload">Automatically upload clips</label>
          <select
            id="auto-upload"
            value={settings.autoUpload}
            onChange={(event) => void onChange("autoUpload", event.target.value as AppSettings["autoUpload"])}
          >
            <option value="off">
              {settings.keepLocalClips ? "Off — keep clips on this PC only" : "Off — new clips still upload"}
            </option>
            <option value="favorites">Favorites only</option>
            <option value="all">All clips</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="cloud-upload-when">When to upload</label>
          <select
            id="cloud-upload-when"
            value={settings.cloudUploadWhen}
            disabled={!scheduleUploads}
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
            <small>$7.99/mo · 100 GB, original uploads, no watermark</small>
          </span>
          <Link className="settings-link" to="/profile">
            Upgrade
          </Link>
        </div>
      </div>
    </>
  );
}
