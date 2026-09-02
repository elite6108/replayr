import type { ReactNode } from "react";
import type { PreviewBackgroundMode } from "../../types/settings";

export function PreviewCanvas({
  background,
  safeZone,
  quiet,
  plate,
  children,
}: {
  background: PreviewBackgroundMode;
  safeZone: boolean;
  quiet: boolean;
  plate?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={`preview-canvas bg-${background}${quiet ? " is-quiet" : ""}`}>
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
