import type { RecordingSource } from "../../recording/scene";
import type { DisplayInfo } from "../../recording/display/displayTypes";
import { DisplaySourceSettings } from "./sources/DisplaySourceSettings";

export function SourcePropertiesDialog({
  source,
  displays,
  listError = null,
  recording,
  onMonitorId,
  onClose,
}: {
  source: RecordingSource;
  displays: DisplayInfo[];
  listError?: string | null;
  recording: boolean;
  onMonitorId: (monitorId: string | null) => void;
  onClose: () => void;
}) {
  return (
    <div className="studio-modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="studio-modal"
        role="dialog"
        aria-labelledby="source-properties-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="studio-block-head">
          <h2 id="source-properties-title">{source.name}</h2>
          <button type="button" className="studio-icon-btn" onClick={onClose}>
            Close
          </button>
        </div>
        {source.type === "display" ? (
          <DisplaySourceSettings
            source={source}
            displays={displays}
            listError={listError}
            recording={recording}
            onMonitorId={onMonitorId}
          />
        ) : (
          <p className="studio-empty">No extra properties for this source.</p>
        )}
      </div>
    </div>
  );
}
