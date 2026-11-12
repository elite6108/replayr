import { useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";

export interface MenuItem {
  label: string;
  disabled?: boolean;
  danger?: boolean;
  onClick: () => void;
}

type OpenMenu = { token: symbol; close: () => void };

// Cards stop the contextmenu event, so a window listener never hears a
// right-click on the next card. This is the one place every menu shares.
let openMenu: OpenMenu | null = null;

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
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    const token = Symbol();
    const previous = openMenu;
    openMenu = { token, close: () => closeRef.current() };
    previous?.close();
    return () => {
      if (openMenu?.token === token) openMenu = null;
    };
  }, []);

  useEffect(() => {
    function hide() {
      closeRef.current();
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") closeRef.current();
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
  }, []);

  const left = Math.min(x, window.innerWidth - 200);
  const top = Math.min(y, window.innerHeight - items.length * 32 - 16);

  return createPortal(
    <div
      className="ctx-menu"
      role="menu"
      style={{ left, top }}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
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
