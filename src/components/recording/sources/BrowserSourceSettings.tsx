import { sanitizePageUrl } from "../../../recording/browserSource";
import { browserSettingsOf, type RecordingSource } from "../../../recording/scene";

export function BrowserSourceSettings({
  source,
  enabled,
  onChange,
  onEnabled,
}: {
  source: RecordingSource;
  enabled: boolean;
  onChange: (settings: { url: string }) => void;
  onEnabled: (enabled: boolean) => void;
}) {
  const page = browserSettingsOf(source);
  const allowed = sanitizePageUrl(page.url);

  return (
    <div className="stack">
      <p className="muted">
        The page opens in its own window, with no access to Replayr. Https only, or http on this computer.
      </p>
      <label className="setting-row">
        <span>Allow browser sources</span>
        <input type="checkbox" checked={enabled} onChange={(event) => onEnabled(event.target.checked)} />
      </label>
      {!enabled ? <p className="muted">Turn this on before the page is recorded. The rest of the scene still records.</p> : null}
      <label className="field">
        <span className="settings-group-label">Page address</span>
        <input
          type="url"
          value={page.url}
          placeholder="https://example.com"
          onChange={(event) => onChange({ url: event.target.value })}
        />
      </label>
      {page.url && !allowed ? <p className="muted">That address is not allowed.</p> : null}
    </div>
  );
}
