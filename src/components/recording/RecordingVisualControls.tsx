import { filterComposedSupported } from "../../recording/registry";
import { VISUAL_FILTERS, visualsForFilterSelect } from "../../recording/visualFilters";
import { trackFilterApplied, trackFilterSelected } from "../../services/analytics";
import type { GameplayVisualFilter, RecordingVisualSettings } from "../../types/settings";

export function RecordingVisualControls({
  visuals,
  onChange,
  composed,
}: {
  visuals: RecordingVisualSettings;
  onChange: (next: RecordingVisualSettings) => Promise<void>;
  composed?: boolean;
}) {
  function selectFilter(id: GameplayVisualFilter) {
    if (id === visuals.filter) return;
    trackFilterSelected(id);
    trackFilterApplied(id);
    void onChange(visualsForFilterSelect(id));
  }

  function toggleOverlay(key: "recIndicator" | "timestamp", value: boolean) {
    void onChange({
      ...visuals,
      overlays: {
        ...visuals.overlays,
        [key]: value,
      },
    });
  }

  return (
    <div className="stack recording-visuals">
      <div className="field">
        <span className="settings-group-label">Filter</span>
        <div className="visual-filter-row" role="group" aria-label="Gameplay visual filter">
          {VISUAL_FILTERS.map((item) => {
            const available = !composed || filterComposedSupported(item.id);
            return (
              <button
                key={item.id}
                type="button"
                className={`chip ${visuals.filter === item.id ? "on" : ""}`}
                title={available ? item.description : "Not yet available in composed recording"}
                disabled={!available}
                onClick={() => available && selectFilter(item.id)}
              >
                {item.label}
                {!available ? <small>Unavailable</small> : null}
              </button>
            );
          })}
        </div>
        <p className="muted">{VISUAL_FILTERS.find((item) => item.id === visuals.filter)?.description}</p>
      </div>
      <label className="setting-row">
        <span className="setting-copy">
          REC indicator
          <small>Stays as you set it after a filter is selected.</small>
        </span>
        <input
          className="switch"
          type="checkbox"
          checked={visuals.overlays.recIndicator}
          onChange={(event) => toggleOverlay("recIndicator", event.target.checked)}
        />
      </label>
      <label className="setting-row">
        <span className="setting-copy">
          Timestamp
          <small>Independent of the selected filter.</small>
        </span>
        <input
          className="switch"
          type="checkbox"
          checked={visuals.overlays.timestamp}
          onChange={(event) => toggleOverlay("timestamp", event.target.checked)}
        />
      </label>
    </div>
  );
}
