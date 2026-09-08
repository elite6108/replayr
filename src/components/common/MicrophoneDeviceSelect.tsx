import { useEffect, useId, useState } from "react";
import { listAudioDevices } from "../../services/tauri";
import type { AudioDevice } from "../../types/audio";

export function MicrophoneDeviceSelect({
  deviceId,
  onDeviceId,
  disabled = false,
  disabledReason,
  id,
  label = "Device",
}: {
  deviceId: string;
  onDeviceId: (deviceId: string) => void;
  disabled?: boolean;
  /** Shown as title/tooltip when `disabled` (e.g. while recording). */
  disabledReason?: string;
  id?: string;
  label?: string;
}) {
  const autoId = useId();
  const selectId = id ?? autoId;
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const selected = deviceId || "default";
  const selectedMissing =
    selected !== "default" && !devices.some((device) => device.id === selected);

  useEffect(() => {
    let cancelled = false;
    void listAudioDevices()
      .then((listed) => {
        if (!cancelled) {
          setDevices(listed.filter((device) => device.direction === "capture"));
        }
      })
      .catch(() => {
        if (!cancelled) setDevices([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  return (
    <div className="field">
      <label htmlFor={selectId}>{label}</label>
      <select
        id={selectId}
        value={selected}
        disabled={disabled}
        title={disabled ? disabledReason : undefined}
        onChange={(event) => onDeviceId(event.target.value)}
      >
        <option value="default">Windows default</option>
        {selectedMissing ? (
          <option value={selected}>Device unavailable</option>
        ) : null}
        {devices.map((device) => (
          <option key={device.id} value={device.id}>
            {device.name}
            {device.isDefault ? " (Windows default)" : ""}
          </option>
        ))}
      </select>
      {disabled && disabledReason ? <p className="muted studio-mic-device-note">{disabledReason}</p> : null}
      {!disabled && selectedMissing ? <p className="muted studio-mic-device-note">Device unavailable</p> : null}
    </div>
  );
}
