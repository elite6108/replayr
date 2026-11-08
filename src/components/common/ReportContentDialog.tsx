import { FormEvent, useState } from "react";
import { blockUser } from "../../services/api.friends";
import { REPORT_REASON_LABELS, reportContent } from "../../services/api.safety";
import type { ReportReason, ReportTargetType } from "../../services/social-types";
import { useAuthStore } from "../../stores/authStore";

const REASONS = Object.keys(REPORT_REASON_LABELS) as ReportReason[];

export function ReportContentDialog({
  targetType,
  targetId,
  subjectUserId,
  onClose,
  onBlocked,
}: {
  targetType: ReportTargetType;
  targetId: string;
  subjectUserId?: string | null;
  onClose: () => void;
  onBlocked?: () => void;
}) {
  const token = useAuthStore((state) => state.session?.access_token) ?? "";
  const [reason, setReason] = useState<ReportReason>("harassment");
  const [details, setDetails] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const result = await reportContent(token, { targetType, targetId, reason, details });
      setDone(
        result.alreadyReported
          ? "You already reported this. We'll still review it within 24 hours."
          : "Thanks. We'll review this within 24 hours.",
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not send that report.");
    } finally {
      setBusy(false);
    }
  }

  async function block() {
    if (!token || !subjectUserId) return;
    setBusy(true);
    setError(null);
    try {
      await blockUser(token, subjectUserId);
      onBlocked?.();
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not block that account.");
      setBusy(false);
    }
  }

  return (
    <div
      className="social-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="report-title"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="panel stack social-modal-card">
        <h2 id="report-title">Report</h2>
        {done ? (
          <>
            <p>{done}</p>
            {error ? <p className="error-text">{error}</p> : null}
            <div className="row">
              {subjectUserId ? (
                <button className="btn danger" type="button" disabled={busy} onClick={() => void block()}>
                  Block this account
                </button>
              ) : null}
              <button className="btn" type="button" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        ) : (
          <form className="stack" onSubmit={(event) => void submit(event)}>
            <p className="muted">Reports are reviewed within 24 hours. The person is not told who reported them.</p>
            <label>
              Reason
              <select value={reason} onChange={(event) => setReason(event.target.value as ReportReason)}>
                {REASONS.map((item) => (
                  <option key={item} value={item}>
                    {REPORT_REASON_LABELS[item]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Details
              <textarea
                value={details}
                maxLength={500}
                rows={3}
                onChange={(event) => setDetails(event.target.value)}
                placeholder="Optional. Only moderators see this."
              />
            </label>
            {error ? <p className="error-text">{error}</p> : null}
            <div className="row">
              <button className="btn primary" type="submit" disabled={busy || !token}>
                {busy ? "Sending…" : "Send report"}
              </button>
              <button className="btn" type="button" onClick={onClose}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
