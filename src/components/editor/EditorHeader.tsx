import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowClockwise, ArrowCounterClockwise, ArrowLeft, Export } from "@phosphor-icons/react";
import { Link } from "react-router-dom";

export function EditorHeader({
  title,
  meta,
  backTo,
  onBack,
  badge,
  saving,
  menu,
}: {
  title: string;
  meta: string;
  backTo: string;
  onBack: () => void;
  badge?: string;
  saving: boolean;
  menu: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <header className="editor-header">
      <Link to={backTo} className="editor-back" aria-label="Back" onClick={onBack}>
        <ArrowLeft size={16} weight="bold" />
      </Link>
      <div className="editor-heading">
        <h1>
          {title}
          {badge ? <span className="editor-badge">{badge}</span> : null}
        </h1>
        <p>{meta}</p>
      </div>
      <div className="editor-header-actions">
        <button type="button" className="editor-icon-btn" disabled title="Coming later" aria-label="Undo">
          <ArrowCounterClockwise size={15} />
        </button>
        <button type="button" className="editor-icon-btn" disabled title="Coming later" aria-label="Redo">
          <ArrowClockwise size={15} />
        </button>
        <div className="editor-save" ref={rootRef}>
          <button
            type="button"
            className="btn primary editor-save-btn"
            disabled={saving}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            <Export size={15} weight="bold" />
            {saving ? "Saving…" : "Save Clip"}
          </button>
          {open ? (
            <div className="editor-save-menu" role="menu" onClick={() => setOpen(false)}>
              {menu}
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}
