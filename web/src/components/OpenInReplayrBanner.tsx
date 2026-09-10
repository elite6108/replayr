import { useEffect, useMemo, useState } from "react";

const CUSTOM_SCHEME = "tv.elite.replay";

function isMobileUa(ua: string) {
  return /Android|iPhone|iPad|iPod/i.test(ua);
}

function isIos(ua: string) {
  return /iPhone|iPad|iPod/i.test(ua);
}

function isAndroid(ua: string) {
  return /Android/i.test(ua);
}

/**
 * Compact smart banner for mobile browsers viewing a clip share page.
 * Prefer the HTTPS Universal/App Link; fall back to custom scheme + store URLs.
 */
export function OpenInReplayrBanner({ slug }: { slug: string }) {
  const [visible, setVisible] = useState(false);
  const [platform, setPlatform] = useState<"ios" | "android" | null>(null);

  useEffect(() => {
    const ua = navigator.userAgent || "";
    if (!isMobileUa(ua)) return;
    setPlatform(isIos(ua) ? "ios" : isAndroid(ua) ? "android" : null);
    setVisible(true);
  }, []);

  const httpsUrl = useMemo(() => `https://replayr.tv/c/${slug}`, [slug]);
  const customUrl = useMemo(() => `${CUSTOM_SCHEME}://c/${slug}`, [slug]);
  const iosStore = (import.meta.env.VITE_IOS_APP_STORE_URL as string | undefined)?.trim() || "";
  const playStore = (import.meta.env.VITE_ANDROID_PLAY_STORE_URL as string | undefined)?.trim() || "";

  if (!visible || !slug) return null;

  function openApp() {
    const store = platform === "ios" ? iosStore : platform === "android" ? playStore : "";
    const started = Date.now();
    // Prefer verified HTTPS link first (Universal / App Links).
    window.location.href = httpsUrl;
    window.setTimeout(() => {
      // If still visible after a short delay, try the custom scheme.
      if (document.visibilityState === "visible" && Date.now() - started < 2500) {
        window.location.href = customUrl;
      }
    }, 400);
    if (store) {
      window.setTimeout(() => {
        if (document.visibilityState === "visible") {
          window.location.href = store;
        }
      }, 1600);
    }
  }

  return (
    <aside className="open-in-app-banner" aria-label="Open in Replayr">
      <div className="open-in-app-copy">
        <strong>Watch this clip in Replayr</strong>
        <span>Faster playback and the full Replayr experience.</span>
      </div>
      <button type="button" className="btn primary open-in-app-btn" onClick={openApp}>
        Open in Replayr
      </button>
    </aside>
  );
}
