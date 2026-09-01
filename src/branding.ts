export const APP_NAME = "Replayr";
export const APP_IDENTIFIER = "tv.elite.replay";
export const SUPPORT_EMAIL = "support@replayr.tv";
export const DEFAULT_PUBLIC_APP_URL = "https://replayr.tv";

export function publicAppUrl(): string {
  const fromEnv = import.meta.env.VITE_PUBLIC_APP_URL?.replace(/\/$/, "");
  return fromEnv || DEFAULT_PUBLIC_APP_URL;
}

export function publicApiUrl(): string {
  const url = publicAppUrl();
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "replayr.tv") {
      parsed.hostname = "www.replayr.tv";
      return parsed.origin;
    }
  } catch {
    /* keep configured origin */
  }
  return url;
}

export function publicShareUrl(): string {
  return DEFAULT_PUBLIC_APP_URL;
}

export function publicSiteUrl(): string {
  return "https://www.replayr.tv";
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
