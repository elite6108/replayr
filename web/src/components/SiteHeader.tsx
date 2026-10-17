import { useEffect, useId, useRef, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { isAdminSession } from "../lib/admin";
import { useStaffPermissions } from "../lib/staff";
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
  const { can } = useStaffPermissions();
  const staff = can("staff.access");
  const location = useLocation();
  const home = location.pathname === "/";
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
    <header className={`site-header${home ? " site-header-home" : ""}${open ? " is-open" : ""}`} ref={headerRef}>
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
            {home ? <NavLink to="/" end>Home</NavLink> : null}
            <NavLink to="/features">{home ? "How it works" : "Features"}</NavLink>
            {home ? null : <NavLink to="/explore">Explore</NavLink>}
            {home ? null : <NavLink to="/games">Games</NavLink>}
            {home ? <NavLink to="/library">Library</NavLink> : null}
            <NavLink to="/pricing">Pricing</NavLink>
            {home ? null : <NavLink to="/creators">Creators</NavLink>}
            {signedIn ? (
              <>
                {home ? null : <NavLink to="/library">Library</NavLink>}
                <NavLink className="nav-with-pip" to="/friends">
                  Friends
                  {friendsUnread ? <span className="unread-pip" aria-label="Unread" /> : null}
                </NavLink>
                <NavLink className="nav-with-pip" to="/messages">
                  Messages
                  {messagesUnread ? <span className="unread-pip" aria-label="Unread" /> : null}
                </NavLink>
                <NavLink to="/account">Account</NavLink>
                {staff ? (
                  <NavLink to="/staff/board" className={() => (location.pathname.startsWith("/staff") ? "nav-staff active" : "nav-staff")}>
                    Staff
                  </NavLink>
                ) : null}
                {admin || can("admin.access") ? (
                  <NavLink to="/admin" className={() => (location.pathname.startsWith("/admin") ? "active" : "")}>
                    Admin
                  </NavLink>
                ) : null}
              </>
            ) : home ? null : (
              <NavLink to="/signin">Sign in</NavLink>
            )}
          </nav>
          <div className="header-actions">
            <HeaderSearch pill={home} />
            <NotificationBell />
            {home && !signedIn ? <NavLink className="home-signin" to="/signin">Sign in</NavLink> : null}
            <div className={`download-menu${downloadOpen ? " is-open" : ""}`}>
              <button
                className={home ? "btn home-download" : "btn outline"}
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
            {home ? (
              <a className="home-social" href="https://x.com/Replayr_TV" target="_blank" rel="noreferrer" aria-label="Replayr on X">
                <XIcon />
              </a>
            ) : null}
            {home ? (
              <a className="home-social" href="https://discord.com/app" target="_blank" rel="noreferrer" aria-label="Replayr on Discord">
                <DiscordIcon />
              </a>
            ) : null}
          </div>
        </div>
      </div>
    </header>
  );
}

function XIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M14.7 10.3 22.4 1h-1.8l-6.7 8.1L8.6 1H1.7l8.1 12.2L1.7 23h1.8l7.1-8.6L15.4 23h6.9l-7.6-12.7Zm-2.5 3-0.8-1.2L4.2 2.4h2.8l5.2 7.7.8 1.2 6.8 10.2h-2.8l-5.8-8.2Z" />
    </svg>
  );
}

function DiscordIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M19.3 5.2A17 17 0 0 0 15.1 4l-.4.8a15.6 15.6 0 0 1 3.8 1.5 16 16 0 0 0-12.9 0A12 12 0 0 1 9.3 4.8L8.9 4a17 17 0 0 0-4.2 1.2C2.4 8.6 1.7 11.9 2 15.2A17.4 17.4 0 0 0 7.3 18l.8-1.1a11.3 11.3 0 0 1-1.7-.8l.4-.3c3.3 1.5 6.9 1.5 10.2 0l.4.3c-.5.3-1.1.6-1.7.8l.8 1.1a17.4 17.4 0 0 0 5.3-2.8c.4-3.8-.6-7.1-2.5-10Zm-10 8.1c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2Zm5.4 0c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2Z"
      />
    </svg>
  );
}
