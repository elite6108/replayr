import type { ReactNode } from "react";

export function AdminSheet({
  title,
  subtitle,
  children,
  onClose,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="admin-sheet">
      <button type="button" className="admin-sheet-backdrop" aria-label="Close" onClick={onClose} />
      <aside className="admin-sheet-panel" role="dialog" aria-modal="true" aria-labelledby="admin-sheet-title">
        <header className="admin-sheet-head">
          <div>
            <h3 id="admin-sheet-title">{title}</h3>
            {subtitle ? <p className="muted">{subtitle}</p> : null}
          </div>
          <button type="button" className="admin-btn ghost" onClick={onClose}>
            Close
          </button>
        </header>
        {children}
      </aside>
    </div>
  );
}
