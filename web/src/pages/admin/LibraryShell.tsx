import { Navigate } from "react-router-dom";
import { useStaffPermissions } from "../../lib/staff";
import { AdminClipsPage } from "./AdminClipsPage";
import { AdminSectionShell } from "./components/AdminSectionShell";

export function LibraryShell() {
  const { can } = useStaffPermissions();
  const tabs = [
    can("clips.view") ? { id: "clips", label: "Clips", path: "/admin/library", end: true } : null,
    can("users.quota.edit") ? { id: "storage", label: "Storage", path: "/admin/library/storage" } : null,
  ].filter((tab) => tab != null);

  return <AdminSectionShell label="Library" tabs={tabs} />;
}

export function LibraryHome() {
  const { can } = useStaffPermissions();
  if (can("clips.view")) return <AdminClipsPage />;
  if (can("users.quota.edit")) return <Navigate to="/admin/library/storage" replace />;
  return null;
}
