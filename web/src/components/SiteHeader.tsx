import { useEffect, useId, useRef, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { isAdminSession } from "../lib/admin";
import { useAuth } from "../lib/auth";
import { useSocialUnread } from "../lib/socialUnread";
import { AppDownloadLink } from "./analytics/AppDownloadLink";
import { APP_NAME, MAC_DOWNLOAD_PATH, WINDOWS_DOWNLOAD_PATH } from "../lib/branding";
import { NotificationBell } from "./NotificationBell";
import { HeaderSearch } from "./HeaderSearch";

export function SiteHeader() {
  const { session } = useAuth();
  const signedIn = Boolean(session);
  const { friendsUnread, messagesUnread } = useSocialUnread();
  const admin = isAdminSession(session);
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [downloadOpen, setDownloadOpen] = useState(false);
  const headerRef = useRef<HTMLElement>(null);
  const menuId = useId();
  const downloadMenuId = useId();

  useEffect(() => {
    setOpen(false);
    setDownloadOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!open && !downloadOpen) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        setDownloadOpen(false);
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (headerRef.current && !headerRef.current.contains(event.target as Node)) {
        setOpen(false);
        setDownloadOpen(false);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open, downloadOpen]);

  return (
    <header className={`site-header${open ? " is-open" : ""}`} ref={headerRef}>
      <div className="site-header-inner">
        <NavLink className="brand" to="/" end>
          <img className="brand-logo" src="/replayr-logo.png" alt={APP_NAME} />
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
            <NavLink to="/explore">Explore</NavLink>
            <NavLink to="/games">Games</NavLink>
            <NavLink to="/pricing">Pricing</NavLink>
            <NavLink to="/creators">Creators</NavLink>
            {signedIn ? (
              <>
                <NavLink to="/library">Library</NavLink>
                <NavLink className="nav-with-pip" to="/friends">
                  Friends
                  {friendsUnread ? <span className="unread-pip" aria-label="Unread" /> : null}
                </NavLink>
                <NavLink className="nav-with-pip" to="/messages">
                  Messages
                  {messagesUnread ? <span className="unread-pip" aria-label="Unread" /> : null}
                </NavLink>
                <NavLink to="/account">Account</NavLink>
                {admin ? <NavLink to="/admin">Admin</NavLink> : null}
              </>
            ) : (
              <NavLink to="/signin">Sign in</NavLink>
            )}
          </nav>
          <div className="header-actions">
            <HeaderSearch />
            <NotificationBell />
            <div className={`download-menu${downloadOpen ? " is-open" : ""}`}>
              <button
                className="btn outline"
                type="button"
                aria-expanded={downloadOpen}
                aria-controls={downloadMenuId}
                onClick={() => setDownloadOpen((value) => !value)}
              >
                Download
              </button>
              <div className="download-menu-panel" id={downloadMenuId} hidden={!downloadOpen}>
                <AppDownloadLink href={WINDOWS_DOWNLOAD_PATH} platform="windows" surface="header" onClick={() => setDownloadOpen(false)}>
                  Windows (.exe)
                </AppDownloadLink>
                <AppDownloadLink href={MAC_DOWNLOAD_PATH} platform="macos" surface="header" onClick={() => setDownloadOpen(false)}>
                  macOS (.dmg)
                </AppDownloadLink>
              </div>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
