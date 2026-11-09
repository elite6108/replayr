import { useEffect, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { isAdminSession } from "../lib/admin";
import { useAuth } from "../lib/auth";
import { SUPPORT_EMAIL, WINDOWS_DOWNLOAD_PATH } from "../lib/branding";
import { useStaffPermissions } from "../lib/staff";
import { useSocialUnread } from "../lib/socialUnread";
import { AppDownloadLink } from "./analytics/AppDownloadLink";
import { HeaderSearch } from "./HeaderSearch";
import { NotificationBell } from "./NotificationBell";
import "../landing.css";

const asset = "/marketing/landing";

export function SiteHeader() {
  const { session } = useAuth();
  const signedIn = Boolean(session);
  const { friendsUnread, messagesUnread } = useSocialUnread();
  const admin = isAdminSession(session);
  const { can } = useStaffPermissions();
  const staff = can("staff.access");
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const id = "land-fonts";
    if (document.getElementById(id)) return;
    const link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    link.href =
      "https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=Space+Grotesk:wght@500;700&display=swap";
    document.head.append(link);
  }, []);

  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname, location.hash]);

  function closeMenu() {
    setMenuOpen(false);
  }

  const home = location.pathname === "/";

  return (
    <header className={`land-nav${menuOpen ? " is-open" : ""}`}>
      <div className="land-nav-left">
        <NavLink className="land-logo" to="/" end onClick={closeMenu}>
          <img src="/replayr-mark.png" alt="" />
          <span className="replayr-logo-name">Replayr<span>.</span></span>
        </NavLink>
        <span className="land-nav-rule" aria-hidden="true" />
        <nav className="land-links" aria-label="Primary">
          <NavLink to="/" end onClick={closeMenu}>Home</NavLink>
          <a href={home ? "#how" : "/#how"} onClick={closeMenu}>How it works</a>
          <NavLink to="/library" onClick={closeMenu}>Library</NavLink>
          <a href={home ? "#pricing" : "/#pricing"} onClick={closeMenu}>Pricing</a>
          <a href={`mailto:${SUPPORT_EMAIL}`} onClick={closeMenu}>Help</a>
          {signedIn ? (
            <>
              <NavLink className="nav-with-pip" to="/friends" onClick={closeMenu}>
                Friends
                {friendsUnread ? <span className="unread-pip" aria-label="Unread" /> : null}
              </NavLink>
              <NavLink className="nav-with-pip" to="/messages" onClick={closeMenu}>
                Messages
                {messagesUnread ? <span className="unread-pip" aria-label="Unread" /> : null}
              </NavLink>
              {staff ? (
                <NavLink to="/staff/board" onClick={closeMenu} className={() => (location.pathname.startsWith("/staff") ? "active" : undefined)}>
                  Staff
                </NavLink>
              ) : null}
              {admin || can("admin.access") ? (
                <NavLink to="/admin" onClick={closeMenu} className={() => (location.pathname.startsWith("/admin") ? "active" : undefined)}>
                  Admin
                </NavLink>
              ) : null}
            </>
          ) : null}
        </nav>
      </div>
      <div className="land-nav-right">
        <HeaderSearch pill />
        {signedIn ? (
          <NavLink className="land-signin" to="/account" onClick={closeMenu}>Account</NavLink>
        ) : (
          <NavLink className="land-signin" to="/signin" onClick={closeMenu}>Sign in</NavLink>
        )}
        {signedIn ? <NotificationBell /> : null}
        <AppDownloadLink className="land-download" href={WINDOWS_DOWNLOAD_PATH} platform="windows" surface="header" onClick={closeMenu}>
          <img src={`${asset}/windows.svg`} alt="" />
          Download
        </AppDownloadLink>
        <a className="land-social" href="https://x.com/Replayr_TV" target="_blank" rel="noreferrer" aria-label="Replayr on X">
          <img src={`${asset}/x.svg`} alt="" />
        </a>
        <a className="land-social" href="https://discord.com/app" target="_blank" rel="noreferrer" aria-label="Replayr on Discord">
          <DiscordMark />
        </a>
        <button
          className="land-menu"
          type="button"
          aria-expanded={menuOpen}
          aria-label={menuOpen ? "Close menu" : "Open menu"}
          onClick={() => setMenuOpen((value) => !value)}
        >
          <span />
        </button>
      </div>
    </header>
  );
}

function DiscordMark() {
  return (
    <svg width="22" height="16" viewBox="0 0 24 18" aria-hidden="true">
      <path
        fill="currentColor"
        d="M20.3 1.6A17 17 0 0 0 15.7.4l-.4.8a14 14 0 0 1 3.5 1.4 15 15 0 0 0-13.6 0A11 11 0 0 1 8.7 1.2L8.3.4A17 17 0 0 0 3.7 1.6C1.2 5.2.5 8.7.8 12.2A16 16 0 0 0 6.4 15l.8-1.1a10 10 0 0 1-1.6-.8l.4-.3c3.1 1.5 6.5 1.5 9.6 0l.4.3c-.5.3-1 .6-1.6.8l.8 1.1a16 16 0 0 0 5.6-2.8c.4-4-.7-7.5-2.5-10.6ZM8.2 10.6c-.9 0-1.7-.8-1.7-1.9s.8-1.8 1.7-1.8 1.7.8 1.7 1.8-.8 1.9-1.7 1.9Zm7.2 0c-.9 0-1.7-.8-1.7-1.9s.8-1.8 1.7-1.8 1.7.8 1.7 1.8-.8 1.9-1.7 1.9Z"
      />
    </svg>
  );
}
