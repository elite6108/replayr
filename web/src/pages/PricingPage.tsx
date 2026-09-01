import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Seo } from "../components/Seo";
import { startCheckout, type BillingStatus } from "../lib/billing";
import { trackWebEvent } from "../lib/analytics";
import { useAuth } from "../lib/auth";
import { formatBytes, formatClipCap } from "../lib/format";
import { getSupabase, supabaseConfigured } from "../lib/supabase";

interface PlanRow {
  slug: string;
  storage_limit_bytes: number;
  max_clip_duration_ms: number | null;
  max_upload_quality: string | null;
  watermark?: boolean;
  ads?: boolean;
}

export function PricingPage() {
  const { session } = useAuth();
  const navigate = useNavigate();
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [interval, setInterval] = useState<"month" | "year">("month");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [billing, setBilling] = useState<BillingStatus | null>(null);

  useEffect(() => {
    trackWebEvent("pricing.viewed", { surface: "pricing_page" }, session?.access_token);
  }, [session?.access_token]);

  useEffect(() => {
    if (!supabaseConfigured()) {
      setError("Plans could not be loaded.");
      return;
    }
    void getSupabase()
      .from("plans")
      .select("slug, storage_limit_bytes, max_clip_duration_ms, max_upload_quality, watermark, ads")
      .then(({ data, error: next }) => {
        if (next) setError(next.message);
        else setPlans(((data as PlanRow[]) ?? []).filter((plan) => plan.slug !== "pro_plus"));
      });
  }, []);

  useEffect(() => {
    if (!session?.access_token) {
      setBilling(null);
      return;
    }
    void import("../lib/billing").then(({ fetchBillingStatus }) =>
      fetchBillingStatus(session.access_token).then(setBilling).catch(() => undefined),
    );
  }, [session?.access_token]);

  const free = plans.find((plan) => plan.slug === "free");
  const premium = plans.find((plan) => plan.slug === "pro");

  async function onUpgrade() {
    if (!session?.access_token) {
      navigate("/signin");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      window.location.href = await startCheckout(session.access_token, interval);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not start checkout.");
      setBusy(false);
    }
  }

  return (
    <main className="page marketing">
      <Seo
        title="Pricing — Replayr"
        description="Replayr is free to capture on Windows. Premium is $4.99 a month for 100 GB, original-quality uploads, and no watermark."
      />
      <p className="eyebrow">Cloud storage</p>
      <h1>Free to clip. Premium when the library grows.</h1>
      <p className="lede">
        Local files on this PC stay yours and unmarked. Cloud copies from the Windows app follow the plan below.
      </p>
      {error ? <p className="error">{error}</p> : null}
      <div className="pricing-grid">
        <article className="card pricing-card">
          <h2>Free</h2>
          <p className="price">{free ? formatBytes(free.storage_limit_bytes) : "5 GB"}</p>
          <ul>
            <li>{formatClipCap(free?.max_clip_duration_ms ?? 1_200_000)} cloud clips</li>
            <li>{free?.max_upload_quality || "1080p"} uploads (any frame rate)</li>
            <li>Replayr.tv watermark on share, export, and cloud</li>
            <li>House upgrade ads on web and mobile</li>
            <li>Local library unlimited and unmarked</li>
          </ul>
          <Link className="btn" to="/signin">
            Create account
          </Link>
        </article>
        <article className="card pricing-card featured">
          <h2>Premium</h2>
          <p className="price">{interval === "year" ? "$47.88" : "$4.99"}</p>
          <p className="muted pricing-cadence">{interval === "year" ? "per year · $3.99/mo" : "per month"}</p>
          <div className="pricing-interval" role="group" aria-label="Billing period">
            <button
              className={interval === "month" ? "active" : ""}
              type="button"
              aria-pressed={interval === "month"}
              onClick={() => setInterval("month")}
            >
              Monthly
            </button>
            <button
              className={interval === "year" ? "active" : ""}
              type="button"
              aria-pressed={interval === "year"}
              onClick={() => setInterval("year")}
            >
              Yearly
              <span>Save 20%</span>
            </button>
          </div>
          <ul>
            <li>{premium ? formatBytes(premium.storage_limit_bytes) : "100 GB"} cloud storage</li>
            <li>No cloud length cap</li>
            <li>Original quality, including 4K</li>
            <li>No watermark</li>
            <li>No ads · Premium badge</li>
            <li>7-day trial with a card</li>
          </ul>
          {billing?.premium ? (
            <Link className="btn primary" to="/account">
              You have Premium
            </Link>
          ) : (
            <button className="btn primary" type="button" disabled={busy} onClick={() => void onUpgrade()}>
              {busy ? "Redirecting…" : interval === "year" ? "Upgrade yearly" : "Upgrade monthly"}
            </button>
          )}
        </article>
      </div>
    </main>
  );
}
