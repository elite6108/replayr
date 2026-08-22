import { useEffect } from "react";
import { createPortal } from "react-dom";

export interface MenuItem {
  label: string;
  disabled?: boolean;
  danger?: boolean;
  onClick: () => void;
}

export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}) {
  useEffect(() => {
    function hide() {
      onClose();
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    const timer = window.setTimeout(() => {
      window.addEventListener("click", hide);
      window.addEventListener("contextmenu", hide);
      window.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("click", hide);
      window.removeEventListener("contextmenu", hide);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const left = Math.min(x, window.innerWidth - 200);
  const top = Math.min(y, window.innerHeight - items.length * 32 - 16);

  return createPortal(
    <div className="ctx-menu" role="menu" style={{ left, top }} onClick={(event) => event.stopPropagation()}>
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className={item.danger ? "danger" : undefined}
          disabled={item.disabled}
          onClick={() => {
            if (item.disabled) return;
            item.onClick();
            onClose();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
