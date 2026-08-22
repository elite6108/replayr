import type { ReactNode } from "react";

export function ClipRail({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="panel flush">
      <div className="panel-head">
        <h2>{title}</h2>
        {action}
      </div>
      <div className="clip-rail-track">{children}</div>
    </section>
  );
}
