import { useEffect, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { AdminSidebar } from "./AdminSidebar";
import { IconClose, IconMenu } from "./adminIcons";

export function AdminShell({ children }: { children: ReactNode }) {
  const location = useLocation();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className={`admin-shell${open ? " is-nav-open" : ""}`}>
      <div className="admin-mobile-bar">
        <button type="button" className="admin-menu-btn" aria-label={open ? "Close admin menu" : "Open admin menu"} onClick={() => setOpen((value) => !value)}>
          {open ? <IconClose /> : <IconMenu />}
          Menu
        </button>
      </div>
      {open ? <button type="button" className="admin-nav-backdrop" aria-label="Close admin menu" onClick={() => setOpen(false)} /> : null}
      <AdminSidebar onNavigate={() => setOpen(false)} />
      <div className="admin-main">{children}</div>
    </div>
  );
}
