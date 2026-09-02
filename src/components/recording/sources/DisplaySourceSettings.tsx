import type { AppSettings } from "../../../types/settings";

export function DisplaySourceSettings({
  settings,
  onSave,
}: {
  settings: AppSettings;
  onSave: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
}) {
  void settings;
  void onSave;
  return (
    <div className="stack">
      <p className="muted">Desktop mode uses the current display capture path. Multi-monitor picking comes later.</p>
    </div>
  );
}
