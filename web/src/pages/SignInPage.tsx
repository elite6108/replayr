import { FormEvent, useState } from "react";
import { Link, Navigate, useSearchParams } from "react-router-dom";
import { Seo } from "../components/Seo";
import { SocialAuthIcons } from "../components/SocialAuthIcons";
import { useAuth } from "../lib/auth";
import {
  CONFIRM_EMAIL_MESSAGE,
  EXISTING_ACCOUNT_MESSAGE,
  isAlreadyRegisteredError,
  normalizeAuthEmail,
  signupUserAlreadyExists,
} from "../lib/signup";
import { getSupabase, supabaseConfigured } from "../lib/supabase";

type SocialProvider = "google" | "apple" | "discord" | "twitter";

export function SignInPage() {
  const [searchParams] = useSearchParams();
  const { session } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [mode, setMode] = useState<"in" | "up">("in");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const next = safeNext(searchParams.get("next"));

  async function startSocial(provider: SocialProvider) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (!supabaseConfigured()) throw new Error("Supabase is not configured.");
      const { error: oauthErrorResult } = await getSupabase().auth.signInWithOAuth({
        provider,
        options: {
          redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
        },
      });
      if (oauthErrorResult) throw oauthErrorResult;
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
      const normalized = normalizeAuthEmail(email);
      if (mode === "in") {
        const { error: next } = await auth.signInWithPassword({ email: normalized, password });
        if (next) throw next;
      } else {
        if (password !== confirm) {
          setError("Passwords do not match.");
          return;
        }
        const emailRedirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`;
        const { data, error: signUpError } = await auth.signUp({
          email: normalized,
          password,
          options: { emailRedirectTo },
        });
        if (signUpError) {
          if (isAlreadyRegisteredError(signUpError.message)) {
            setError(EXISTING_ACCOUNT_MESSAGE);
            return;
          }
          throw signUpError;
        }
        if (signupUserAlreadyExists(data.user)) {
          setError(EXISTING_ACCOUNT_MESSAGE);
          return;
        }
        if (!data.session) {
          setNotice(CONFIRM_EMAIL_MESSAGE);
          return;
        }
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not sign in");
    } finally {
      setBusy(false);
    }
  }

  async function onForgot() {
    const trimmed = normalizeAuthEmail(email);
    if (!trimmed || !trimmed.includes("@")) {
      setError("Enter the email for your account, then choose Forgot password.");
      setNotice(null);
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (!supabaseConfigured()) throw new Error("Supabase is not configured.");
      const { error: next } = await getSupabase().auth.resetPasswordForEmail(trimmed, {
        redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent("/auth/reset")}`,
      });
      if (next) throw next;
      setNotice("If that email has an account, we sent a reset link. Check your inbox.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not send reset email");
    } finally {
      setBusy(false);
    }
  }

  async function onResend() {
    const trimmed = normalizeAuthEmail(email);
    if (!trimmed || !trimmed.includes("@")) {
      setError("Enter your email, then resend the confirmation.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (!supabaseConfigured()) throw new Error("Supabase is not configured.");
      const { error: resendError } = await getSupabase().auth.resend({
        type: "signup",
        email: trimmed,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
        },
      });
      if (resendError) throw resendError;
      setNotice("Confirmation email sent. Confirm it, then sign in.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not resend the confirmation email");
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
  if (session) return <Navigate to={next} replace />;

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
        <button
          className={`btn ${mode === "in" ? "primary" : ""}`}
          type="button"
          onClick={() => {
            setMode("in");
            setError(null);
            setNotice(null);
          }}
        >
          Sign in
        </button>
        <button
          className={`btn ${mode === "up" ? "primary" : ""}`}
          type="button"
          onClick={() => {
            setMode("up");
            setError(null);
            setNotice(null);
          }}
        >
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
        {mode === "up" ? (
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
        ) : null}
        {mode === "in" ? (
          <button className="auth-forgot" type="button" disabled={busy} onClick={() => void onForgot()}>
            Forgot password?
          </button>
        ) : null}
        {error ? <p className="error">{error}</p> : null}
        {error === EXISTING_ACCOUNT_MESSAGE ? (
          <button
            className="btn"
            type="button"
            disabled={busy}
            onClick={() => {
              setMode("in");
              setError(null);
            }}
          >
            Sign in
          </button>
        ) : null}
        {notice ? <p className="muted">{notice}</p> : null}
        {notice === CONFIRM_EMAIL_MESSAGE ? (
          <button className="auth-forgot" type="button" disabled={busy || !email.trim()} onClick={() => void onResend()}>
            Resend email
          </button>
        ) : null}
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

function safeNext(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/library";
  return value;
}

function oauthError(caught: unknown): string {
  const message = caught instanceof Error ? caught.message : "Could not start social sign-in";
  if (/provider is not enabled|unsupported provider/i.test(message)) {
    return "That sign-in method is not enabled yet.";
  }
  return message;
}
