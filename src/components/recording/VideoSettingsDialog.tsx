import { useEffect, useRef, useState } from "react";
import { getCameraControls, setCameraControl } from "../../services/tauri";
import type { CameraControlInfo } from "../../types/camera";
import type {
  AppSettings,
  CameraControlName,
  PreviewQuality,
  WebcamPreviewSmoothness,
} from "../../types/settings";
import {
  isNeutralPicture,
  NEUTRAL_PICTURE,
  pictureSettingsOf,
  type PictureSettings,
  type RecordingSource,
} from "../../recording/scene";
import { CameraModePicker } from "../sources/CameraModePicker";
import { parseModeId, sanitizeCamera } from "../../recording/sourceVisual";

const PICTURE_FIELDS: { key: keyof PictureSettings; label: string; min: number; max: number; unit?: string }[] = [
  { key: "brightness", label: "Brightness", min: -100, max: 100 },
  { key: "contrast", label: "Contrast", min: -100, max: 100 },
  { key: "saturation", label: "Saturation", min: -100, max: 100 },
  { key: "hue", label: "Hue", min: -180, max: 180, unit: "°" },
  { key: "sharpness", label: "Sharpness", min: 0, max: 100 },
];

const CAPTURE_SMOOTHNESS: { id: PreviewQuality; label: string; hint: string }[] = [
  { id: "balanced", label: "Smooth", hint: "Up to 60 fps at 1280 px wide." },
  { id: "full", label: "Sharp", hint: "Full detail up to 2560 px. Fewer frames per second on big screens." },
  { id: "performance", label: "Light", hint: "25 fps at 960 px. Lowest CPU use." },
];

const WEBCAM_SMOOTHNESS: { id: WebcamPreviewSmoothness; label: string; hint: string }[] = [
  { id: "smooth", label: "Smooth", hint: "Every camera frame (up to 60 fps) at 640 px wide." },
  { id: "balanced", label: "Balanced", hint: "Up to 30 fps at 960 px wide." },
  { id: "sharp", label: "Sharp", hint: "Up to 30 fps at 1280 px wide." },
];

export function VideoSettingsDialog({
  source,
  settings,
  composed,
  locked,
  onPicture,
  onSaveSetting,
  onCameraMode,
  onClose,
}: {
  source: RecordingSource;
  settings: AppSettings;
  /** True when the scene records through the compositor, where picture adjustments are recorded. */
  composed: boolean;
  /** Recording in progress: picture and camera mode changes wait until it stops. */
  locked: boolean;
  onPicture: (picture: PictureSettings) => void;
  onSaveSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  /** When set, a mode change stays on this webcam instead of the shared camera. */
  onCameraMode?: (mode: { width: number; height: number; fps: number }) => void;
  onClose: () => void;
}) {
  const picture = pictureSettingsOf(source);
  const webcam = source.type === "webcam";
  const stored = webcam ? sanitizeCamera(source.settings.camera) : null;
  const storedMode = stored ? parseModeId(stored.modeId) : null;
  const cameraDevice = stored?.deviceId || settings.webcam.deviceId;
  const cameraWidth = storedMode?.width ?? settings.webcam.width;
  const cameraHeight = storedMode?.height ?? settings.webcam.height;
  const cameraFps = storedMode?.fps ?? settings.webcam.fps;

  return (
    <div className="studio-modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="studio-modal video-settings-dialog"
        role="dialog"
        aria-labelledby="video-settings-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="studio-block-head">
          <h2 id="video-settings-title">{source.name} video settings</h2>
          <button type="button" className="studio-icon-btn" onClick={onClose}>
            Close
          </button>
        </div>
        {locked ? <p className="studio-lock-note">Stop recording to change the picture or camera mode.</p> : null}

        <section className="studio-section">
          <h3>Picture</h3>
          <fieldset className="video-settings-fields" disabled={locked}>
            {PICTURE_FIELDS.map((field) => (
              <div className="field" key={field.key}>
                <label htmlFor={`video-picture-${field.key}`}>
                  {field.label}
                  <span className="muted">
                    {picture[field.key] > 0 && field.key !== "sharpness" ? "+" : ""}
                    {picture[field.key]}
                    {field.unit ?? ""}
                  </span>
                </label>
                <input
                  id={`video-picture-${field.key}`}
                  type="range"
                  min={field.min}
                  max={field.max}
                  step={1}
                  value={picture[field.key]}
                  onChange={(event) => onPicture({ ...picture, [field.key]: Number(event.target.value) })}
                  onDoubleClick={() => onPicture({ ...picture, [field.key]: 0 })}
                />
              </div>
            ))}
            <button
              type="button"
              className="btn ghost sm"
              disabled={isNeutralPicture(picture)}
              onClick={() => onPicture({ ...NEUTRAL_PICTURE })}
            >
              Reset picture
            </button>
          </fieldset>
          <p className="studio-section-copy">
            {composed
              ? "Applies to the preview and composed recordings. Sharpness only shows in the recording."
              : "Applies to the preview and composed recordings. This scene records directly, so switch to a composed output to record these changes."}
          </p>
        </section>

        <section className="studio-section">
          <h3>Preview smoothness</h3>
          <div className="studio-chip-row" role="group" aria-label="Preview smoothness">
            {webcam
              ? WEBCAM_SMOOTHNESS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    title={item.hint}
                    className={`studio-chip${settings.webcam.previewSmoothness === item.id ? " is-on" : ""}`}
                    onClick={() => onSaveSetting("webcam", { ...settings.webcam, previewSmoothness: item.id })}
                  >
                    {item.label}
                  </button>
                ))
              : CAPTURE_SMOOTHNESS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    title={item.hint}
                    className={`studio-chip${settings.previewQuality === item.id ? " is-on" : ""}`}
                    onClick={() => onSaveSetting("previewQuality", item.id)}
                  >
                    {item.label}
                  </button>
                ))}
          </div>
          <p className="studio-section-copy">
            {(webcam
              ? WEBCAM_SMOOTHNESS.find((item) => item.id === settings.webcam.previewSmoothness)?.hint
              : CAPTURE_SMOOTHNESS.find((item) => item.id === settings.previewQuality)?.hint) ?? ""}{" "}
            Only changes the live preview, not the recording.
          </p>
        </section>

        {webcam ? (
          <section className="studio-section">
            <h3>Camera mode</h3>
            <p className="studio-section-copy">A higher frame rate makes the webcam smoother in the preview and the recording.</p>
            <div className="settings-fields webcam-fields">
              <CameraModePicker
                idPrefix="video-camera"
                deviceId={cameraDevice}
                width={cameraWidth}
                height={cameraHeight}
                fps={cameraFps}
                disabled={locked || !cameraDevice}
                onChange={(mode) => (onCameraMode ? onCameraMode(mode) : onSaveSetting("webcam", { ...settings.webcam, ...mode }))}
              />
            </div>
          </section>
        ) : null}

        {webcam ? (
          <CameraControlsSection settings={settings} deviceId={cameraDevice} onSaveSetting={onSaveSetting} />
        ) : null}
      </div>
    </div>
  );
}

function CameraControlsSection({
  settings,
  deviceId,
  onSaveSetting,
}: {
  settings: AppSettings;
  deviceId: string;
  onSaveSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
}) {
  const [controls, setControls] = useState<CameraControlInfo[] | null>(null);
  const [error, setError] = useState("");
  const pending = useRef(new Map<CameraControlName, number>());
  const latestSettings = useRef(settings);
  latestSettings.current = settings;

  useEffect(() => {
    if (!deviceId) {
      setControls([]);
      return;
    }
    let cancelled = false;
    setControls(null);
    setError("");
    void getCameraControls(deviceId)
      .then((listed) => {
        if (!cancelled) setControls(listed);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setControls([]);
        setError(caught instanceof Error ? caught.message : "Could not read the camera controls.");
      });
    return () => {
      cancelled = true;
    };
  }, [deviceId]);

  useEffect(() => {
    const timers = pending.current;
    return () => {
      for (const timer of timers.values()) window.clearTimeout(timer);
      timers.clear();
    };
  }, []);

  function persist(name: CameraControlName, value: number, auto: boolean) {
    const current = latestSettings.current.webcam;
    const forDevice = { ...(current.controls[deviceId] ?? {}), [name]: { value, auto } };
    onSaveSetting("webcam", { ...current, controls: { ...current.controls, [deviceId]: forDevice } });
  }

  function change(control: CameraControlInfo, value: number, auto: boolean) {
    setControls((list) =>
      list ? list.map((item) => (item.name === control.name ? { ...item, value, auto } : item)) : list,
    );
    const timers = pending.current;
    const previous = timers.get(control.name);
    if (previous) window.clearTimeout(previous);
    timers.set(
      control.name,
      window.setTimeout(() => {
        timers.delete(control.name);
        void setCameraControl(deviceId, control.name, value, auto).catch((caught: unknown) => {
          setError(caught instanceof Error ? caught.message : "The camera rejected that value.");
        });
        persist(control.name, value, auto);
      }, 120),
    );
  }

  async function resetAll() {
    if (!controls) return;
    setError("");
    for (const control of controls) {
      try {
        await setCameraControl(deviceId, control.name, control.defaultValue, control.autoSupported);
      } catch {
        // A control that refuses its own default is left as it is.
      }
    }
    const current = latestSettings.current.webcam;
    const nextControls = { ...current.controls };
    delete nextControls[deviceId];
    onSaveSetting("webcam", { ...current, controls: nextControls });
    setControls(await getCameraControls(deviceId).catch(() => controls));
  }

  return (
    <section className="studio-section">
      <h3>Camera controls</h3>
      <p className="studio-section-copy">These change the camera itself, so they apply to every recording.</p>
      {!deviceId ? <p className="studio-empty">Choose a camera first.</p> : null}
      {deviceId && controls === null ? <p className="studio-empty">Reading the camera…</p> : null}
      {controls && controls.length === 0 && deviceId && !error ? (
        <p className="studio-empty">This camera does not offer adjustable controls.</p>
      ) : null}
      {controls?.map((control) =>
        control.name === "powerLine" ? (
          <div className="field" key={control.name}>
            <label htmlFor="camera-control-powerLine">{control.label}</label>
            <select
              id="camera-control-powerLine"
              value={control.value}
              onChange={(event) => change(control, Number(event.target.value), false)}
            >
              {POWER_LINE_OPTIONS.filter((option) => option.value >= control.min && option.value <= control.max).map(
                (option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ),
              )}
            </select>
          </div>
        ) : (
          <div className="field camera-control" key={control.name}>
            <label htmlFor={`camera-control-${control.name}`}>
              {control.label}
              <span className="muted">{control.auto ? "Auto" : control.value}</span>
            </label>
            <div className="camera-control-row">
              <input
                id={`camera-control-${control.name}`}
                type="range"
                min={control.min}
                max={control.max}
                step={Math.max(1, control.step)}
                value={control.value}
                disabled={control.auto && control.autoSupported}
                onChange={(event) => change(control, Number(event.target.value), false)}
              />
              {control.autoSupported ? (
                <label className="studio-check">
                  <input
                    type="checkbox"
                    checked={control.auto}
                    onChange={(event) => change(control, control.value, event.target.checked)}
                  />
                  Auto
                </label>
              ) : null}
            </div>
          </div>
        ),
      )}
      {controls && controls.length > 0 ? (
        <button type="button" className="btn ghost sm" onClick={() => void resetAll()}>
          Reset to camera defaults
        </button>
      ) : null}
      {error ? <p className="error-text">{error}</p> : null}
    </section>
  );
}

const POWER_LINE_OPTIONS = [
  { value: 0, label: "Off" },
  { value: 1, label: "50 Hz" },
  { value: 2, label: "60 Hz" },
  { value: 3, label: "Auto" },
];
