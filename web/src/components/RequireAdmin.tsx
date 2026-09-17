import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useStaffPermissions } from "../lib/staff";
import { AccessDenied } from "./RequireStaff";

export function RequireAdmin({ children }: { children: ReactNode }) {
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
  if (!can("admin.access")) return <AccessDenied title="Admin" />;
  return children;
}
