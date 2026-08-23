import type { ReactNode } from "react";

export function SelectionBar({
  count,
  onClear,
  onSelectAll,
  children,
}: {
  count: number;
  onClear: () => void;
  onSelectAll?: () => void;
  children: ReactNode;
}) {
  if (count === 0) return null;
  return (
    <div className="selection-bar" role="toolbar" aria-label="Selected clips">
      <span>
        {count} selected
      </span>
      {onSelectAll ? (
        <button type="button" className="btn ghost" onClick={onSelectAll}>
          Select all
        </button>
      ) : null}
      {children}
      <button type="button" className="btn ghost" onClick={onClear}>
        Clear
      </button>
    </div>
  );
}
