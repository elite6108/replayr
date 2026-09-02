export function StudioMeter({ level, compact }: { level: number; compact?: boolean }) {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(level) ? level : 0));
  return (
    <div className={`studio-meter${compact ? " studio-meter-mini" : ""}`} aria-hidden="true">
      <span className="studio-meter-fill" style={{ transform: `scaleX(${clamped.toFixed(3)})` }} />
    </div>
  );
}
