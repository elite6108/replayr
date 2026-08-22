import { EmptyState } from "../components/common/EmptyState";
import { PageHeader } from "../components/common/PageHeader";
import { IconFriends } from "../components/icons";

export function FriendsPage() {
  return (
    <>
      <PageHeader title="Friends" subtitle="Follows and activity come later. Capture still lives here." />
      <section className="panel">
        <EmptyState
          icon={<IconFriends size={26} />}
          title="No friends list yet"
          body="Follows, activity, and notifications are scheduled for Phase 8. This page is here so the shell stays stable."
        >
          <span className="badge">Phase 8</span>
        </EmptyState>
      </section>
    </>
  );
}
