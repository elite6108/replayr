import { useEffect, useId, useRef, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { isAdminSession } from "../lib/admin";
import { useAuth } from "../lib/auth";
import { APP_NAME, WINDOWS_DOWNLOAD_PATH } from "../lib/branding";

export function SiteHeader() {
  const { session } = useAuth();
  const signedIn = Boolean(session);
  const admin = isAdminSession(session);
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const headerRef = useRef<HTMLElement>(null);
  const menuId = useId();

  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (headerRef.current && !headerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  return (
    <header className={`site-header${open ? " is-open" : ""}`} ref={headerRef}>
      <div className="site-header-inner">
        <NavLink className="brand" to="/" end>
          <span className="brand-mark">R</span>
          {APP_NAME}
        </NavLink>
        <button
          className="menu-toggle"
          type="button"
          aria-expanded={open}
          aria-controls={menuId}
          aria-label={open ? "Close menu" : "Open menu"}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="menu-toggle-bars" aria-hidden="true" />
        </button>
        <div className="site-header-menu" id={menuId}>
          <nav className="site-nav" aria-label="Primary">
            <NavLink to="/features">Features</NavLink>
            <NavLink to="/games">Games</NavLink>
            <NavLink to="/pricing">Pricing</NavLink>
            <NavLink to="/creators">Creators</NavLink>
            {signedIn ? (
              <>
                <NavLink to="/library">Library</NavLink>
                <NavLink to="/friends">Friends</NavLink>
                <NavLink to="/account">Account</NavLink>
                {admin ? <NavLink to="/admin">Admin</NavLink> : null}
              </>
            ) : (
              <NavLink to="/signin">Sign in</NavLink>
            )}
          </nav>
          <div className="header-actions">
            <a className="btn outline" href={WINDOWS_DOWNLOAD_PATH}>
              Download
            </a>
          </div>
        </div>
      </div>
    </header>
  );
}
