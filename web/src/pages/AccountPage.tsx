import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Seo } from "../components/Seo";
import { SocialAvatar } from "../components/SocialAvatar";
import { deleteOwnAvatar, uploadOwnAvatar } from "../lib/avatars";
import { deleteAccount } from "../lib/api";
import { isAdminSession } from "../lib/admin";
import { fetchBillingStatus, startCheckout, startPortal, type BillingStatus } from "../lib/billing";
import { useAuth } from "../lib/auth";
import { formatBytes, planLabel } from "../lib/format";
import { getSupabase } from "../lib/supabase";
import { usernameTakenMessage, validateUsername } from "../lib/username";

interface ProfileRow {
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  is_private: boolean | null;
}

export function AccountPage() {
  const { session, signOut } = useAuth();
  const [params] = useSearchParams();
  const userId = session?.user.id ?? "";
  const [profile, setProfile] = useState<ProfileRow | null>(null);
  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [usernameDraft, setUsernameDraft] = useState("");

  useEffect(() => {
    if (!userId || !session?.access_token) return;
    let cancelled = false;
    void (async () => {
      const supabase = getSupabase();
      const [profileResult, billingResult] = await Promise.all([
        supabase.from("profiles").select("username, display_name, avatar_url, is_private").eq("id", userId).maybeSingle(),
        fetchBillingStatus(session.access_token).catch(() => null),
      ]);
      if (cancelled) return;
      if (profileResult.error) setError(profileResult.error.message);
      else {
        const row = profileResult.data as ProfileRow | null;
        setProfile(row);
        setUsernameDraft(row?.username ?? "");
      }
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
      {session ? (
        <div className="profile-hero">
          <SocialAvatar
            name={profile?.display_name || profile?.username || session.user.email || "Player"}
            avatarUrl={profile?.avatar_url}
            size={72}
          />
          <div className="row">
            <label className="btn">
              Change photo
              <input
                type="file"
                hidden
                accept="image/jpeg,image/png,image/webp"
                disabled={busy}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.currentTarget.value = "";
                  if (!file || !session.access_token) return;
                  setBusy(true);
                  setError(null);
                  void uploadOwnAvatar(session.access_token, file)
                    .then((avatarUrl) => setProfile((current) => (current ? { ...current, avatar_url: avatarUrl } : current)))
                    .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Could not upload photo."))
                    .finally(() => setBusy(false));
                }}
              />
            </label>
            {profile?.avatar_url ? (
              <button
                className="btn"
                type="button"
                disabled={busy}
                onClick={() => {
                  if (!session.access_token) return;
                  setBusy(true);
                  void deleteOwnAvatar(session.access_token)
                    .then(() => setProfile((current) => (current ? { ...current, avatar_url: null } : current)))
                    .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Could not remove photo."))
                    .finally(() => setBusy(false));
                }}
              >
                Remove photo
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      {notice ? <p className="muted">{notice}</p> : null}
      {error ? <p className="error">{error}</p> : null}
      <dl className="meta-list">
        <dt>Email</dt>
        <dd>{session?.user.email}</dd>
        <dt>Username</dt>
        <dd>
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              const invalid = validateUsername(usernameDraft);
              if (invalid) {
                setError(invalid);
                return;
              }
              const nextName = usernameDraft.trim();
              if (!userId) return;
              setBusy(true);
              setError(null);
              const patch: { username: string; display_name?: string } = { username: nextName };
              if (!profile?.display_name?.trim()) patch.display_name = nextName;
              void getSupabase()
                .from("profiles")
                .update(patch)
                .eq("id", userId)
                .then(({ error: updateError }) => {
                  if (updateError) setError(usernameTakenMessage(updateError));
                  else {
                    setProfile((current) =>
                      current
                        ? { ...current, username: nextName, display_name: patch.display_name ?? current.display_name }
                        : { username: nextName, display_name: nextName, avatar_url: null, is_private: false },
                    );
                  }
                  setBusy(false);
                });
            }}
          >
            <input
              value={usernameDraft}
              onChange={(event) => setUsernameDraft(event.target.value)}
              autoCapitalize="none"
              autoComplete="username"
              aria-label="Username"
              disabled={busy}
            />
            <button className="btn" type="submit" disabled={busy || usernameDraft.trim() === (profile?.username ?? "")}>
              {profile?.username ? "Update username" : "Save username"}
            </button>
          </form>
        </dd>
        <dt>Display name</dt>
        <dd>{profile?.display_name || "—"}</dd>
        <dt>Private account</dt>
        <dd>
          <label className="row">
            <input
              type="checkbox"
              checked={Boolean(profile?.is_private)}
              disabled={busy || !userId}
              onChange={(event) => {
                const next = event.target.checked;
                void (async () => {
                  setBusy(true);
                  setError(null);
                  const { error: updateError } = await getSupabase()
                    .from("profiles")
                    .update({ is_private: next })
                    .eq("id", userId);
                  if (updateError) setError(updateError.message);
                  else setProfile((current) => (current ? { ...current, is_private: next } : current));
                  setBusy(false);
                })();
              }}
            />
            Only friends can see your clips, posts, and bio.
          </label>
        </dd>
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
        {profile?.username ? (
          <Link className="btn" to={`/u/${encodeURIComponent(profile.username)}`}>
            View profile
          </Link>
        ) : null}
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
