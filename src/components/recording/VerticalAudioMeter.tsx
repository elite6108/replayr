import { peakToMeterRatio } from "../../recording/useStudioAudio";

/** Single-peak stereo-styled vertical VU (L/R mirror the same peak). */
export function VerticalAudioMeter({ level }: { level: number }) {
  const pct = `${(peakToMeterRatio(level) * 100).toFixed(1)}%`;

  return (
    <div className="studio-mix-vu" aria-hidden="true">
      <div className="studio-mix-vu-scale">
        <span>+6</span>
        <span>0</span>
        <span>-10</span>
        <span>-20</span>
        <span>-30</span>
        <span>-40</span>
        <span>-60</span>
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
