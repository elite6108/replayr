import { METER_MAX_DB, METER_MIN_DB, peakToMeterRatio } from "../../recording/useStudioAudio";

const SCALE_MARKS = [6, 0, -10, -20, -30, -40, -60];

/** Single-peak stereo-styled vertical VU (L/R mirror the same peak). */
export function VerticalAudioMeter({ level }: { level: number }) {
  const pct = `${(peakToMeterRatio(level) * 100).toFixed(1)}%`;

  return (
    <div className="studio-mix-vu" aria-hidden="true">
      <div className="studio-mix-vu-scale">
        {SCALE_MARKS.map((db) => (
          <span key={db} style={{ top: `${((METER_MAX_DB - db) / (METER_MAX_DB - METER_MIN_DB)) * 100}%` }}>
            {db > 0 ? `+${db}` : db}
          </span>
        ))}
      </div>
      <div className="studio-mix-vu-bars">
        <span className="studio-mix-vu-bar">
          <span className="studio-mix-vu-fill" style={{ height: pct }} />
        </span>
        <span className="studio-mix-vu-bar">
          <span className="studio-mix-vu-fill" style={{ height: pct }} />
        </span>
      </div>
    </div>
  );
}
