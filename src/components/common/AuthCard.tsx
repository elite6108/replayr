import { FormEvent, useState } from "react";
import { publicSiteUrl } from "../../branding";
import { IconApple, IconDiscord, IconGoogle, IconX } from "../icons";
import { useAuthStore, type SocialProvider } from "../../stores/authStore";
import { useToastStore } from "../../stores/toastStore";

const PROVIDERS: { id: SocialProvider; label: string; icon: typeof IconGoogle }[] = [
  { id: "google", label: "Continue with Google", icon: IconGoogle },
  { id: "apple", label: "Continue with Apple", icon: IconApple },
  { id: "discord", label: "Continue with Discord", icon: IconDiscord },
  { id: "twitter", label: "Continue with X", icon: IconX },
];

export function AuthCard({ compact = false }: { compact?: boolean }) {
  const error = useAuthStore((state) => state.error);
  const passwordRecovery = useAuthStore((state) => state.passwordRecovery);
  const signIn = useAuthStore((state) => state.signIn);
  const signUp = useAuthStore((state) => state.signUp);
  const signInWithProvider = useAuthStore((state) => state.signInWithProvider);
  const requestPasswordReset = useAuthStore((state) => state.requestPasswordReset);
  const updatePassword = useAuthStore((state) => state.updatePassword);
  const showToast = useToastStore((state) => state.show);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [mode, setMode] = useState<"in" | "up">("in");
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<void>, success: string) {
    setBusy(true);
    try {
      await action();
      showToast(success);
    } catch {
      /* store sets error */
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (passwordRecovery) {
      const nextPassword = String(form.get("password") ?? password);
      const nextConfirm = String(form.get("confirm") ?? confirm);
      setPassword(nextPassword);
      setConfirm(nextConfirm);
      if (nextPassword !== nextConfirm) {
        useAuthStore.setState({ error: "Passwords do not match." });
        return;
      }
      void run(() => updatePassword(nextPassword), "Password updated");
      return;
    }
    const nextEmail = String(form.get("email") ?? email);
    const nextPassword = String(form.get("password") ?? password);
    setEmail(nextEmail);
    setPassword(nextPassword);
    void run(
      () => (mode === "in" ? signIn(nextEmail, nextPassword) : signUp(nextEmail, nextPassword)),
      mode === "in" ? "Signed in" : "Account created",
    );
  }

  if (passwordRecovery) {
    return (
      <section className={`panel auth-card stack ${compact ? "compact" : ""}`}>
        <h2>Set a new password</h2>
        <p className="muted">Choose a new password for this Replayr account.</p>
        <form className="stack" onSubmit={onSubmit}>
          <div className="field">
            <label htmlFor="auth-new-password">New password</label>
            <input
              id="auth-new-password"
              name="password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              minLength={6}
            />
          </div>
          <div className="field">
            <label htmlFor="auth-confirm-password">Confirm password</label>
            <input
              id="auth-confirm-password"
              name="confirm"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              required
              minLength={6}
            />
          </div>
          {error ? <div className="error-text">{error}</div> : null}
          <button className="btn primary" type="submit" disabled={busy}>
            {busy ? "Saving…" : "Update password"}
          </button>
        </form>
      </section>
    );
  }

  return (
    <section className={`panel auth-card stack ${compact ? "compact" : ""}`}>
      <h2>{mode === "in" ? "Sign in" : "Create account"}</h2>
      <p className="muted">Same Replayr account on this PC and the website. Cloud clips stay on your account, not in the URL.</p>
      <div className="auth-modes">
        <button
          className={`btn ${mode === "in" ? "primary" : ""}`}
          type="button"
          onClick={() => setMode("in")}
        >
          Sign in
        </button>
        <button
          className={`btn ${mode === "up" ? "primary" : ""}`}
          type="button"
          onClick={() => setMode("up")}
        >
          Create account
        </button>
      </div>
      <div className="auth-social">
        {PROVIDERS.map((provider) => {
          const Icon = provider.icon;
          return (
            <button
              key={provider.id}
              className="auth-social-icon"
              type="button"
              disabled={busy}
              aria-label={provider.label}
              onClick={() => void run(() => signInWithProvider(provider.id), "Finish sign-in in your browser")}
            >
              <Icon size={20} />
            </button>
          );
        })}
      </div>
      <div className="auth-divider">or email</div>
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
            autoComplete={mode === "in" ? "current-password" : "new-password"}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            minLength={6}
          />
        </div>
        {mode === "in" ? (
          <button
            className="auth-forgot"
            type="button"
            disabled={busy}
            onClick={() =>
              void run(
                () => requestPasswordReset(email),
                "If that email has an account, we sent a reset link. Open it to finish in Replayr.",
              )
            }
          >
            Forgot password?
          </button>
        ) : null}
        {error ? <div className="error-text">{error}</div> : null}
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? "Working…" : mode === "in" ? "Sign in" : "Create account"}
        </button>
        <p className="muted">
          By continuing you agree to the{" "}
          <a href={`${publicSiteUrl()}/terms`} target="_blank" rel="noreferrer">
            Terms
          </a>{" "}
          and{" "}
          <a href={`${publicSiteUrl()}/privacy`} target="_blank" rel="noreferrer">
            Privacy Policy
          </a>
          .
        </p>
      </form>
    </section>
  );
}
