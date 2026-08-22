import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Seo } from "../components/Seo";
import { formatBytes, formatClipCap, planLabel } from "../lib/format";
import { getSupabase, supabaseConfigured } from "../lib/supabase";

interface PlanRow {
  slug: string;
  storage_limit_bytes: number;
  max_clip_duration_ms: number | null;
  max_upload_quality: string | null;
}

const ORDER = ["free", "pro", "pro_plus"];

export function PricingPage() {
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!supabaseConfigured()) {
      setError("Plans could not be loaded.");
      return;
    }
    void getSupabase()
      .from("plans")
      .select("slug, storage_limit_bytes, max_clip_duration_ms, max_upload_quality")
      .then(({ data, error: next }) => {
        if (next) setError(next.message);
        else setPlans((data as PlanRow[]) ?? []);
      });
  }, []);

  const ordered = [...plans].sort((a, b) => ORDER.indexOf(a.slug) - ORDER.indexOf(b.slug));

  return (
    <main className="page marketing">
      <Seo
        title="Pricing — Replayr"
        description="Free cloud copies with 5 GB. Pro and Pro+ storage are coming soon. Local clips on your PC are not capped by cloud quota."
      />
      <p className="eyebrow">Cloud storage</p>
      <h1>Free to start. Pro when we take payments.</h1>
      <p className="lede">
        These limits apply to <strong>cloud copies</strong> uploaded from the Windows app. Files that stay on this PC are
        not billed against this table. There is no checkout yet.
      </p>
      {error ? <p className="error">{error}</p> : null}
      <div className="pricing-grid">
        {ordered.map((plan) => {
          const paid = plan.slug !== "free";
          return (
            <article className={`card pricing-card${plan.slug === "free" ? " featured" : ""}`} key={plan.slug}>
              <h2>{planLabel(plan.slug)}</h2>
              <p className="price">{formatBytes(plan.storage_limit_bytes)}</p>
              <ul>
                <li>{formatClipCap(plan.max_clip_duration_ms)} cloud clips</li>
                <li>{plan.max_upload_quality || "Original"} upload quality</li>
                <li>Local library uncapped by this plan</li>
              </ul>
              {paid ? (
                <button className="btn" type="button" disabled>
                  Coming soon
                </button>
              ) : (
                <Link className="btn primary" to="/signin">
                  Create account
                </Link>
              )}
            </article>
          );
        })}
      </div>
    </main>
  );
}
