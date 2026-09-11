import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { SourceCrop, SourceTransform } from "../../recording/scene";
import { clampCrop, clampTransform, FULL_CROP, isFullCrop } from "../../recording/scene";

type ResizeHandle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const HANDLES: ResizeHandle[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

export function PreviewTransformBox({
  transform,
  crop,
  mode = "move",
  selected,
  locked,
  zIndex,
  label,
  onSelect,
  onTransform,
  onCrop,
  children,
}: {
  transform: SourceTransform;
  crop?: SourceCrop | null;
  mode?: "move" | "crop";
  selected: boolean;
  locked: boolean;
  zIndex: number;
  label: string;
  onSelect: () => void;
  onTransform: (next: SourceTransform) => void;
  onCrop?: (next: SourceCrop) => void;
  children: ReactNode;
}) {
  const dragRef = useRef<{
    kind: "transform" | "crop";
    mode: "move" | ResizeHandle;
    startX: number;
    startY: number;
    origin: SourceTransform | SourceCrop;
    boxW: number;
    boxH: number;
    canvasW: number;
    canvasH: number;
  } | null>(null);
  const [shiftCropActive, setShiftCropActive] = useState(false);

  const cropMode = mode === "crop" && Boolean(onCrop);
  const activeCrop = crop ?? FULL_CROP;
  const showCropChrome = cropMode || shiftCropActive || (selected && !isFullCrop(activeCrop) && Boolean(onCrop));

  function begin(event: ReactPointerEvent<HTMLElement>, handle: "move" | ResizeHandle) {
    event.preventDefault();
    event.stopPropagation();
    onSelect();
    if (locked) return;
    const canvas = event.currentTarget.closest(".preview-canvas");
    if (!(canvas instanceof HTMLElement)) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const boxW = transform.w * rect.width;
    const boxH = transform.h * rect.height;
    if (boxW <= 0 || boxH <= 0) return;

    // Move mode + Shift: crop instead of move/resize. Crop mode always crops.
    // Gesture kind is locked at pointerdown; releasing Shift ends after this drag.
    const useCrop = Boolean(onCrop) && (cropMode || event.shiftKey);
    if (useCrop) {
      setShiftCropActive(!cropMode);
      dragRef.current = {
        kind: "crop",
        mode: handle,
        startX: event.clientX,
        startY: event.clientY,
        origin: { ...activeCrop },
        boxW,
        boxH,
        canvasW: rect.width,
        canvasH: rect.height,
      };
    } else {
      setShiftCropActive(false);
      dragRef.current = {
        kind: "transform",
        mode: handle,
        startX: event.clientX,
        startY: event.clientY,
        origin: { ...transform },
        boxW,
        boxH,
        canvasW: rect.width,
        canvasH: rect.height,
      };
    }

    event.currentTarget.setPointerCapture(event.pointerId);

    const onMove = (moveEvent: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;

      // If Shift is released mid-drag in move mode, fall back to transform for the rest.
      if (drag.kind === "crop" && !cropMode && !moveEvent.shiftKey && onCrop) {
        setShiftCropActive(false);
        dragRef.current = {
          kind: "transform",
          mode: drag.mode,
          startX: moveEvent.clientX,
          startY: moveEvent.clientY,
          origin: { ...transform },
          boxW: drag.boxW,
          boxH: drag.boxH,
          canvasW: drag.canvasW,
          canvasH: drag.canvasH,
        };
        return;
      }

      if (drag.kind === "crop" && onCrop) {
        const dx = (moveEvent.clientX - drag.startX) / drag.boxW;
        const dy = (moveEvent.clientY - drag.startY) / drag.boxH;
        onCrop(applyCropDrag(drag.origin as SourceCrop, drag.mode, dx, dy));
        return;
      }

      const dx = (moveEvent.clientX - drag.startX) / drag.canvasW;
      const dy = (moveEvent.clientY - drag.startY) / drag.canvasH;
      onTransform(applyDrag(drag.origin as SourceTransform, drag.mode, dx, dy));
    };

    const onUp = () => {
      dragRef.current = null;
      setShiftCropActive(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  return (
    <div
      className={`preview-layer${selected ? " is-selected" : ""}${locked ? " is-locked" : ""}${cropMode || shiftCropActive ? " is-cropping" : ""}`}
      style={{
        left: `${transform.x * 100}%`,
        top: `${transform.y * 100}%`,
        width: `${transform.w * 100}%`,
        height: `${transform.h * 100}%`,
        zIndex,
      }}
      title={onCrop && !locked ? "Drag to move · Shift+drag to crop" : undefined}
      onPointerDown={(event) => begin(event, "move")}
    >
      {children}
      {selected ? (
        <div className="preview-layer-chrome" aria-hidden="true">
          <span className="preview-layer-label">
            {cropMode || shiftCropActive ? `${label} · Crop` : label}
          </span>
          {showCropChrome ? (
            <div
              className="preview-crop-guide"
              style={{
                left: `${activeCrop.x * 100}%`,
                top: `${activeCrop.y * 100}%`,
                width: `${activeCrop.w * 100}%`,
                height: `${activeCrop.h * 100}%`,
              }}
            >
              {cropMode && !locked
                ? HANDLES.map((handle) => (
                    <button
                      key={handle}
                      type="button"
                      className={`preview-handle handle-${handle} is-crop`}
                      tabIndex={-1}
                      onPointerDown={(event) => begin(event, handle)}
                    />
                  ))
                : null}
            </div>
          ) : null}
          {!locked && !cropMode
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

/** Crop drag: body pans the UV window; handles resize it. */
function applyCropDrag(origin: SourceCrop, mode: "move" | ResizeHandle, dx: number, dy: number): SourceCrop {
  if (mode === "move") {
    return clampCrop({ ...origin, x: origin.x + dx, y: origin.y + dy });
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
  return clampCrop({ x, y, w, h });
}
