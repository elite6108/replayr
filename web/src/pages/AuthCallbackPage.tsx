import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { Seo } from "../components/Seo";
import { useAuth } from "../lib/auth";
import { getSupabase, supabaseConfigured } from "../lib/supabase";

export function AuthCallbackPage() {
  const { session } = useAuth();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const denied = params.get("error_description") || params.get("error");
    if (denied) {
      setError(denied);
      return;
    }
    const code = params.get("code");
    if (!code || !supabaseConfigured() || session) return;
    const timer = window.setTimeout(() => {
      if (session) return;
      void getSupabase()
        .auth.exchangeCodeForSession(code)
        .then(({ error: next }) => {
          if (next) setError(next.message);
        });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [session]);

  if (session) return <Navigate to="/library" replace />;

  return (
    <main className="page narrow">
      <Seo title="Signing in — Replayr" description="Finishing Replayr sign-in." robots="noindex" />
      <h1>Signing in</h1>
      {error ? <p className="error">{error}</p> : <p className="muted">Finishing sign-in…</p>}
    </main>
  );
}
