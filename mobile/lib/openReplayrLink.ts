/**
 * Central deep-link parser for Replayr mobile.
 * Canonical share URL: https://replayr.tv/c/<slug>
 * Also accepts /clip/<slug> and custom-scheme equivalents.
 */

const SLUG = /^[a-z0-9]{6,16}$/i;
const FOLDER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHARE_HOSTS = new Set(["replayr.tv", "www.replayr.tv"]);
const APP_SCHEMES = new Set(["tv.elite.replay", "replayr", "replay"]);

export type ReplayrDeepLink =
  | { kind: "clip"; slug: string; href: `/c/${string}` }
  | { kind: "folder"; folderId: string; href: string }
  | { kind: "ignored" };

export function isValidClipSlug(value: string | null | undefined): value is string {
  return Boolean(value && SLUG.test(value));
}

export function clipDeepLinkHref(slug: string): `/c/${string}` {
  return `/c/${slug}`;
}

/** HTTPS share URL used everywhere (iMessage, Discord, copy link). */
export function clipHttpsUrl(slug: string, origin = "https://replayr.tv"): string {
  return `${origin.replace(/\/$/, "")}/c/${slug}`;
}

/** Custom-scheme fallback when Universal Links stay in the browser. */
export function clipCustomSchemeUrl(slug: string): string {
  return `tv.elite.replay://c/${slug}`;
}

export function openReplayrLink(url: string | null | undefined): ReplayrDeepLink {
  if (!url?.trim()) return { kind: "ignored" };

  try {
    const parsed = new URL(url.trim());
    const host = parsed.hostname.toLowerCase();
    const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
    const path = parsed.pathname.replace(/\/+$/, "") || "/";

    if (scheme === "https" || scheme === "http") {
      if (!SHARE_HOSTS.has(host)) return { kind: "ignored" };
      return pathToLink(path);
    }

    if (APP_SCHEMES.has(scheme)) {
      // tv.elite.replay://c/slug  OR  tv.elite.replay:///c/slug
      const fromHost = parsed.hostname ? `/${parsed.hostname}${path === "/" ? "" : path}` : path;
      return pathToLink(fromHost.startsWith("/") ? fromHost : `/${fromHost}`);
    }
  } catch {
    const clipMatch = url.match(/(?:\/(?:c|clip)\/|:?\/\/(?:c|clip)\/)([a-z0-9]{6,16})/i);
    if (clipMatch?.[1] && isValidClipSlug(clipMatch[1])) {
      return { kind: "clip", slug: clipMatch[1], href: clipDeepLinkHref(clipMatch[1]) };
    }
    const folderMatch = url.match(/(?:\/folders\/|:?\/\/folders\/)([0-9a-f-]{36})/i);
    if (folderMatch?.[1] && FOLDER_ID.test(folderMatch[1])) {
      return { kind: "folder", folderId: folderMatch[1], href: `/folders/${folderMatch[1]}` };
    }
  }

  return { kind: "ignored" };
}

function pathToLink(pathname: string): ReplayrDeepLink {
  const clip = pathname.match(/^\/(?:c|clip)\/([a-z0-9]{6,16})$/i);
  if (clip?.[1] && isValidClipSlug(clip[1])) {
    return { kind: "clip", slug: clip[1], href: clipDeepLinkHref(clip[1]) };
  }
  const folder = pathname.match(/^\/folders\/([0-9a-f-]{36})$/i);
  if (folder?.[1] && FOLDER_ID.test(folder[1])) {
    return { kind: "folder", folderId: folder[1], href: `/folders/${folder[1]}` };
  }
  return { kind: "ignored" };
}
