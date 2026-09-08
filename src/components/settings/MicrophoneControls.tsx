import { useEffect, useState } from "react";
import { getMicLevel, stopMicMonitor } from "../../services/tauri";
import { MicrophoneDeviceSelect } from "../common/MicrophoneDeviceSelect";
import { peakToMeterRatio } from "../../recording/useStudioAudio";

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
  const [level, setLevel] = useState(0);

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
  const meterPct = peakToMeterRatio(level);

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
      <MicrophoneDeviceSelect
        id="mic-device"
        label="Microphone device"
        deviceId={deviceId}
        onDeviceId={onDeviceId}
        disabled={!enabled && compact}
      />
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
        <span style={{ width: `${(meterPct * 100).toFixed(1)}%` }} />
      </div>
      <p className="muted">Speak to test. Windows must allow Replayr to use the microphone.</p>
    </div>
  );
}
