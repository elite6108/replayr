import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Seo } from "../components/Seo";
import { deleteAccount } from "../lib/api";
import { isAdminSession } from "../lib/admin";
import { fetchBillingStatus, startCheckout, startPortal, type BillingStatus } from "../lib/billing";
import { useAuth } from "../lib/auth";
import { formatBytes, planLabel } from "../lib/format";
import { getSupabase } from "../lib/supabase";

interface ProfileRow {
  username: string | null;
  display_name: string | null;
}

export function AccountPage() {
  const { session, signOut } = useAuth();
  const [params] = useSearchParams();
  const userId = session?.user.id ?? "";
  const [profile, setProfile] = useState<ProfileRow | null>(null);
  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!userId || !session?.access_token) return;
    let cancelled = false;
    void (async () => {
      const supabase = getSupabase();
      const [profileResult, billingResult] = await Promise.all([
        supabase.from("profiles").select("username, display_name").eq("id", userId).maybeSingle(),
        fetchBillingStatus(session.access_token).catch(() => null),
      ]);
      if (cancelled) return;
      if (profileResult.error) setError(profileResult.error.message);
      else setProfile(profileResult.data as ProfileRow | null);
      if (billingResult) setBilling(billingResult);
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, session?.access_token]);

  const used = billing?.storageUsedBytes ?? 0;
  const limit = billing?.storageLimitBytes ?? 0;
  const percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const notice = params.get("billing") === "success" ? "Checkout finished. Premium appears after Stripe confirms." : null;

  async function onCheckout() {
    if (!session?.access_token) return;
    setBusy(true);
    setError(null);
    try {
      window.location.href = await startCheckout(session.access_token, "month");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not start checkout.");
      setBusy(false);
    }
  }

  async function onPortal() {
    if (!session?.access_token) return;
    setBusy(true);
    setError(null);
    try {
      window.location.href = await startPortal(session.access_token);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not open billing.");
      setBusy(false);
    }
  }

  return (
    <main className="page narrow">
      <Seo title="Account — Replayr" description="Your Replayr account, plan, and cloud quota." robots="noindex" />
      <h1>Account</h1>
      <p className="muted">Same identity as the Windows app. Capture still happens on the PC.</p>
      {notice ? <p className="muted">{notice}</p> : null}
      {error ? <p className="error">{error}</p> : null}
      <dl className="meta-list">
        <dt>Email</dt>
        <dd>{session?.user.email}</dd>
        <dt>Username</dt>
        <dd>{profile?.username || "Not set yet — choose one in the desktop app."}</dd>
        <dt>Display name</dt>
        <dd>{profile?.display_name || "—"}</dd>
        <dt>Plan</dt>
        <dd>
          {billing ? planLabel(billing.plan) : "—"}
          {billing?.status && billing.status !== "none" ? ` · ${billing.status}` : ""}
          {billing?.cancelAtPeriodEnd ? " · cancels at period end" : ""}
        </dd>
      </dl>
      {billing ? (
        <div className="quota">
          <div className="quota-bar" aria-hidden="true">
            <span style={{ width: `${percent}%` }} />
          </div>
          <p className="muted">
            {formatBytes(used)} of {formatBytes(limit)} cloud storage used
            {percent >= 80 && !billing.premium ? " · Upgrade to Premium for 100 GB." : ""}
          </p>
        </div>
      ) : null}
      <div className="row">
        {billing?.premium ? (
          <button className="btn" type="button" disabled={busy} onClick={() => void onPortal()}>
            Manage billing
          </button>
        ) : (
          <button className="btn primary" type="button" disabled={busy} onClick={() => void onCheckout()}>
            Upgrade to Premium — $4.99/mo
          </button>
        )}
        {isAdminSession(session) ? (
          <Link className="btn primary" to="/admin">
            Open admin
          </Link>
        ) : null}
        <button className="btn" type="button" onClick={() => void signOut()}>
          Sign out
        </button>
        <button
          className="btn danger"
          type="button"
          disabled={busy || !session?.access_token}
          onClick={() => {
            if (
              !session?.access_token ||
              !window.confirm("Delete this Replayr account and all cloud clips? This cannot be undone.")
            ) {
              return;
            }
            if (!window.confirm("Delete the account forever?")) return;
            void (async () => {
              setBusy(true);
              setError(null);
              try {
                await deleteAccount(session.access_token);
                await signOut();
              } catch (caught) {
                setError(caught instanceof Error ? caught.message : "Could not delete this account.");
              } finally {
                setBusy(false);
              }
            })();
          }}
        >
          {busy ? "Working…" : "Delete account"}
        </button>
      </div>
    </main>
  );
}
