import { peakToMeterRatio } from "../../recording/useStudioAudio";

export function StudioMeter({ level, compact }: { level: number; compact?: boolean }) {
  const ratio = peakToMeterRatio(level);
  return (
    <div className={`studio-meter${compact ? " studio-meter-mini" : ""}`} aria-hidden="true">
      <span className="studio-meter-fill" style={{ width: `${(ratio * 100).toFixed(1)}%` }} />
    </div>
  );
}
