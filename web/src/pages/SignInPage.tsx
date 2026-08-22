import { FormEvent, useState } from "react";
import { Navigate } from "react-router-dom";
import { Seo } from "../components/Seo";
import { useAuth } from "../lib/auth";
import { getSupabase, supabaseConfigured } from "../lib/supabase";

export function SignInPage() {
  const { session } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"in" | "up">("in");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

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
        description="Sign in with the same email and password as the Windows app to manage cloud clips."
        robots="noindex"
      />
      <h1>{mode === "in" ? "Sign in" : "Create free account"}</h1>
      <p className="muted">Same account as the Windows app. Clipping still happens on the PC. Cloud copies show up here.</p>
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
        <div className="row">
          <button className="btn primary" type="submit" disabled={busy}>
            {mode === "in" ? "Sign in" : "Create account"}
          </button>
          <button
            className="btn"
            type="button"
            onClick={() => {
              setMode(mode === "in" ? "up" : "in");
              setError(null);
              setNotice(null);
            }}
          >
            {mode === "in" ? "Need an account?" : "Have an account?"}
          </button>
        </div>
      </form>
    </main>
  );
}
