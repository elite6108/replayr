import { FormEvent, useEffect, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { Seo } from "../components/Seo";
import { getSupabase, supabaseConfigured } from "../lib/supabase";

export function ResetPasswordPage() {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [done, setDone] = useState(false);
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    if (!supabaseConfigured()) {
      setInvalid(true);
      return;
    }
    const supabase = getSupabase();
    let cancelled = false;

    async function hydrateRecovery() {
      const denied =
        new URLSearchParams(window.location.search).get("error_description") ||
        new URLSearchParams(window.location.search).get("error") ||
        new URLSearchParams(window.location.hash.replace(/^#/, "")).get("error_description");
      if (denied) {
        if (!cancelled) {
          setError(denied);
          setInvalid(true);
        }
        return;
      }

      const code =
        new URLSearchParams(window.location.search).get("code") ||
        new URLSearchParams(window.location.hash.replace(/^#/, "")).get("code");
      if (code) {
        const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
        if (exchangeError && !cancelled) {
          setError(exchangeError.message);
        }
      }

      const { data } = await supabase.auth.getSession();
      if (cancelled) return;
      if (data.session) {
        setReady(true);
        setInvalid(false);
        setError(null);
        return;
      }
      setInvalid(true);
    }

    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY" || session) {
        setReady(true);
        setInvalid(false);
      }
    });

    void hydrateRecovery();
    return () => {
      cancelled = true;
      data.subscription.unsubscribe();
    };
  }, []);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { error: next } = await getSupabase().auth.updateUser({ password });
      if (next) throw next;
      setDone(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update password");
    } finally {
      setBusy(false);
    }
  }

  if (done) return <Navigate to="/library" replace />;

  return (
    <main className="page narrow">
      <Seo title="Reset password — Replayr" description="Choose a new Replayr password." robots="noindex" />
      <h1>Set a new password</h1>
      {!ready && !invalid ? <p className="muted">Checking reset link…</p> : null}
      {invalid ? (
        <>
          <p className="error">{error || "This reset link is invalid or expired."}</p>
          <p className="muted">
            Request a new one from <Link to="/signin">sign in</Link>.
          </p>
        </>
      ) : null}
      {ready ? (
        <form className="stack" onSubmit={(event) => void onSubmit(event)}>
          <p className="muted">Choose a new password for this Replayr account.</p>
          <label className="field">
            New password
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              minLength={6}
              autoComplete="new-password"
            />
          </label>
          <label className="field">
            Confirm password
            <input
              type="password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              required
              minLength={6}
              autoComplete="new-password"
            />
          </label>
          {error ? <p className="error">{error}</p> : null}
          <button className="btn primary" type="submit" disabled={busy}>
            {busy ? "Saving…" : "Update password"}
          </button>
        </form>
      ) : null}
    </main>
  );
}
