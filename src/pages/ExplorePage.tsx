import { EmptyState } from "../components/common/EmptyState";
import { PageHeader } from "../components/common/PageHeader";
import { IconExplore } from "../components/icons";

export function ExplorePage() {
  return (
    <>
      <PageHeader title="Explore" subtitle="Public clips only. Unlisted links never show up here." />
      <section className="panel">
        <EmptyState
          icon={<IconExplore size={26} />}
          title="Public feed is not in this build"
          body="Explore, search, and game feeds are scheduled for Phase 8. Unlisted clips stay off this page by design."
        >
          <span className="badge">Phase 8</span>
        </EmptyState>
      </section>
    </>
  );
}
