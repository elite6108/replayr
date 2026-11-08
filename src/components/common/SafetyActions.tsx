import { useState } from "react";
import { blockUser } from "../../services/api.friends";
import type { ReportTargetType } from "../../services/social-types";
import { useAuthStore } from "../../stores/authStore";
import { ReportContentDialog } from "./ReportContentDialog";

export function SafetyActions({
  targetType,
  targetId,
  subjectUserId,
  showBlock = false,
  onBlocked,
}: {
  targetType: ReportTargetType;
  targetId: string;
  subjectUserId?: string | null;
  showBlock?: boolean;
  onBlocked?: () => void;
}) {
  const token = useAuthStore((state) => state.session?.access_token);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!token || !targetId) return null;

  async function block() {
    if (!token || !subjectUserId) return;
    if (!window.confirm("Block this account? They will not be able to comment on your clips or message you.")) return;
    setBusy(true);
    try {
      await blockUser(token, subjectUserId);
      onBlocked?.();
    } catch (caught) {
      window.alert(caught instanceof Error ? caught.message : "Could not block that account.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button className="btn ghost" type="button" onClick={() => setOpen(true)}>
        Report
      </button>
      {showBlock && subjectUserId ? (
        <button className="btn ghost" type="button" disabled={busy} onClick={() => void block()}>
          Block
        </button>
      ) : null}
      {open ? (
        <ReportContentDialog
          targetType={targetType}
          targetId={targetId}
          subjectUserId={subjectUserId}
          onBlocked={onBlocked}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
