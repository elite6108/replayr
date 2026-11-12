export const APP_NAME = "Replayr";
export const APP_IDENTIFIER = "tv.elite.replay";
export const SUPPORT_EMAIL = "support@replayr.tv";
export const DEFAULT_PUBLIC_APP_URL = "https://replayr.tv";

export function publicAppUrl(): string {
  const fromEnv = import.meta.env.VITE_PUBLIC_APP_URL?.trim().replace(/\/$/, "");
  return fromEnv || DEFAULT_PUBLIC_APP_URL;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

export function publicApiUrl(): string {
  const url = publicAppUrl();
  try {
    const parsed = new URL(url);
    // The dev window is http://localhost:1420. Calling https://www.replayr.tv
    // from there is rejected (no CORS header) and shows up as "Failed to fetch".
    // Stay on this page and let Vite forward /v1 to the local worker.
    if (typeof window !== "undefined") {
      try {
        const page = new URL(window.location.origin);
        if (isLoopbackHost(page.hostname)) return page.origin;
      } catch {
        // Keep the configured worker origin.
      }
    }
    if (parsed.hostname === "replayr.tv") parsed.hostname = "www.replayr.tv";
    return parsed.origin;
  } catch {
    return DEFAULT_PUBLIC_APP_URL;
  }
}

export function publicShareUrl(): string {
  return DEFAULT_PUBLIC_APP_URL;
}

export function publicSiteUrl(): string {
  return "https://www.replayr.tv";
}

export function screenshotShareUrl(slug: string): string {
  return `${publicShareUrl()}/s/${slug}`;
}

export function screenshotImageUrl(slug: string): string {
  return `${publicShareUrl()}/s/${slug}.png`;
}

export function clipShareUrl(slug: string): string {
  return `${publicShareUrl()}/c/${slug}`;
}

export function folderShareUrl(token: string): string {
  return `${publicShareUrl()}/f/${token}`;
}

export function profileUrl(username: string): string {
  return `${publicShareUrl()}/u/${username}`;
}
