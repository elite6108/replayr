import type { ReactNode } from "react";
import type { GameplayVisualFilter, PreviewBackgroundMode } from "../../types/settings";

export function PreviewCanvas({
  background,
  safeZone,
  quiet,
  plate,
  tune,
  children,
}: {
  background: PreviewBackgroundMode;
  safeZone: boolean;
  quiet: boolean;
  plate?: ReactNode;
  /**
   * Base-filter colour grading, applied to the gameplay plate only — never to the overlay
   * layers above it. Stage 2 of the composed pipeline (`composedSemantics.ts`), and what the
   * offline clip burn reproduces from `filters::tune_for`.
   */
  tune?: GameplayVisualFilter;
  children: ReactNode;
}) {
  const tuneClass = tune && tune !== "none" ? ` tune-${tune}` : "";
  return (
    <div className={`preview-canvas bg-${background}${quiet ? " is-quiet" : ""}${tuneClass}`}>
      {plate ?? (background === "mock" ? <MockGameplay /> : <div className="preview-dark" />)}
      {children}
      {safeZone ? <div className="preview-safe-zone" aria-hidden="true" /> : null}
    </div>
  );
}

function MockGameplay() {
  return (
    <div className="preview-mock" aria-hidden="true">
      <div className="preview-mock-sky" />
      <div className="preview-mock-ridge" />
      <div className="preview-mock-ground" />
      <div className="preview-mock-road" />
      <div className="preview-mock-mark">REPLAYR</div>
    </div>
  );
}
