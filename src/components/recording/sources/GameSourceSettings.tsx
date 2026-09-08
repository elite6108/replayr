import { DetectedGamePanel } from "../../common/DetectedGamePanel";
import { useDetectionStore } from "../../../stores/detectionStore";
import type { AppSettings } from "../../../types/settings";

export function GameSourceSettings({
  settings,
  onSave,
}: {
  settings: AppSettings;
  onSave: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
}) {
  const snapshot = useDetectionStore((state) => state.snapshot);
  void settings;
  void onSave;

  return (
    <div className="stack">
      <DetectedGamePanel snapshot={snapshot} showControls={false} />
      <p className="muted">Uses the current auto-detected game. Session video is this capture.</p>
    </div>
  );
}

export function CaptureOutputFields({
  settings,
  onSave,
  disabled,
}: {
  settings: AppSettings;
  onSave: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  disabled?: boolean;
}) {
  return (
    <div className="settings-fields">
      <div className="field">
        <label htmlFor="record-resolution">Resolution</label>
        <select
          id="record-resolution"
          value={settings.resolution}
          disabled={disabled}
          onChange={(event) => onSave("resolution", event.target.value as AppSettings["resolution"])}
        >
          <option value="auto">Auto / Recommended</option>
          <option value="1080p">1080p</option>
          <option value="1440p">1440p</option>
          <option value="4k">4K</option>
          <option value="native">Native</option>
          <option value="720p">720p</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="record-fps">FPS</label>
        <select
          id="record-fps"
          value={settings.fps}
          disabled={disabled}
          onChange={(event) => onSave("fps", Number(event.target.value) as AppSettings["fps"])}
        >
          <option value={30}>30</option>
          <option value={60}>60</option>
          <option value={120}>120</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="record-preview-quality">Live preview quality</label>
        <select
          id="record-preview-quality"
          value={settings.previewQuality}
          onChange={(event) =>
            onSave("previewQuality", event.target.value as AppSettings["previewQuality"])
          }
        >
          <option value="full">Full (up to 1080p)</option>
          <option value="balanced">Balanced (720p)</option>
          <option value="performance">Performance (540p)</option>
        </select>
        <p className="muted" style={{ marginTop: 6 }}>
          Does not change the recording file. Full size applies on the next recording session.
        </p>
      </div>
    </div>
  );
}
