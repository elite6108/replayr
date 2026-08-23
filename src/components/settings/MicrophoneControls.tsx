import { useEffect, useState } from "react";
import { getMicLevel, listAudioDevices, stopMicMonitor } from "../../services/tauri";
import type { AudioDevice } from "../../types/audio";

interface MicrophoneControlsProps {
  enabled: boolean;
  deviceId: string;
  gain: number;
  onEnabled: (enabled: boolean) => void;
  onDeviceId: (deviceId: string) => void;
  onGain: (gain: number) => void;
  compact?: boolean;
}

export function MicrophoneControls({
  enabled,
  deviceId,
  gain,
  onEnabled,
  onDeviceId,
  onGain,
  compact = false,
}: MicrophoneControlsProps) {
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [level, setLevel] = useState(0);

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
  }, [deviceId, enabled]);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setInterval(() => {
      void getMicLevel()
        .then((value) => {
          if (!cancelled) setLevel(Math.max(0, Math.min(1, value)));
        })
        .catch(() => {
          if (!cancelled) setLevel(0);
        });
    }, 80);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      void stopMicMonitor();
    };
  }, [deviceId, enabled]);

  const gainPercent = Math.round(gain * 100);

  return (
    <div className="stack audio-source">
      <label className="setting-row">
        <span className="setting-copy">
          Microphone
          <small>One input. Opt in before Replayr records it.</small>
        </span>
        <input
          className="switch"
          type="checkbox"
          checked={enabled}
          onChange={(event) => onEnabled(event.target.checked)}
        />
      </label>
      <div className="field">
        <label htmlFor="mic-device">Microphone device</label>
        <select
          id="mic-device"
          value={deviceId || "default"}
          disabled={!enabled && compact}
          onChange={(event) => onDeviceId(event.target.value)}
        >
          <option value="default">Windows default</option>
          {devices.map((device) => (
            <option key={device.id} value={device.id}>
              {device.name}
              {device.isDefault ? " (Windows default)" : ""}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="mic-gain">Microphone volume ({gainPercent}%)</label>
        <input
          id="mic-gain"
          type="range"
          min={0}
          max={200}
          step={1}
          disabled={!enabled}
          value={gainPercent}
          onChange={(event) => onGain(Number(event.target.value) / 100)}
        />
      </div>
      <div className="audio-meter" aria-label="Microphone level" aria-hidden="true">
        <span style={{ width: `${Math.round(level * 100)}%` }} />
      </div>
      <p className="muted">Speak to test. Windows must allow Replayr to use the microphone.</p>
    </div>
  );
}
