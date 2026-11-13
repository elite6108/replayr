import { useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getObsImportContext, type ObsCollectionRef, type ObsImportContext } from "../../services/obsImport";
import { loadObsImportPlan } from "../../recording/obs/loadObsImport";
import type { ObsDevicePlan, ObsImportPlan, ObsReportEntry, ObsReportStatus } from "../../recording/obs/obsImport";
import type { RecordingScene } from "../../recording/scene";
import { MAX_SCENE_LIBRARY } from "../../recording/sceneLibrary";

const STATUS_LABEL: Record<ObsReportStatus, string> = {
  imported: "Imported",
  approximated: "Adjusted",
  skipped: "Skipped",
};

const BROWSE_VALUE = "__browse__";

export function ImportObsDialog({
  existingCount,
  locked,
  onImport,
  onClose,
}: {
  existingCount: number;
  locked: boolean;
  onImport: (scenes: RecordingScene[], devices: ObsDevicePlan | null) => void;
  onClose: () => void;
}) {
  const [context, setContext] = useState<ObsImportContext | null>(null);
  const [ref, setRef] = useState<ObsCollectionRef | null>(null);
  const [browsedName, setBrowsedName] = useState("");
  const [plan, setPlan] = useState<ObsImportPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [expanded, setExpanded] = useState<number | null>(null);
  const [useDevices, setUseDevices] = useState(true);
  const request = useRef(0);
  const room = Math.max(0, MAX_SCENE_LIBRARY - existingCount);

  useEffect(() => {
    let cancelled = false;
    getObsImportContext()
      .then((next) => {
        if (cancelled) return;
        setContext(next);
        const first = next.collections.find((item) => item.current) ?? next.collections[0];
        if (first) setRef({ file: first.file });
        else setLoading(false);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setError(caught instanceof Error ? caught.message : "Could not read the OBS settings.");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!ref || !context) return;
    const id = ++request.current;
    setLoading(true);
    setError(null);
    setPlan(null);
    setExpanded(null);
    void loadObsImportPlan(ref, context).then((result) => {
      if (id !== request.current) return;
      setLoading(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setPlan(result.plan);
      setSelected(new Set(result.plan.scenes.map((_, index) => index).slice(0, room)));
    });
  }, [ref, context, room]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function browse() {
    const picked = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "OBS scene collection", extensions: ["json"] }],
    });
    if (typeof picked !== "string" || !picked) return;
    setBrowsedName(picked.split(/[\\/]/).pop() ?? picked);
    setRef({ path: picked });
  }

  const deviceLines = useMemo(() => (plan ? describeDevices(plan.devices) : []), [plan]);
  const chosen = plan ? plan.scenes.filter((_, index) => selected.has(index)) : [];
  const overLimit = chosen.length > room;
  const selectValue = ref && "file" in ref ? ref.file : ref ? BROWSE_VALUE : "";

  function toggleScene(index: number) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  function confirm() {
    if (!plan || !chosen.length || overLimit || locked) return;
    onImport(
      chosen.map((entry) => entry.scene),
      useDevices && deviceLines.length ? plan.devices : null,
    );
  }

  return (
    <div className="studio-modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="studio-modal obs-import-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="obs-import-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="studio-block-head">
          <h2 id="obs-import-title">Import from OBS</h2>
          <button type="button" className="studio-icon-btn" onClick={onClose}>
            Close
          </button>
        </div>
        <p className="obs-import-copy">
          Copies your OBS scenes into new Replayr scenes. Your existing scenes and OBS itself are not changed.
        </p>
        {locked ? <p className="studio-lock-note">Stop recording to import scenes.</p> : null}

        <div className="obs-import-source">
          <label className="studio-field">
            <span>Scene collection</span>
            <select
              value={selectValue}
              disabled={loading && !plan && !error}
              onChange={(event) => {
                if (event.target.value === BROWSE_VALUE) return;
                setRef({ file: event.target.value });
              }}
            >
              {!context?.collections.length && selectValue !== BROWSE_VALUE ? <option value="">No collections found</option> : null}
              {context?.collections.map((item) => (
                <option key={item.file} value={item.file}>
                  {item.name}
                  {item.current ? " (open in OBS)" : ""}
                </option>
              ))}
              {selectValue === BROWSE_VALUE ? <option value={BROWSE_VALUE}>{browsedName}</option> : null}
            </select>
          </label>
          <button type="button" className="studio-tool" onClick={() => void browse()}>
            Browse…
          </button>
        </div>
        {context && !context.installed && !ref ? (
          <p className="obs-import-copy">
            OBS Studio settings were not found for this Windows user. If you use portable OBS, choose the collection
            file with Browse. It is in the OBS folder under config\obs-studio\basic\scenes.
          </p>
        ) : null}

        {loading ? <p className="obs-import-status">Reading scenes…</p> : null}
        {error ? (
          <p className="obs-import-error" role="alert">
            {error}
          </p>
        ) : null}

        {plan ? (
          <>
            {plan.scenes.length ? (
              <ul className="obs-import-scenes">
                {plan.scenes.map((entry, index) => {
                  const counts = countStatuses(entry.entries);
                  const open = expanded === index;
                  return (
                    <li key={`${entry.name}-${index}`} className="obs-import-scene">
                      <div className="obs-import-scene-row">
                        <label className="obs-import-check">
                          <input type="checkbox" checked={selected.has(index)} onChange={() => toggleScene(index)} />
                          <span className="obs-import-scene-name">{entry.name}</span>
                        </label>
                        <button
                          type="button"
                          className="obs-import-summary"
                          aria-expanded={open}
                          onClick={() => setExpanded(open ? null : index)}
                        >
                          {summaryText(entry.scene.sources.length, counts)}
                        </button>
                      </div>
                      {open ? <ReportList entries={entry.entries} empty="No sources in this scene." /> : null}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="obs-import-status">This collection has no scenes.</p>
            )}

            {plan.globalEntries.length ? (
              <details className="obs-import-global">
                <summary>Audio in every scene</summary>
                <ReportList entries={plan.globalEntries} empty="" />
              </details>
            ) : null}

            {deviceLines.length || plan.devices.notes.length ? (
              <section className="obs-import-devices">
                {deviceLines.length ? (
                  <label className="obs-import-check">
                    <input type="checkbox" checked={useDevices} onChange={(event) => setUseDevices(event.target.checked)} />
                    <span>Use my OBS devices and volume levels</span>
                  </label>
                ) : null}
                {deviceLines.length ? (
                  <ul className="obs-import-device-lines">
                    {deviceLines.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                ) : null}
                {plan.devices.notes.map((note) => (
                  <p key={note} className="obs-import-note">
                    {note}
                  </p>
                ))}
              </section>
            ) : null}

            {overLimit ? (
              <p className="obs-import-error" role="alert">
                {room
                  ? `You have room for ${room} more scene${room === 1 ? "" : "s"}. Untick some, or delete scenes you no longer use.`
                  : `You already have ${MAX_SCENE_LIBRARY} scenes. Delete some to import more.`}
              </p>
            ) : null}
          </>
        ) : null}

        <div className="studio-dialog-actions">
          <button type="button" className="studio-tool" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="studio-tool is-on"
            disabled={locked || !plan || !chosen.length || overLimit}
            onClick={confirm}
          >
            {chosen.length === 1 ? "Import 1 scene" : `Import ${chosen.length} scenes`}
          </button>
        </div>
      </div>
    </div>
  );
}

function ReportList({ entries, empty }: { entries: ObsReportEntry[]; empty: string }) {
  if (!entries.length) return empty ? <p className="obs-import-note">{empty}</p> : null;
  return (
    <ul className="obs-import-report">
      {entries.map((entry, index) => (
        <li key={`${entry.name}-${index}`} className={`obs-import-entry is-${entry.status}`}>
          <span className="obs-import-badge">{STATUS_LABEL[entry.status]}</span>
          <span className="obs-import-entry-copy">
            <strong>{entry.name}</strong>
            <span className="obs-import-kind">{entry.kind}</span>
            {entry.notes.map((note) => (
              <span key={note} className="obs-import-note">
                {note}
              </span>
            ))}
          </span>
        </li>
      ))}
    </ul>
  );
}

function countStatuses(entries: ObsReportEntry[]): Record<ObsReportStatus, number> {
  const counts: Record<ObsReportStatus, number> = { imported: 0, approximated: 0, skipped: 0 };
  for (const entry of entries) counts[entry.status] += 1;
  return counts;
}

function summaryText(sourceCount: number, counts: Record<ObsReportStatus, number>): string {
  const parts = [`${sourceCount} source${sourceCount === 1 ? "" : "s"}`];
  if (counts.approximated) parts.push(`${counts.approximated} adjusted`);
  if (counts.skipped) parts.push(`${counts.skipped} skipped`);
  return parts.join(" · ");
}

function describeDevices(devices: ObsDevicePlan): string[] {
  const lines: string[] = [];
  if (devices.microphone) lines.push(`Microphone: ${devices.microphone.name} at ${Math.round(devices.microphone.gain * 100)}%`);
  if (devices.desktopGain !== null) lines.push(`Desktop audio volume: ${Math.round(devices.desktopGain * 100)}%`);
  if (devices.webcam) lines.push(`Webcam: ${devices.webcam.name}`);
  return lines;
}
