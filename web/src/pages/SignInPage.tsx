import { FormEvent, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { Seo } from "../components/Seo";
import { SocialAuthIcons } from "../components/SocialAuthIcons";
import { useAuth } from "../lib/auth";
import { getSupabase, supabaseConfigured } from "../lib/supabase";

type SocialProvider = "google" | "apple" | "discord" | "twitter";

export function SignInPage() {
  const { session } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"in" | "up">("in");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function startSocial(provider: SocialProvider) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (!supabaseConfigured()) throw new Error("Supabase is not configured.");
      const { error: next } = await getSupabase().auth.signInWithOAuth({
        provider,
        options: {
          redirectTo: `${window.location.origin}/auth/callback`,
        },
      });
      if (next) throw next;
    } catch (caught) {
      setError(oauthError(caught));
      setBusy(false);
    }
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (!supabaseConfigured()) throw new Error("Supabase is not configured.");
      const auth = getSupabase().auth;
      if (mode === "in") {
        const { error: next } = await auth.signInWithPassword({ email: email.trim(), password });
        if (next) throw next;
      } else {
        const { data, error: next } = await auth.signUp({ email: email.trim(), password });
        if (next) throw next;
        if (!data.session) {
          setNotice("Account created. Confirm the email, then sign in.");
          return;
        }
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not sign in");
    } finally {
      setBusy(false);
    }
  }

  if (session === undefined) {
    return (
      <main className="page narrow">
        <p className="muted">Loading…</p>
      </main>
    );
  }
  if (session) return <Navigate to="/library" replace />;

  return (
    <main className="page narrow">
      <Seo
        title="Sign in — Replayr"
        description="Sign in with Google, Discord, X, or the same email as the Windows app."
        robots="noindex"
      />
      <h1>{mode === "in" ? "Sign in" : "Create account"}</h1>
      <p className="muted">Same Replayr account as the Windows app. Clipping still happens on the PC.</p>
      <div className="auth-modes">
        <button className={`btn ${mode === "in" ? "primary" : ""}`} type="button" onClick={() => setMode("in")}>
          Sign in
        </button>
        <button className={`btn ${mode === "up" ? "primary" : ""}`} type="button" onClick={() => setMode("up")}>
          Create account
        </button>
      </div>
      <SocialAuthIcons disabled={busy} onProvider={(provider) => void startSocial(provider)} />
      <div className="auth-divider" style={{ margin: "18px 0" }}>
        or email
      </div>
      <form className="stack" onSubmit={(event) => void onSubmit(event)}>
        <label className="field">
          Email
          <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required autoComplete="email" />
        </label>
        <label className="field">
          Password
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            minLength={6}
            autoComplete={mode === "in" ? "current-password" : "new-password"}
          />
        </label>
        {error ? <p className="error">{error}</p> : null}
        {notice ? <p className="muted">{notice}</p> : null}
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? "Working…" : mode === "in" ? "Sign in" : "Create account"}
        </button>
        <p className="muted">
          By continuing you agree to the <Link to="/terms">Terms</Link> and{" "}
          <Link to="/privacy">Privacy Policy</Link>.
        </p>
      </form>
    </main>
  );
}

function oauthError(caught: unknown): string {
  const message = caught instanceof Error ? caught.message : "Could not start social sign-in";
  if (/provider is not enabled|unsupported provider/i.test(message)) {
    return "That sign-in method is not enabled yet.";
  }
  return message;
}
