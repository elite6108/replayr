import { APP_NAME } from "../../branding";
import { useSettingsStore } from "../../stores/settingsStore";

export function DesktopShortcutPrompt() {
  const prompted = useSettingsStore((state) => state.settings.desktopShortcutPrompted);
  const patch = useSettingsStore((state) => state.patch);

  if (prompted) return null;

  return (
    <div className="desktop-prompt" role="dialog" aria-label={`Add ${APP_NAME} to your desktop`}>
      <p>Add {APP_NAME} to your desktop?</p>
      <div className="row">
        <button
          className="btn primary"
          type="button"
          onClick={() => void patch({ desktopShortcut: true, desktopShortcutPrompted: true })}
        >
          Add shortcut
        </button>
        <button className="btn" type="button" onClick={() => void patch({ desktopShortcutPrompted: true })}>
          Not now
        </button>
      </div>
    </div>
  );
}
