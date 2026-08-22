import { NavLink } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { APP_NAME, WINDOWS_DOWNLOAD_PATH } from "../lib/branding";

export function SiteHeader() {
  const { session } = useAuth();
  const signedIn = Boolean(session);

  return (
    <header className="site-header">
      <div className="site-header-inner">
        <NavLink className="brand" to="/" end>
          <span className="brand-mark">R</span>
          {APP_NAME}
        </NavLink>
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
    </header>
  );
}
