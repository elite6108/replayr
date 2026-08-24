import { Link } from "react-router-dom";
import { APP_NAME, SUPPORT_EMAIL } from "../lib/branding";

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-footer-inner">
        <nav className="footer-nav" aria-label="Footer">
          <Link to="/features">Features</Link>
          <Link to="/games">Games</Link>
          <Link to="/pricing">Pricing</Link>
          <Link to="/creators">Creators</Link>
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
