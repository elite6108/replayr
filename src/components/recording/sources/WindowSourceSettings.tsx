import { useEffect, useState } from "react";
import { windowTargetOf, type WindowTarget } from "../../../recording/sourceVisual";
import type { RecordingSource } from "../../../recording/scene";
import { listCaptureWindows, type ListedWindow } from "../../../services/tauri";

export function WindowSourceSettings({
  source,
  onChange,
}: {
  source: RecordingSource;
  onChange: (target: WindowTarget) => void;
}) {
  const target = windowTargetOf(source);
  const [windows, setWindows] = useState<ListedWindow[]>([]);
  const [error, setError] = useState("");
  const selected = windowKey(target);

  useEffect(() => {
    let cancelled = false;
    void listCaptureWindows()
      .then((listed) => {
        if (!cancelled) setWindows(listed);
      })
      .catch(() => {
        if (!cancelled) setError("Windows could not be listed.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="studio-section">
      <div className="field">
        <label htmlFor="record-window">Window</label>
        <select
          id="record-window"
          value={windows.some((item) => windowKey(item) === selected) ? selected : ""}
          onChange={(event) => {
            const found = windows.find((item) => windowKey(item) === event.target.value);
            if (found) onChange({ title: found.title, className: found.className, exe: found.exe });
          }}
        >
          <option value="">{target.title || target.exe || "Select a window"}</option>
          {windows.map((item) => (
            <option key={windowKey(item)} value={windowKey(item)}>
              {item.title || item.exe}
            </option>
          ))}
        </select>
      </div>
      <p className="studio-section-copy">Replayr finds this window again by its title, then its program, then its class.</p>
      {error ? <p className="studio-empty">{error}</p> : null}
    </div>
  );
}

function windowKey(target: WindowTarget): string {
  return `${target.title}\u0000${target.className}\u0000${target.exe}`;
}
