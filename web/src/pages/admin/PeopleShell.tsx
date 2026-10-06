import { Navigate } from "react-router-dom";
import { useStaffPermissions } from "../../lib/staff";
import { AdminUsersPage } from "./AdminUsersPage";
import { AdminSectionShell } from "./components/AdminSectionShell";

export function PeopleShell() {
  const { can } = useStaffPermissions();
  const tabs = [
    can("users.view") ? { id: "users", label: "Users", path: "/admin/people", end: true } : null,
    can("waitlist.view") ? { id: "waitlist", label: "Waitlist", path: "/admin/people/waitlist" } : null,
    can("creators.view") ? { id: "creators", label: "Creators", path: "/admin/people/creators" } : null,
  ].filter((tab) => tab != null);

  return <AdminSectionShell label="People" tabs={tabs} />;
}

export function PeopleHome() {
  const { can } = useStaffPermissions();
  if (can("users.view")) return <AdminUsersPage />;
  if (can("waitlist.view")) return <Navigate to="/admin/people/waitlist" replace />;
  if (can("creators.view")) return <Navigate to="/admin/people/creators" replace />;
  return null;
}
