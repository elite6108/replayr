import { useEffect, useRef, useState } from "react";
import { publicSiteUrl } from "../../branding";
import {
  fetchActiveAnnouncements,
  markAnnouncementDismissed,
  markAnnouncementShown,
  pickAnnouncement,
  retainVisibleAnnouncement,
  type Announcement,
} from "../../services/announcements";
import { useAuthStore } from "../../stores/authStore";
import { useBillingStore } from "../../stores/billingStore";

export function AnnouncementHost() {
  const signedIn = Boolean(useAuthStore((state) => state.user));
  const token = useAuthStore((state) => state.session?.access_token ?? null);
  const premium = useBillingStore((state) => (state.status ? Boolean(state.status.premium) : null));
  const [item, setItem] = useState<Announcement | null>(null);
  const shownKey = useRef("");

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
    let cancelled = false;
    let retryTimer = 0;
    const viewer = { signedIn, premium: signedIn ? premium : null };

    async function load() {
      try {
        const items = await fetchActiveAnnouncements("desktop", token);
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
  }, [signedIn, premium, token]);

  if (!item) return null;

  function dismiss() {
    if (!item || item.dismissible === false) return;
    markAnnouncementDismissed(item);
    setItem(null);
  }

  function openCta() {
    if (!item?.ctaUrl) return;
    const href = item.ctaUrl.startsWith("/") ? `${publicSiteUrl()}${item.ctaUrl}` : item.ctaUrl;
    void import("@tauri-apps/plugin-opener").then(({ openUrl }) => openUrl(href));
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
