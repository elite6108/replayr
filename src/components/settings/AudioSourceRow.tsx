import type { AudioSourceStatus } from "../../types/audio";

interface AudioSourceRowProps {
  title: string;
  copy: string;
  enabled: boolean;
  gain?: number;
  status?: AudioSourceStatus | null;
  disabled?: boolean;
  onEnabled: (enabled: boolean) => void;
  onGain?: (gain: number) => void;
  onUseDesktop?: () => void;
}

export function AudioSourceRow({
  title,
  copy,
  enabled,
  gain,
  status,
  disabled = false,
  onEnabled,
  onGain,
  onUseDesktop,
}: AudioSourceRowProps) {
  const peak = Math.max(0, Math.min(1, status?.peak ?? 0));
  const failed = Boolean(status?.isolationFailed);
  const label = status?.status || copy;

  return (
    <div className="audio-source">
      <label className="setting-row">
        <span className="setting-copy">
          {title}
          <small>{label}</small>
        </span>
        <span className="audio-source-controls">
          <span className="audio-meter" aria-hidden="true">
            <span style={{ width: `${Math.round(peak * 100)}%` }} />
          </span>
          <input
            className="switch"
            type="checkbox"
            checked={enabled}
            disabled={disabled}
            onChange={(event) => onEnabled(event.target.checked)}
          />
        </span>
      </label>
      {onGain && enabled ? (
        <div className="field">
          <label>{title} volume ({Math.round((gain ?? 1) * 100)}%)</label>
          <input
            type="range"
            min={0}
            max={200}
            step={1}
            disabled={disabled}
            value={Math.round((gain ?? 1) * 100)}
            onChange={(event) => onGain(Number(event.target.value) / 100)}
          />
        </div>
      ) : null}
      {failed && onUseDesktop ? (
        <button type="button" className="btn sm" onClick={onUseDesktop}>
          Use Desktop Audio Instead
        </button>
      ) : null}
    </div>
  );
}
