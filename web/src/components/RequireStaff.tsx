import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { Seo } from "./Seo";
import { useAuth } from "../lib/auth";
import { useStaffPermissions } from "../lib/staff";

export function AccessDenied({ title = "Access denied" }: { title?: string }) {
  return (
    <main className="page narrow">
      <Seo title={`${title} — Replayr`} description="Restricted staff area." robots="noindex,nofollow" />
      <h1>Access denied</h1>
      <p className="muted">You are signed in, but you do not have permission to open this page.</p>
    </main>
  );
}

export function RequireStaff({
  children,
  permission = "staff.access",
}: {
  children: ReactNode;
  permission?: string;
}) {
  const { session } = useAuth();
  const { loading, can } = useStaffPermissions();
  if (session === undefined || loading) {
    return (
      <main className="page">
        <p className="muted">Loading…</p>
      </main>
    );
  }
  if (!session) return <Navigate to="/signin" replace />;
  if (!can(permission)) return <AccessDenied />;
  return children;
}
