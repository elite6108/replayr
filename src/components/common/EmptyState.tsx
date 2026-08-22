import type { ReactNode } from "react";

export function EmptyState({
  icon,
  title,
  body,
  children,
}: {
  icon?: ReactNode;
  title: string;
  body: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty-state">
      {icon ? <div className="empty-icon">{icon}</div> : null}
      <h2>{title}</h2>
      <p>{body}</p>
      {children}
    </div>
  );
}
