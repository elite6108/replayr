import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { clampDockPx, dockPxFromPointer, loadDockMaxPx, persistDockMaxPx, DOCK_DEFAULT_PX } from "./dockSplit";

export type StudioTab = "recording" | "clip";

const TABS: { id: StudioTab; label: string; hint: string }[] = [
  { id: "recording", label: "Recordings", hint: "Full-length recordings" },
  { id: "clip", label: "Clips", hint: "How saved Instant Replay clips are framed" },
];

/**
 * The chrome both Record studios share: the page header with the studio tabs, the workspace
 * grid, and the preview/dock splitter.
 *
 * Grid placement comes from the CSS class on each panel (see recording-workspace.css), not from
 * DOM nesting, so `children` can be a flat fragment of panels.
 */
export function StudioShell({
  tab,
  onTab,
  children,
}: {
  tab: StudioTab;
  onTab: (tab: StudioTab) => void;
  children: ReactNode;
}) {
  const [dockMaxPx, setDockMaxPx] = useState(DOCK_DEFAULT_PX);
  const workspaceRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const height = workspaceRef.current?.getBoundingClientRect().height ?? 0;
    setDockMaxPx(clampDockPx(loadDockMaxPx(), height));
  }, []);

  function beginDockSplit(event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    const workspace = event.currentTarget.closest(".record-workspace");
    if (!(workspace instanceof HTMLElement)) return;

    event.currentTarget.setPointerCapture(event.pointerId);
    setDockMaxPx(dockPxFromPointer(workspace, event.clientY));

    const onMove = (moveEvent: PointerEvent) => {
      setDockMaxPx(dockPxFromPointer(workspace, moveEvent.clientY));
    };
    const onUp = (upEvent: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const next = dockPxFromPointer(workspace, upEvent.clientY);
      setDockMaxPx(next);
      persistDockMaxPx(next);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  return (
    <div className="record-studio">
      <header className="studio-page-head">
        <h1>Record</h1>
        <div className="studio-tabs" role="tablist" aria-label="Record studio">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              className={`studio-tab${tab === item.id ? " is-active" : ""}`}
              title={item.hint}
              onClick={() => onTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </header>
      <div
        ref={workspaceRef}
        className="record-workspace"
        style={{ ["--record-dock-max" as string]: `${dockMaxPx}px` }}
      >
        {children}
        <button
          type="button"
          className="record-split"
          aria-label="Resize preview and mixer"
          title="Drag to resize preview"
          onPointerDown={beginDockSplit}
        />
      </div>
    </div>
  );
}
