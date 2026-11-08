import { useState } from "react";
import { useStaffPermissions } from "../../../lib/staff";
import { AdminPageHeader } from "../components/AdminPageHeader";
import { ReportQueue } from "./ReportQueue";
import { TermManager } from "./TermManager";

export function AdminModerationPage() {
  const { can } = useStaffPermissions();
  const canView = can("moderation.view");
  const canAct = can("moderation.act");
  const canTerms = can("moderation.terms");
  const [tab, setTab] = useState<"reports" | "terms">(canView ? "reports" : "terms");

  return (
    <section className="admin-dash">
      <AdminPageHeader
        eyebrow="Safety"
        title="Moderation"
        description="Open reports are reviewed within 24 hours, oldest first. Removing a profile clears the avatar, display name, and bio. It does not rename the username — suspend the account when the handle itself is the problem."
        actions={
          <div className="admin-filters">
            {canView ? (
              <button className={`admin-btn${tab === "reports" ? " primary" : ""}`} type="button" onClick={() => setTab("reports")}>
                Reports
              </button>
            ) : null}
            {canTerms ? (
              <button className={`admin-btn${tab === "terms" ? " primary" : ""}`} type="button" onClick={() => setTab("terms")}>
                Terms
              </button>
            ) : null}
          </div>
        }
      />
      {tab === "reports" && canView ? <ReportQueue canAct={canAct} /> : null}
      {tab === "terms" && canTerms ? <TermManager /> : null}
      {!canView && !canTerms ? <p className="muted">Your role can act on reports, but it cannot open the queue.</p> : null}
    </section>
  );
}
