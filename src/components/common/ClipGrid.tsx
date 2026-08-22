import { IconPlay } from "../icons";
import { EmptyState } from "./EmptyState";

export function ClipGrid({ title, body, badge = "Local" }: { title: string; body: string; badge?: string }) {
  return (
    <div className="clip-grid-wrap">
      <div className="clip-grid" aria-hidden="true">
        {Array.from({ length: 8 }, (_, index) => (
          <div className="clip-card ghost" key={index}>
            <div className="clip-thumb">
              <IconPlay size={22} />
            </div>
            <div className="clip-meta">
              <span className="clip-line" />
              <span className="clip-line short" />
            </div>
          </div>
        ))}
      </div>
      <EmptyState icon={<IconPlay size={28} />} title={title} body={body}>
        <span className="badge">{badge}</span>
      </EmptyState>
    </div>
  );
}
