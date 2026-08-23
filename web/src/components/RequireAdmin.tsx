import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { isAdminSession } from "../lib/admin";
import { useAuth } from "../lib/auth";
import { Seo } from "./Seo";

export function RequireAdmin({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  if (session === undefined) {
    return (
      <main className="page">
        <p className="muted">Loading…</p>
      </main>
    );
  }
  if (!session) return <Navigate to="/signin" replace />;
  if (!isAdminSession(session)) {
    return (
      <main className="page narrow">
        <Seo title="Admin — Replayr" description="Restricted operator console." robots="noindex,nofollow" />
        <h1>No access</h1>
        <p className="muted">
          This console is limited to operator accounts. If you were just granted access, sign out and sign in again so
          your session picks up the new role.
        </p>
      </main>
    );
  }
  return children;
}
