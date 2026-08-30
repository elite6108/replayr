import { FormEvent, useState } from "react";
import { publicSiteUrl } from "../../branding";
import { IconDiscord, IconGoogle, IconX } from "../icons";
import { useAuthStore, type SocialProvider } from "../../stores/authStore";
import { useToastStore } from "../../stores/toastStore";

const PROVIDERS: { id: SocialProvider; label: string; icon: typeof IconGoogle }[] = [
  { id: "google", label: "Continue with Google", icon: IconGoogle },
  { id: "discord", label: "Continue with Discord", icon: IconDiscord },
  { id: "twitter", label: "Continue with X", icon: IconX },
];

export function AuthCard({ compact = false }: { compact?: boolean }) {
  const error = useAuthStore((state) => state.error);
  const signIn = useAuthStore((state) => state.signIn);
  const signUp = useAuthStore((state) => state.signUp);
  const signInWithProvider = useAuthStore((state) => state.signInWithProvider);
  const showToast = useToastStore((state) => state.show);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
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
    const nextEmail = String(form.get("email") ?? email);
    const nextPassword = String(form.get("password") ?? password);
    setEmail(nextEmail);
    setPassword(nextPassword);
    void run(
      () => (mode === "in" ? signIn(nextEmail, nextPassword) : signUp(nextEmail, nextPassword)),
      mode === "in" ? "Signed in" : "Account created",
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
