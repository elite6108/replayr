import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { desktopCaptureSettingsOf, type RecordingSource } from "../../../recording/scene";
import { displayMeta, type DisplayInfo } from "../../../recording/display/displayTypes";
import { IconCheck, IconChevron } from "../../icons";

type DisplayOption = {
  id: string;
  title: string;
  meta: string;
  badge?: string;
};

export function DisplaySourceSettings({
  source,
  displays,
  listError = null,
  recording,
  onMonitorId,
}: {
  source: RecordingSource;
  displays: DisplayInfo[];
  listError?: string | null;
  recording: boolean;
  onMonitorId: (monitorId: string | null) => void;
}) {
  const selected = desktopCaptureSettingsOf(source).monitorId;
  const available = selected ? displays.some((display) => display.id === selected) : true;
  const options = useMemo<DisplayOption[]>(() => {
    const next: DisplayOption[] = [
      { id: "", title: "Primary", meta: "Use the current primary display" },
    ];
    if (selected && !available) {
      next.push({ id: selected, title: "Display unavailable", meta: "Saved display is not connected" });
    }
    for (const display of displays) {
      next.push({
        id: display.id,
        title: display.name,
        meta: displayMeta(display),
        badge: display.isPrimary ? "Primary" : undefined,
      });
    }
    return next;
  }, [available, displays, selected]);

  return (
    <div className="stack">
      <label className="studio-field">
        <span>Display</span>
        <DisplayCombo
          options={options}
          value={selected ?? ""}
          disabled={recording}
          onChange={(id) => onMonitorId(id || null)}
        />
      </label>
      {listError && displays.length === 0 ? (
        <p className="studio-lock-note">Could not list displays. {listError}</p>
      ) : null}
      {recording ? <p className="studio-lock-note">Stop recording to change display.</p> : null}
      {selected && !available ? (
        <p className="studio-lock-note">Display unavailable. Preview and new recordings use Primary until this display returns. The saved selection is kept.</p>
      ) : null}
    </div>
  );
}

function DisplayCombo({
  options,
  value,
  disabled,
  onChange,
}: {
  options: DisplayOption[];
  value: string;
  disabled: boolean;
  onChange: (id: string) => void;
}) {
  const listId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(value);
  const [menu, setMenu] = useState({ left: 0, top: 0, width: 0 });
  const current = options.find((option) => option.id === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    setActive(value);
    const trigger = triggerRef.current;
    if (trigger) setMenu(placeMenu(trigger, options.length));
    function onPointer(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (triggerRef.current?.contains(target) || listRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    function onReposition() {
      if (triggerRef.current) setMenu(placeMenu(triggerRef.current, options.length));
    }
    listRef.current?.focus();
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onReposition);
    window.addEventListener("scroll", onReposition, true);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
    };
  }, [open, options.length, value]);

  function choose(id: string) {
    onChange(id);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function move(delta: number) {
    if (!options.length) return;
    const index = Math.max(0, options.findIndex((option) => option.id === active));
    const next = options[(index + delta + options.length) % options.length];
    if (next) setActive(next.id);
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`studio-combo${open ? " is-open" : ""}`}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => {
          if (!disabled) setOpen((next) => !next);
        }}
        onKeyDown={(event) => {
          if (disabled) return;
          if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="studio-combo-copy">
          <span className="studio-combo-title">{current?.title ?? "Primary"}</span>
          <span className="studio-combo-meta">{current?.meta}</span>
        </span>
        <IconChevron size={16} className="studio-combo-chevron" />
      </button>
      {open
        ? createPortal(
            <div
              ref={listRef}
              id={listId}
              className="studio-combo-menu"
              role="listbox"
              tabIndex={-1}
              style={{ left: menu.left, top: menu.top, width: menu.width }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  move(1);
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  move(-1);
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  choose(active);
                } else if (event.key === "Home") {
                  event.preventDefault();
                  setActive(options[0]?.id ?? "");
                } else if (event.key === "End") {
                  event.preventDefault();
                  setActive(options[options.length - 1]?.id ?? "");
                }
              }}
            >
              {options.map((option) => {
                const selected = option.id === value;
                return (
                  <button
                    key={option.id || "primary"}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    className={`studio-combo-option${selected ? " is-selected" : ""}${option.id === active ? " is-active" : ""}`}
                    onMouseEnter={() => setActive(option.id)}
                    onClick={() => choose(option.id)}
                  >
                    <span className="studio-combo-copy">
                      <span className="studio-combo-title">
                        {option.title}
                        {option.badge ? <em>{option.badge}</em> : null}
                      </span>
                      <span className="studio-combo-meta">{option.meta}</span>
                    </span>
                    {selected ? <IconCheck size={16} className="studio-combo-check" /> : null}
                  </button>
                );
              })}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function placeMenu(trigger: HTMLElement, count: number) {
  const rect = trigger.getBoundingClientRect();
  const height = Math.min(280, count * 56 + 12);
  const spaceBelow = window.innerHeight - rect.bottom - 8;
  const openUp = spaceBelow < height && rect.top > spaceBelow;
  return {
    left: Math.max(8, rect.left),
    width: Math.max(rect.width, 220),
    top: openUp ? Math.max(8, rect.top - height - 4) : rect.bottom + 4,
  };
}
