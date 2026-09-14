import { useEffect, useRef, useState } from "react";

export function SourceNameEdit({
  name,
  onCommit,
  onCancel,
}: {
  name: string;
  onCommit: (next: string) => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const skipBlur = useRef(false);
  const [draft, setDraft] = useState(name);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, []);

  function finish(next: string | null) {
    if (skipBlur.current) return;
    skipBlur.current = true;
    const trimmed = next?.trim() ?? "";
    if (!trimmed || trimmed === name) {
      onCancel();
      return;
    }
    onCommit(trimmed);
  }

  return (
    <input
      ref={inputRef}
      type="text"
      className="studio-source-rename"
      value={draft}
      maxLength={64}
      aria-label="Source name"
      onChange={(event) => setDraft(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          finish(draft);
        }
        if (event.key === "Escape") {
          event.preventDefault();
          finish(null);
        }
      }}
      onBlur={() => finish(draft)}
    />
  );
}
