import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  fetchActiveAnnouncements,
  markAnnouncementDismissed,
  markAnnouncementShown,
  pickAnnouncement,
  retainVisibleAnnouncement,
  type Announcement,
} from "../lib/announcements";
import { useAuth } from "../lib/auth";
import { fetchBillingStatus } from "../lib/billing";

export function AnnouncementHost({ surface = "web" as const }: { surface?: "web" }) {
  const { session } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [item, setItem] = useState<Announcement | null>(null);
  const [premium, setPremium] = useState<boolean | null>(null);
  const signedIn = Boolean(session?.user);
  const shownKey = useRef("");
  const hide =
    location.pathname.startsWith("/auth/") ||
    location.pathname === "/signin" ||
    location.pathname.startsWith("/admin");

  useEffect(() => {
    if (!item) {
      shownKey.current = "";
      return;
    }
    const key = `${item.id}:${item.revision}`;
    if (shownKey.current === key) return;
    shownKey.current = key;
    markAnnouncementShown(item);
  }, [item]);

  useEffect(() => {
    if (!session?.access_token) {
      setPremium(null);
      return;
    }
    let cancelled = false;
    void fetchBillingStatus(session.access_token)
      .then((status) => {
        if (!cancelled) setPremium(Boolean(status.premium));
      })
      .catch(() => {
        if (!cancelled) setPremium(null);
      });
    return () => {
      cancelled = true;
    };
  }, [session?.access_token]);

  useEffect(() => {
    if (hide) {
      setItem(null);
      return;
    }
    if (session === undefined) return;
    let cancelled = false;
    let retryTimer = 0;
    const token = session?.access_token ?? null;
    const viewer = { signedIn, premium };

    async function load() {
      try {
        const items = await fetchActiveAnnouncements(surface, token);
        if (cancelled) return;
        const next = pickAnnouncement(items, viewer);
        setItem((current) => retainVisibleAnnouncement(items, current, next, viewer));
      } catch {
        // Keep whatever is visible; retry soon so a late-starting API still surfaces.
        if (!cancelled) {
          window.clearTimeout(retryTimer);
          retryTimer = window.setTimeout(() => void load(), 8_000);
        }
      }
    }

    void load();
    const timer = window.setInterval(() => void load(), 15 * 60 * 1000);
    function onVisible() {
      if (document.visibilityState === "visible") void load();
    }
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.clearTimeout(retryTimer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [session, signedIn, premium, hide, surface]);

  if (hide || !item) return null;

  function dismiss() {
    if (!item || item.dismissible === false) return;
    markAnnouncementDismissed(item);
    setItem(null);
  }

  function openCta() {
    if (!item?.ctaUrl) return;
    const href = item.ctaUrl;
    if (href.startsWith("/")) navigate(href);
    else window.open(href, "_blank", "noopener,noreferrer");
  }

  if (item.placement === "banner") {
    return (
      <aside className="announce-banner" role="status">
        {item.imageUrl ? <img src={item.imageUrl} alt="" /> : null}
        <div className="announce-copy">
          <strong>{item.title}</strong>
          {item.body ? <p>{item.body}</p> : null}
        </div>
        <div className="announce-actions">
          {item.ctaUrl ? (
            <button className="btn primary" type="button" onClick={openCta}>
              {item.ctaLabel || "Learn more"}
            </button>
          ) : null}
          {item.dismissible !== false ? (
            <button className="btn ghost announce-x" type="button" onClick={dismiss} aria-label="Dismiss">
              ×
            </button>
          ) : null}
        </div>
      </aside>
    );
  }

  return (
    <div className="announce-overlay" role="dialog" aria-modal="true" aria-labelledby="announce-title">
      <button className="announce-backdrop" type="button" onClick={dismiss} aria-label="Close announcement" />
      <div className="announce-modal">
        {item.imageUrl ? <img src={item.imageUrl} alt="" /> : null}
        <div className="announce-modal-body">
          <h2 id="announce-title">{item.title}</h2>
          {item.body ? <p>{item.body}</p> : null}
          <div className="announce-actions">
            {item.ctaUrl ? (
              <button className="btn primary" type="button" onClick={openCta}>
                {item.ctaLabel || "Learn more"}
              </button>
            ) : null}
            {item.dismissible !== false ? (
              <button className="btn" type="button" onClick={dismiss}>
                Close
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
