import { useState } from "react";
import { blockUser } from "../lib/api.friends";
import { useAuth } from "../lib/auth";
import type { ReportTargetType } from "../lib/social-types";
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
  const { session } = useAuth();
  const token = session?.access_token;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!token || !targetId) return null;

  async function block() {
    if (!token || !subjectUserId) return;
    if (!window.confirm("Block this account? They will not be able to comment on your clips or message you.")) return;
    setBusy(true);
    setError(null);
    try {
      await blockUser(token, subjectUserId);
      onBlocked?.();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not block that account.");
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
      {error ? <span className="error">{error}</span> : null}
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
