import { Link, useLocation } from "react-router-dom";
import { APP_NAME, SUPPORT_EMAIL } from "../lib/branding";

export function SiteFooter() {
  const home = useLocation().pathname === "/";
  if (home) {
    return (
      <footer className="site-footer site-footer-home">
        <div className="site-footer-home-inner">
          <Link className="brand" to="/">
            <img className="brand-logo" src="/replayr-logo.png" alt={APP_NAME} />
          </Link>
          <p>© {new Date().getFullYear()} Replayr. Clipping happens on Windows.</p>
          <div className="site-footer-home-links">
            <Link to="/privacy">Privacy</Link>
            <Link to="/terms">Terms</Link>
            <a href={`mailto:${SUPPORT_EMAIL}`}>Help</a>
            <a className="home-social" href="https://x.com/Replayr_TV" target="_blank" rel="noreferrer" aria-label="Replayr on X">
              <XIcon />
            </a>
            <span className="home-social" aria-hidden="true">
              <DiscordIcon />
            </span>
          </div>
        </div>
      </footer>
    );
  }

  return (
    <footer className="site-footer">
      <div className="site-footer-inner">
        <nav className="footer-nav" aria-label="Footer">
          <Link to="/features">Features</Link>
          <Link to="/games">Games</Link>
          <Link to="/pricing">Pricing</Link>
          <Link to="/creators">Creators</Link>
          <Link to="/releases">Release notes</Link>
          <Link to="/privacy">Privacy</Link>
          <Link to="/terms">Terms</Link>
          <a href={`mailto:${SUPPORT_EMAIL}`}>Help</a>
        </nav>
      </div>
      <div className="site-footer-bar">
        <Link className="brand" to="/">
          <img className="brand-logo" src="/replayr-logo.png" alt={APP_NAME} />
        </Link>
        <p>© {new Date().getFullYear()} Replayr. Clipping happens on Windows.</p>
      </div>
    </footer>
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
