import { useEffect, useRef, useState } from "react";

export function InlineRename({
  value,
  onSave,
  className,
  enabled,
  editing,
  onEditingChange,
  ariaLabel,
  placeholder,
  allowEmpty = false,
  activate = "click",
}: {
  value: string;
  onSave: (next: string) => Promise<void> | void;
  className?: string;
  enabled: boolean;
  editing: boolean;
  onEditingChange: (open: boolean) => void;
  ariaLabel: string;
  placeholder?: string;
  allowEmpty?: boolean;
  activate?: "click" | "doubleClick";
}) {
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      setDraft(value);
      window.requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [editing, value]);

  function start() {
    if (!enabled) return;
    onEditingChange(true);
  }

  async function commit() {
    const next = draft.trim();
    onEditingChange(false);
    if (!allowEmpty && !next) return;
    if (next === value.trim()) return;
    await onSave(next);
  }

  function cancel() {
    setDraft(value);
    onEditingChange(false);
  }

  if (editing && enabled) {
    return (
      <input
        ref={inputRef}
        className={`ops-rename-input${className ? ` ${className}` : ""}`}
        value={draft}
        aria-label={ariaLabel}
        placeholder={placeholder}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => void commit()}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") {
            event.preventDefault();
            void commit();
          }
          if (event.key === "Escape") {
            event.preventDefault();
            cancel();
          }
        }}
      />
    );
  }

  const shown = value.trim() || placeholder || "Untitled";
  const empty = !value.trim();
  if (!enabled) {
    return <span className={className}>{shown}</span>;
  }
  if (activate === "doubleClick") {
    return (
      <span className={`${className ?? ""}${empty ? " is-placeholder" : ""}`} title="Double-click to rename">
        {shown}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={`ops-rename-display${className ? ` ${className}` : ""}${empty ? " is-placeholder" : ""}`}
      onClick={(event) => {
        event.stopPropagation();
        start();
      }}
      title="Click to rename"
      aria-label={`Rename ${ariaLabel}`}
    >
      {shown}
    </button>
  );
}
