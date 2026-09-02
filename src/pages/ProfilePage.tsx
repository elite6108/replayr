import { FormEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AuthCard } from "../components/common/AuthCard";
import { publicSiteUrl } from "../branding";
import { PageHeader } from "../components/common/PageHeader";
import { startCheckout, startPortal } from "../services/billing";
import { useAuthStore } from "../stores/authStore";
import { useBillingStore } from "../stores/billingStore";
import { useToastStore } from "../stores/toastStore";
import { isAdminSession } from "../utils/admin";
import { formatBytes, initials, planLabel } from "../utils/format";
import { validateUsername } from "../utils/username";

export function ProfilePage() {
  const configured = useAuthStore((state) => state.configured);
  const user = useAuthStore((state) => state.user);
  const session = useAuthStore((state) => state.session);
  const profile = useAuthStore((state) => state.profile);
  const storage = useAuthStore((state) => state.storage);
  const billing = useBillingStore((state) => state.status);
  const signOut = useAuthStore((state) => state.signOut);
  const saveProfile = useAuthStore((state) => state.saveProfile);
  const showToast = useToastStore((state) => state.show);
  const [username, setUsername] = useState(profile?.username ?? "");
  const [displayName, setDisplayName] = useState(profile?.display_name ?? "");
  const [bio, setBio] = useState(profile?.bio ?? "");
  const [isPrivate, setIsPrivate] = useState(Boolean(profile?.is_private));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setUsername(profile?.username ?? "");
    setDisplayName(profile?.display_name ?? "");
    setBio(profile?.bio ?? "");
    setIsPrivate(Boolean(profile?.is_private));
  }, [profile]);

  async function onSaveProfile(event: FormEvent) {
    event.preventDefault();
    const usernameError = validateUsername(username);
    if (usernameError) {
      showToast(usernameError);
      return;
    }
    setBusy(true);
    try {
      await saveProfile({
        username: username.trim(),
        display_name: displayName.trim() || username.trim(),
        bio: bio.trim() || null,
        is_private: isPrivate,
      });
      showToast("Profile saved");
    } catch (caught) {
      showToast(caught instanceof Error ? caught.message : "Could not save profile");
    } finally {
      setBusy(false);
    }
  }

  if (!configured) {
    return (
      <>
        <PageHeader title="Account" subtitle="Cloud accounts are not configured on this PC." />
        <section className="panel">
          <p>
            Copy <code>.env.example</code> to <code>.env</code> and set <code>VITE_SUPABASE_URL</code> and{" "}
            <code>VITE_SUPABASE_ANON_KEY</code>.
          </p>
        </section>
      </>
    );
  }

  if (!user) {
    return (
      <>
        <PageHeader title="Account" subtitle="Sign in to upload clips. Capture still works offline." />
        <AuthCard />
      </>
    );
  }

  const name = profile?.display_name || profile?.username || user.email || "Player";
  const used = storage?.storage_used_bytes ?? 0;
  const limit = storage?.storage_limit_bytes ?? 0;
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;

  return (
    <>
      <PageHeader title="Account" subtitle="Usernames are unique. Clip URLs never include this name.">
        {isAdminSession(session) ? (
          <Link className="btn primary" to="/admin">
            Admin
          </Link>
        ) : null}
        <button className="btn" type="button" onClick={() => void signOut()}>
          Sign out
        </button>
      </PageHeader>
      <section className="panel stack">
        <div className="profile-hero">
          <span className="avatar lg">{initials(profile?.username || name)}</span>
          <div>
            <div className="stat-value">{name}</div>
            <div className="muted">{user.email}</div>
          </div>
        </div>
        {storage ? (
          <>
            <div className="muted">
              {planLabel(billing?.plan || "free")} · {formatBytes(used)} / {formatBytes(limit)} cloud storage
            </div>
            <div className="meter" aria-label="Cloud storage used">
              <span style={{ width: `${pct}%` }} />
            </div>
            <div className="row">
              {billing?.premium ? (
                <button
                  className="btn"
                  type="button"
                  onClick={() => {
                    if (!session?.access_token) return;
                    void startPortal(session.access_token, "replayr://billing?status=portal")
                      .then((url) => import("@tauri-apps/plugin-opener").then(({ openUrl }) => openUrl(url)))
                      .catch((caught: unknown) => showToast(caught instanceof Error ? caught.message : "Could not open billing."));
                  }}
                >
                  Manage billing
                </button>
              ) : (
                <button
                  className="btn primary"
                  type="button"
                  onClick={() => {
                    if (!session?.access_token) return;
                    void startCheckout(session.access_token, "month", {
                      successUrl: "replayr://billing?status=success",
                      cancelUrl: `${publicSiteUrl()}/pricing`,
                    })
                      .then((url) => import("@tauri-apps/plugin-opener").then(({ openUrl }) => openUrl(url)))
                      .catch((caught: unknown) => showToast(caught instanceof Error ? caught.message : "Could not start checkout."));
                  }}
                >
                  Upgrade to Premium — $4.99/mo
                </button>
              )}
            </div>
          </>
        ) : null}
        <form className="stack" onSubmit={(event) => void onSaveProfile(event)}>
          <div className="field">
            <label htmlFor="username">Username</label>
            <input id="username" value={username} onChange={(event) => setUsername(event.target.value)} required />
          </div>
          <div className="field">
            <label htmlFor="display-name">Display name</label>
            <input id="display-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="bio">Bio</label>
            <textarea id="bio" rows={3} value={bio} onChange={(event) => setBio(event.target.value)} />
          </div>
          <label className="row" htmlFor="private-account">
            <input
              id="private-account"
              type="checkbox"
              checked={isPrivate}
              onChange={(event) => setIsPrivate(event.target.checked)}
            />
            Private account
          </label>
          <p className="muted">Only accepted followers can see your clips, posts, and bio.</p>
          <div className="row">
            <button className="btn primary" type="submit" disabled={busy}>
              Save profile
            </button>
            {username.trim() ? (
              <Link className="btn" to={`/u/${encodeURIComponent(username.trim())}`}>
                View profile
              </Link>
            ) : null}
            <Link className="btn" to="/library/cloud">
              Cloud library
            </Link>
          </div>
        </form>
      </section>
    </>
  );
}
