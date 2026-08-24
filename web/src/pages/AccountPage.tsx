import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Seo } from "../components/Seo";
import { deleteAccount } from "../lib/api";
import { isAdminSession } from "../lib/admin";
import { fetchNotificationPrefs, patchNotificationPrefs, type NotificationPrefs } from "../lib/api.messages";
import { useAuth } from "../lib/auth";
import { formatBytes } from "../lib/format";
import { getSupabase } from "../lib/supabase";

interface ProfileRow {
  username: string | null;
  display_name: string | null;
}

interface Quota {
  storage_used_bytes: number;
  storage_limit_bytes: number;
}

export function AccountPage() {
  const { session, signOut } = useAuth();
  const userId = session?.user.id ?? "";
  const [profile, setProfile] = useState<ProfileRow | null>(null);
  const [quota, setQuota] = useState<Quota | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [prefs, setPrefs] = useState<NotificationPrefs | null>(null);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    void (async () => {
      const supabase = getSupabase();
      const [profileResult, quotaResult] = await Promise.all([
        supabase.from("profiles").select("username, display_name").eq("id", userId).maybeSingle(),
        supabase.from("user_storage").select("storage_used_bytes, storage_limit_bytes").eq("user_id", userId).maybeSingle(),
      ]);
      if (cancelled) return;
      if (profileResult.error) setError(profileResult.error.message);
      else setProfile(profileResult.data as ProfileRow | null);
      if (!quotaResult.error && quotaResult.data) setQuota(quotaResult.data as Quota);
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  useEffect(() => {
    if (!session?.access_token) {
      setPrefs(null);
      return;
    }
    let cancelled = false;
    void fetchNotificationPrefs(session.access_token)
      .then((next) => {
        if (!cancelled) setPrefs(next);
      })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load notification settings.");
      });
    return () => {
      cancelled = true;
    };
  }, [session?.access_token]);

  const used = quota?.storage_used_bytes ?? 0;
  const limit = quota?.storage_limit_bytes ?? 0;
  const percent = limit > 0 ? Math.min(100, roundPercent(used, limit)) : 0;

  async function onTogglePref(key: keyof NotificationPrefs, next: boolean) {
    if (!session?.access_token || !prefs) return;
    const previous = prefs;
    setPrefs({ ...prefs, [key]: next });
    setError(null);
    try {
      setPrefs(await patchNotificationPrefs(session.access_token, { [key]: next }));
    } catch (caught) {
      setPrefs(previous);
      setError(caught instanceof Error ? caught.message : "Could not save notification settings.");
    }
  }

  return (
    <main className="page narrow">
      <Seo title="Account — Replayr" description="Your Replayr account and cloud quota." robots="noindex" />
      <h1>Account</h1>
      <p className="muted">Same identity as the Windows app. Capture still happens on the PC.</p>
      {error ? <p className="error">{error}</p> : null}
      <dl className="meta-list">
        <dt>Email</dt>
        <dd>{session?.user.email}</dd>
        <dt>Username</dt>
        <dd>{profile?.username || "Not set yet — choose one in the desktop app."}</dd>
        <dt>Display name</dt>
        <dd>{profile?.display_name || "—"}</dd>
      </dl>
      {quota ? (
        <div className="quota">
          <div className="quota-bar" aria-hidden="true">
            <span style={{ width: `${percent}%` }} />
          </div>
          <p className="muted">
            {formatBytes(used)} of {formatBytes(limit)} cloud storage used
          </p>
        </div>
      ) : null}
      <section className="pref-card" aria-labelledby="notification-prefs">
        <h2 id="notification-prefs">Notifications</h2>
        <p className="muted">These control phone alerts. The in-app bell still shows activity.</p>
        <PrefToggle
          title="Friend requests"
          subtitle="When someone adds you, and when they accept."
          checked={prefs?.friendRequests ?? true}
          disabled={!prefs || !session?.access_token}
          onChange={(value) => void onTogglePref("friendRequests", value)}
        />
        <PrefToggle
          title="Likes on your clips"
          checked={prefs?.likes ?? true}
          disabled={!prefs || !session?.access_token}
          onChange={(value) => void onTogglePref("likes", value)}
        />
        <PrefToggle
          title="Comments"
          checked={prefs?.comments ?? true}
          disabled={!prefs || !session?.access_token}
          onChange={(value) => void onTogglePref("comments", value)}
        />
        <PrefToggle
          title="Direct messages"
          checked={prefs?.messages ?? true}
          disabled={!prefs || !session?.access_token}
          onChange={(value) => void onTogglePref("messages", value)}
        />
      </section>
      <div className="row">
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
          {busy ? "Deleting…" : "Delete account"}
        </button>
      </div>
    </main>
  );
}

function roundPercent(used: number, limit: number) {
  return Math.round((used / limit) * 100);
}

function PrefToggle({
  title,
  subtitle,
  checked,
  disabled,
  onChange,
}: {
  title: string;
  subtitle?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="pref-row">
      <span>
        <strong>{title}</strong>
        {subtitle ? <span className="muted">{subtitle}</span> : null}
      </span>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}
