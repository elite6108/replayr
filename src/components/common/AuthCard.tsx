import { FormEvent, useState } from "react";
import { useAuthStore } from "../../stores/authStore";
import { useToastStore } from "../../stores/toastStore";

export function AuthCard({ compact = false }: { compact?: boolean }) {
  const error = useAuthStore((state) => state.error);
  const signIn = useAuthStore((state) => state.signIn);
  const signUp = useAuthStore((state) => state.signUp);
  const showToast = useToastStore((state) => state.show);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const nextEmail = String(form.get("email") ?? email);
    const nextPassword = String(form.get("password") ?? password);
    setEmail(nextEmail);
    setPassword(nextPassword);
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const mode = submitter instanceof HTMLButtonElement && submitter.dataset.mode === "up" ? "up" : "in";
    void (async () => {
      setBusy(true);
      try {
        if (mode === "in") await signIn(nextEmail, nextPassword);
        else await signUp(nextEmail, nextPassword);
        showToast(mode === "in" ? "Signed in" : "Account created");
      } catch {
        /* store sets error */
      } finally {
        setBusy(false);
      }
    })();
  }

  return (
    <section className={`panel auth-card stack ${compact ? "compact" : ""}`}>
      <h2>Sign in</h2>
      <p className="muted">Cloud clips use your Replay account. Passwords stay in Supabase, not on this PC.</p>
      <form className="stack" onSubmit={onSubmit}>
        <div className="field">
          <label htmlFor="auth-email">Email</label>
          <input
            id="auth-email"
            name="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="auth-password">Password</label>
          <input
            id="auth-password"
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            minLength={6}
          />
        </div>
        {error ? <div className="error-text">{error}</div> : null}
        <div className="row">
          <button className="btn primary" type="submit" data-mode="in" disabled={busy}>
            {busy ? "Working…" : "Sign in"}
          </button>
          <button className="btn" type="submit" data-mode="up" disabled={busy}>
            Create account
          </button>
        </div>
      </form>
    </section>
  );
}
