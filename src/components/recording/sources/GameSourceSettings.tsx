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
          <option value="native">Native</option>
          <option value="1080p">1080p</option>
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
    </div>
  );
}
