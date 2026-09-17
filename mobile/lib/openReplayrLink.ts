/**
 * Central deep-link parser for Replayr mobile.
 * Canonical share URL: https://replayr.tv/c/<slug>
 * Also accepts /clip/<slug>, /s/<slug>, and custom-scheme equivalents.
 */

const SLUG = /^[a-z0-9]{6,16}$/i;
const SCREENSHOT_SLUG = /^[a-km-z2-9]{12}$/;
const FOLDER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHARE_HOSTS = new Set(["replayr.tv", "www.replayr.tv"]);
const APP_SCHEMES = new Set(["tv.elite.replay", "replayr", "replay"]);

export type ReplayrDeepLink =
  | { kind: "clip"; slug: string; href: `/c/${string}` }
  | { kind: "screenshot"; slug: string; href: `/s/${string}` }
  | { kind: "folder"; folderId: string; href: string }
  | { kind: "staff-task"; taskId: string; href: string }
  | { kind: "staff-board"; boardId: string; href: string }
  | { kind: "ignored" };

export function isValidClipSlug(value: string | null | undefined): boolean {
  return Boolean(value && SLUG.test(value));
}

export function isValidScreenshotSlug(value: string | null | undefined): value is string {
  return Boolean(value && SCREENSHOT_SLUG.test(value));
}

export function clipDeepLinkHref(slug: string): `/c/${string}` {
  return `/c/${slug}`;
}

export function screenshotDeepLinkHref(slug: string): `/s/${string}` {
  return `/s/${slug}`;
}

/** HTTPS share URL used everywhere (iMessage, Discord, copy link). */
export function clipHttpsUrl(slug: string, origin = "https://replayr.tv"): string {
  return `${origin.replace(/\/$/, "")}/c/${slug}`;
}

/** Custom-scheme fallback when Universal Links stay in the browser. */
export function clipCustomSchemeUrl(slug: string): string {
  return `tv.elite.replay://c/${slug}`;
}

export function screenshotHttpsUrl(slug: string, origin = "https://replayr.tv"): string {
  return `${origin.replace(/\/$/, "")}/s/${slug}`;
}

export function screenshotCustomSchemeUrl(slug: string): string {
  return `tv.elite.replay://s/${slug}`;
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
    const shotMatch = url.match(/(?:\/s\/|:?\/\/s\/)([a-km-z2-9]{12})(?:\.png)?/i);
    if (shotMatch?.[1] && isValidScreenshotSlug(shotMatch[1].toLowerCase())) {
      const slug = shotMatch[1].toLowerCase();
      return { kind: "screenshot", slug, href: screenshotDeepLinkHref(slug) };
    }
    const folderMatch = url.match(/(?:\/folders\/|:?\/\/folders\/)([0-9a-f-]{36})/i);
    if (folderMatch?.[1] && FOLDER_ID.test(folderMatch[1])) {
      return { kind: "folder", folderId: folderMatch[1], href: `/folders/${folderMatch[1]}` };
    }
    const staffTaskMatch = url.match(/(?:\/staff\/tasks\/|:?\/\/staff\/tasks\/)([0-9a-f-]{36})/i);
    if (staffTaskMatch?.[1] && FOLDER_ID.test(staffTaskMatch[1])) {
      return { kind: "staff-task", taskId: staffTaskMatch[1], href: `/staff/tasks/${staffTaskMatch[1]}` };
    }
    const staffBoardMatch = url.match(/(?:\/staff\/boards?\/|:?\/\/staff\/boards?\/)([0-9a-f-]{36})/i);
    if (staffBoardMatch?.[1] && FOLDER_ID.test(staffBoardMatch[1])) {
      return { kind: "staff-board", boardId: staffBoardMatch[1], href: `/staff/boards/${staffBoardMatch[1]}` };
    }
  }

  return { kind: "ignored" };
}

function pathToLink(pathname: string): ReplayrDeepLink {
  const clip = pathname.match(/^\/(?:c|clip)\/([a-z0-9]{6,16})$/i);
  if (clip?.[1] && isValidClipSlug(clip[1])) {
    return { kind: "clip", slug: clip[1], href: clipDeepLinkHref(clip[1]) };
  }
  const shot = pathname.match(/^\/s\/([a-km-z2-9]{12})(?:\.png)?$/i);
  if (shot?.[1]) {
    const slug = shot[1].toLowerCase();
    if (isValidScreenshotSlug(slug)) {
      return { kind: "screenshot", slug, href: screenshotDeepLinkHref(slug) };
    }
  }
  const folder = pathname.match(/^\/folders\/([0-9a-f-]{36})$/i);
  if (folder?.[1] && FOLDER_ID.test(folder[1])) {
    return { kind: "folder", folderId: folder[1], href: `/folders/${folder[1]}` };
  }
  const staffTask = pathname.match(/^\/staff\/tasks\/([0-9a-f-]{36})$/i);
  if (staffTask?.[1] && FOLDER_ID.test(staffTask[1])) {
    return { kind: "staff-task", taskId: staffTask[1], href: `/staff/tasks/${staffTask[1]}` };
  }
  const staffBoard = pathname.match(/^\/staff\/boards?\/([0-9a-f-]{36})$/i);
  if (staffBoard?.[1] && FOLDER_ID.test(staffBoard[1])) {
    return { kind: "staff-board", boardId: staffBoard[1], href: `/staff/boards/${staffBoard[1]}` };
  }
  return { kind: "ignored" };
}
