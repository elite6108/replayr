import type { GameplayVisualFilter } from "../../types/settings";
import { visualFilterDefinition } from "../../recording/visualFilters";

export function PreviewFilterLayer({
  filter,
  quiet,
}: {
  filter: GameplayVisualFilter;
  quiet: boolean;
}) {
  if (filter === "none") return null;
  const definition = visualFilterDefinition(filter);
  return (
    <div className={`preview-filter filter-${filter}${quiet ? " is-quiet" : ""}`} aria-hidden="true">
      {filter === "vhs" ? <div className="preview-scanlines" /> : null}
      {filter === "bodycam" || filter === "cinematic" || filter === "dashcam" ? <div className="preview-vignette" /> : null}
      {filter === "cinematic" ? <div className="preview-letterbox" /> : null}
      {filter === "dashcam" ? <div className="preview-dash-frame" /> : null}
      {filter === "bodycam" ? <div className="preview-lens" /> : null}
      {filter === "bodycam" || filter === "dashcam" ? (
        <span className="preview-hud-label">{definition.label.toUpperCase()}</span>
      ) : null}
    </div>
  );
}
