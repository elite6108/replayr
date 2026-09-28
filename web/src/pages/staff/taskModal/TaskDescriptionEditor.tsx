import { useRef, type ReactNode } from "react";

export function TaskDescriptionEditor({
  value,
  preview,
  focused,
  enabled,
  onFocus,
  onChange,
  onBlur,
  onPreviewClick,
}: {
  value: string;
  preview: ReactNode | null;
  focused: boolean;
  enabled: boolean;
  onFocus: () => void;
  onChange: (value: string) => void;
  onBlur: () => void;
  onPreviewClick: () => void;
}) {
  const areaRef = useRef<HTMLTextAreaElement>(null);

  function wrap(prefix: string, suffix = prefix, fallback = "text") {
    const area = areaRef.current;
    const start = area?.selectionStart ?? value.length;
    const end = area?.selectionEnd ?? value.length;
    const selected = value.slice(start, end) || fallback;
    const next = `${value.slice(0, start)}${prefix}${selected}${suffix}${value.slice(end)}`;
    onChange(next);
    window.requestAnimationFrame(() => {
      area?.focus();
      const cursor = start + prefix.length + selected.length + suffix.length;
      area?.setSelectionRange(cursor, cursor);
    });
  }

  function prefixLines(marker: string) {
    const area = areaRef.current;
    const start = area?.selectionStart ?? 0;
    const end = area?.selectionEnd ?? 0;
    const block = value.slice(start, end) || "item";
    const nextBlock = block
      .split("\n")
      .map((line) => (line.startsWith(marker) ? line : `${marker}${line || "item"}`))
      .join("\n");
    onChange(`${value.slice(0, start)}${nextBlock}${value.slice(end)}`);
  }

  return (
    <div className="task-modal-field">
      <label className="task-modal-label">Description</label>
      {focused || !preview ? (
        <div className="task-modal-editor">
          <textarea
            ref={areaRef}
            className="task-modal-textarea"
            value={value}
            disabled={!enabled}
            placeholder="Add a more detailed description…"
            onFocus={onFocus}
            onChange={(event) => onChange(event.target.value)}
            onBlur={onBlur}
          />
          <div className="task-modal-toolbar" role="toolbar" aria-label="Description formatting">
            <button type="button" disabled={!enabled} onMouseDown={(event) => event.preventDefault()} onClick={() => wrap("**")} title="Bold">
              B
            </button>
            <button type="button" disabled={!enabled} onMouseDown={(event) => event.preventDefault()} onClick={() => wrap("*")} title="Italic">
              I
            </button>
            <button type="button" disabled={!enabled} onMouseDown={(event) => event.preventDefault()} onClick={() => prefixLines("- ")} title="Bulleted list">
              •
            </button>
            <button type="button" disabled={!enabled} onMouseDown={(event) => event.preventDefault()} onClick={() => prefixLines("1. ")} title="Numbered list">
              1.
            </button>
            <button type="button" disabled={!enabled} onMouseDown={(event) => event.preventDefault()} onClick={() => wrap("[", "](https://)", "link")} title="Link">
              ↗
            </button>
            <span className="task-modal-toolbar-spacer" />
            <button type="button" disabled title="Image attachment uses Add → Attachment">
              ⌕
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="task-modal-preview" onClick={onPreviewClick}>
          {preview}
        </button>
      )}
    </div>
  );
}
