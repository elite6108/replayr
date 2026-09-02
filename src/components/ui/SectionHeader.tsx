import type { ReactNode } from "react";

export function SectionHeader({
  kicker,
  title,
  action,
}: {
  kicker?: string;
  title: string;
  action?: ReactNode;
}) {
  return (
    <div className="section-header">
      <div>
        {kicker ? <p className="section-kicker">{kicker}</p> : null}
        <h2>{title}</h2>
      </div>
      {action}
    </div>
  );
}
