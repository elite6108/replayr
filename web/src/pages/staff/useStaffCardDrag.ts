import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

const THRESHOLD = 7;

export type CardDropTarget = {
  columnId: string;
  beforeTaskId: string | null;
};

type DragSession = {
  pointerId: number;
  taskId: string;
  fromColumnId: string;
  startX: number;
  startY: number;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
      title: string;
      active: boolean;
      lastX: number;
      lastY: number;
    };

export function useStaffCardDrag(enabled: boolean, kanbanRef: RefObject<HTMLElement | null>) {
  const session = useRef<DragSession | null>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const lastOver = useRef<CardDropTarget | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [ghost, setGhost] = useState<{ title: string; width: number; height: number } | null>(null);
  const [over, setOver] = useState<CardDropTarget | null>(null);
  const skipClick = useRef(false);

  function placeGhost(x: number, y: number, offsetX: number, offsetY: number) {
    const node = ghostRef.current;
    if (!node) return;
    node.style.transform = `translate3d(${x - offsetX}px, ${y - offsetY}px, 0)`;
  }

  function hitTest(x: number, y: number, taskId: string): CardDropTarget | null {
    const stack = document.elementsFromPoint(x, y);
    let columnId: string | null = null;
    let beforeTaskId: string | null = null;
    for (const node of stack) {
      if (!(node instanceof HTMLElement)) continue;
      const task = node.closest("[data-ops-task]") as HTMLElement | null;
      if (task?.dataset.opsTask && task.dataset.opsTask !== taskId) {
        beforeTaskId = task.dataset.opsTask;
        columnId = task.dataset.opsColumn ?? columnId;
        break;
      }
      const column = node.closest("[data-ops-column]") as HTMLElement | null;
      if (column?.dataset.opsColumn) {
        columnId = column.dataset.opsColumn;
        break;
      }
    }
    if (!columnId) return null;
    return { columnId, beforeTaskId };
  }

  function autoScroll(x: number, y: number) {
    const kanban = kanbanRef.current;
    if (kanban) {
      const box = kanban.getBoundingClientRect();
      if (x < box.left + 56) kanban.scrollLeft -= 18;
      else if (x > box.right - 56) kanban.scrollLeft += 18;
    }
    const columnBody = document.elementFromPoint(x, y)?.closest(".ops-column-body");
    if (columnBody instanceof HTMLElement) {
      const box = columnBody.getBoundingClientRect();
      if (y < box.top + 36) columnBody.scrollTop -= 14;
      else if (y > box.bottom - 36) columnBody.scrollTop += 14;
    }
  }

  function updateOver(next: CardDropTarget | null) {
    const prev = lastOver.current;
    if (prev?.columnId === next?.columnId && prev?.beforeTaskId === next?.beforeTaskId) return;
    lastOver.current = next;
    setOver(next);
  }

  useLayoutEffect(() => {
    const drag = session.current;
    if (!ghost || !drag) return;
    placeGhost(drag.lastX, drag.lastY, drag.offsetX, drag.offsetY);
  }, [ghost]);

  useEffect(() => {
    function onMove(event: PointerEvent) {
      const drag = session.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (!drag.active) {
        if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < THRESHOLD) return;
        drag.active = true;
        skipClick.current = true;
        setDraggingId(drag.taskId);
        setGhost({ title: drag.title, width: drag.width, height: drag.height });
      }
      drag.lastX = event.clientX;
      drag.lastY = event.clientY;
      placeGhost(event.clientX, event.clientY, drag.offsetX, drag.offsetY);
      autoScroll(event.clientX, event.clientY);
      updateOver(hitTest(event.clientX, event.clientY, drag.taskId));
    }

    function onUp(event: PointerEvent) {
      const drag = session.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      const target = drag.active ? lastOver.current : null;
      const result = drag.active
        ? {
            taskId: drag.taskId,
            fromColumnId: drag.fromColumnId,
            target,
          }
        : null;
      session.current = null;
      lastOver.current = null;
      setDraggingId(null);
      setGhost(null);
      setOver(null);
      if (result) onDropped.current?.(result);
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [kanbanRef]);

  const onDropped = useRef<
    ((result: { taskId: string; fromColumnId: string; target: CardDropTarget | null }) => void) | null
  >(null);

  function startFromPointer(event: ReactPointerEvent, task: { id: string; title: string }, columnId: string) {
    if (!enabled || event.button !== 0) return false;
    const target = event.target as HTMLElement;
    if (target.closest("button, input, textarea, select, a, .ops-assignee-picker, .ops-rename-input")) return false;
    const card = event.currentTarget as HTMLElement;
    const box = card.getBoundingClientRect();
    skipClick.current = false;
    session.current = {
      pointerId: event.pointerId,
      taskId: task.id,
      fromColumnId: columnId,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: event.clientX - box.left,
      offsetY: event.clientY - box.top,
      width: box.width,
      height: box.height,
      title: task.title,
      active: false,
      lastX: event.clientX,
      lastY: event.clientY,
    };
    try {
      card.setPointerCapture(event.pointerId);
    } catch {
      /* capture is optional */
    }
    return true;
  }

  function consumeClick() {
    if (!skipClick.current) return false;
    skipClick.current = false;
    return true;
  }

  return {
    draggingId,
    ghost,
    ghostRef,
    over,
    startFromPointer,
    consumeClick,
    onDropped,
  };
}
