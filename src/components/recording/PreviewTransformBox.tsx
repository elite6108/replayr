import { useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { SourceTransform } from "../../recording/scene";
import { clampTransform } from "../../recording/scene";

type ResizeHandle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const HANDLES: ResizeHandle[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

export function PreviewTransformBox({
  transform,
  selected,
  locked,
  zIndex,
  label,
  onSelect,
  onTransform,
  children,
}: {
  transform: SourceTransform;
  selected: boolean;
  locked: boolean;
  zIndex: number;
  label: string;
  onSelect: () => void;
  onTransform: (next: SourceTransform) => void;
  children: ReactNode;
}) {
  const dragRef = useRef<{
    mode: "move" | ResizeHandle;
    startX: number;
    startY: number;
    origin: SourceTransform;
  } | null>(null);

  function begin(event: ReactPointerEvent<HTMLElement>, mode: "move" | ResizeHandle) {
    event.preventDefault();
    event.stopPropagation();
    onSelect();
    if (locked) return;
    const canvas = event.currentTarget.closest(".preview-canvas");
    if (!(canvas instanceof HTMLElement)) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    dragRef.current = {
      mode,
      startX: event.clientX,
      startY: event.clientY,
      origin: transform,
    };
    event.currentTarget.setPointerCapture(event.pointerId);

    const onMove = (moveEvent: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const dx = (moveEvent.clientX - drag.startX) / rect.width;
      const dy = (moveEvent.clientY - drag.startY) / rect.height;
      onTransform(applyDrag(drag.origin, drag.mode, dx, dy));
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  return (
    <div
      className={`preview-layer${selected ? " is-selected" : ""}${locked ? " is-locked" : ""}`}
      style={{
        left: `${transform.x * 100}%`,
        top: `${transform.y * 100}%`,
        width: `${transform.w * 100}%`,
        height: `${transform.h * 100}%`,
        zIndex,
      }}
      onPointerDown={(event) => begin(event, "move")}
    >
      {children}
      {selected ? (
        <div className="preview-layer-chrome" aria-hidden="true">
          <span className="preview-layer-label">{label}</span>
          {!locked
            ? HANDLES.map((handle) => (
                <button
                  key={handle}
                  type="button"
                  className={`preview-handle handle-${handle}`}
                  tabIndex={-1}
                  onPointerDown={(event) => begin(event, handle)}
                />
              ))
            : null}
        </div>
      ) : null}
    </div>
  );
}

function applyDrag(origin: SourceTransform, mode: "move" | ResizeHandle, dx: number, dy: number): SourceTransform {
  if (mode === "move") {
    return clampTransform({ ...origin, x: origin.x + dx, y: origin.y + dy });
  }
  let { x, y, w, h } = origin;
  if (mode.includes("e")) w += dx;
  if (mode.includes("s")) h += dy;
  if (mode.includes("w")) {
    w -= dx;
    x += dx;
  }
  if (mode.includes("n")) {
    h -= dy;
    y += dy;
  }
  return clampTransform({ x, y, w, h });
}
