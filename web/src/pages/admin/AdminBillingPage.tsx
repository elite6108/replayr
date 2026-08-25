import { useEffect, useState } from "react";
import {
  fetchAdminBilling,
  fetchAdminPlans,
  updateAdminPlan,
  updateAdminSettings,
  type AdminPlan,
} from "../../lib/admin";
import { useAuth } from "../../lib/auth";
import { formatBytes, formatClipCap, formatClipDate, planLabel } from "../../lib/format";

export function AdminBillingPage() {
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const [error, setError] = useState<string | null>(null);
  const [premium, setPremium] = useState(0);
  const [trialing, setTrialing] = useState(0);
  const [pastDue, setPastDue] = useState(0);
  const [complimentary, setComplimentary] = useState(0);
  const [canceling, setCanceling] = useState(0);
  const [mrr, setMrr] = useState(0);
  const [risk, setRisk] = useState(0);
  const [watermarkEnabled, setWatermarkEnabled] = useState(true);
  const [adsEnabled, setAdsEnabled] = useState(true);
  const [plans, setPlans] = useState<AdminPlan[]>([]);
  const [events, setEvents] = useState<
    { id: string; type: string; userId: string | null; ok: boolean; error: string | null; createdAt: string }[]
  >([]);

  async function load() {
    if (!token) return;
    setError(null);
    try {
      const [billing, planList] = await Promise.all([fetchAdminBilling(token), fetchAdminPlans(token)]);
      setPremium(billing.premium);
      setTrialing(billing.trialing);
      setPastDue(billing.pastDue);
      setComplimentary(billing.complimentary);
      setCanceling(billing.canceling ?? 0);
      setMrr(billing.estimatedMrr);
      setRisk(billing.storageRiskUsd);
      setWatermarkEnabled(billing.settings.watermark_enabled);
      setAdsEnabled(billing.settings.ads_enabled);
      setEvents(billing.events);
      setPlans(planList.plans);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load billing.");
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  return (
    <section className="admin-section">
      <header className="admin-header">
        <div>
          <p className="eyebrow">Stripe</p>
          <h2>Billing</h2>
          <p className="muted">Premium is the public paid SKU. Pro+ stays for comps.</p>
        </div>
      </header>
      {error ? <p className="error">{error}</p> : null}
      <div className="admin-stats">
        <div className="admin-stat">
          <span>Premium</span>
          <strong>{premium}</strong>
        </div>
        <div className="admin-stat">
          <span>Trialing</span>
          <strong>{trialing}</strong>
        </div>
        <div className="admin-stat">
          <span>Past due</span>
          <strong>{pastDue}</strong>
        </div>
        <div className="admin-stat">
          <span>Comps</span>
          <strong>{complimentary}</strong>
        </div>
        <div className="admin-stat">
          <span>Canceling</span>
          <strong>{canceling}</strong>
        </div>
        <div className="admin-stat">
          <span>Est. MRR</span>
          <strong>${mrr.toFixed(2)}</strong>
        </div>
        <div className="admin-stat">
          <span>Storage at risk</span>
          <strong>${risk.toFixed(2)}</strong>
        </div>
      </div>
      <div className="row" style={{ margin: "16px 0" }}>
        <label className="setting-row">
          <span>Watermarks</span>
          <input
            className="switch"
            type="checkbox"
            checked={watermarkEnabled}
            onChange={(event) => {
              const next = event.target.checked;
              setWatermarkEnabled(next);
              void updateAdminSettings(token, { watermarkEnabled: next }).catch((caught: unknown) => {
                setError(caught instanceof Error ? caught.message : "Could not save settings.");
              });
            }}
          />
        </label>
        <label className="setting-row">
          <span>House ads</span>
          <input
            className="switch"
            type="checkbox"
            checked={adsEnabled}
            onChange={(event) => {
              const next = event.target.checked;
              setAdsEnabled(next);
              void updateAdminSettings(token, { adsEnabled: next }).catch((caught: unknown) => {
                setError(caught instanceof Error ? caught.message : "Could not save settings.");
              });
            }}
          />
        </label>
      </div>
      <h3>Plans</h3>
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Plan</th>
              <th>Storage</th>
              <th>Clip cap</th>
              <th>Quality</th>
              <th>Watermark</th>
              <th>Ads</th>
            </tr>
          </thead>
          <tbody>
            {plans.map((plan) => (
              <tr key={plan.slug}>
                <td>{planLabel(plan.slug)}</td>
                <td>
                  <button
                    className="btn"
                    type="button"
                    onClick={() => {
                      const raw = window.prompt("Cloud limit in GB", String(Math.round(plan.storageLimitBytes / 1024 ** 3)));
                      if (raw == null) return;
                      void updateAdminPlan(token, plan.slug, { storageLimitBytes: Math.round(Number(raw) * 1024 ** 3) })
                        .then((next) => setPlans(next.plans))
                        .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Could not update plan."));
                    }}
                  >
                    {formatBytes(plan.storageLimitBytes)}
                  </button>
                </td>
                <td>
                  <button
                    className="btn"
                    type="button"
                    onClick={() => {
                      const raw = window.prompt(
                        "Clip cap in minutes (blank = none)",
                        plan.maxClipDurationMs == null ? "" : String(Math.round(plan.maxClipDurationMs / 60000)),
                      );
                      if (raw == null) return;
                      const minutes = raw.trim() === "" ? null : Number(raw);
                      void updateAdminPlan(token, plan.slug, {
                        maxClipDurationMs: minutes == null ? null : Math.round(minutes * 60000),
                      })
                        .then((next) => setPlans(next.plans))
                        .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Could not update plan."));
                    }}
                  >
                    {formatClipCap(plan.maxClipDurationMs)}
                  </button>
                </td>
                <td>
                  <button
                    className="btn"
                    type="button"
                    onClick={() => {
                      const next = plan.maxUploadQuality === "1080p" ? "original" : "1080p";
                      void updateAdminPlan(token, plan.slug, { maxUploadQuality: next })
                        .then((result) => setPlans(result.plans))
                        .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Could not update plan."));
                    }}
                  >
                    {plan.maxUploadQuality || "Original"}
                  </button>
                </td>
                <td>
                  <button
                    className="btn"
                    type="button"
                    onClick={() => {
                      void updateAdminPlan(token, plan.slug, { watermark: !plan.watermark })
                        .then((next) => setPlans(next.plans))
                        .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Could not update plan."));
                    }}
                  >
                    {plan.watermark ? "Yes" : "No"}
                  </button>
                </td>
                <td>
                  <button
                    className="btn"
                    type="button"
                    onClick={() => {
                      void updateAdminPlan(token, plan.slug, { ads: !plan.ads })
                        .then((next) => setPlans(next.plans))
                        .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Could not update plan."));
                    }}
                  >
                    {plan.ads ? "Yes" : "No"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3>Recent Stripe events</h3>
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>When</th>
              <th>Type</th>
              <th>User</th>
              <th>Ok</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => (
              <tr key={event.id}>
                <td>{formatClipDate(event.createdAt)}</td>
                <td>{event.type}</td>
                <td>{event.userId || "—"}</td>
                <td>{event.ok ? "Yes" : event.error || "No"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {events.length === 0 ? <p className="muted admin-empty">No webhook events yet.</p> : null}
      </div>
    </section>
  );
}
