import { fetchClipPlayback } from "../services/social";
import { useAuthStore } from "../stores/authStore";
import { useCloudStore } from "../stores/cloudStore";
import { useLibraryStore } from "../stores/libraryStore";
import { useToastStore } from "../stores/toastStore";
import type { CloudClip } from "../types/clip";

const ALLOWED_HOSTS = new Set(["replayr.tv", "www.replayr.tv"]);

export type ReplayrClipRef = {
  id: string;
  slug: string;
  title?: string | null;
  durationMs?: number | null;
  thumbnailUrl?: string | null;
  visibility?: CloudClip["visibility"];
};

/**
 * Host-safe Replayr clip URL → slug. Rejects lookalike domains.
 * Allowed hosts: replayr.tv, www.replayr.tv. Paths: /c/:slug, /clips/:slug.
 */
export function parseReplayrClipSlug(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const host = parsed.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) return null;
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  if (parts[0] !== "c" && parts[0] !== "clips") return null;
  const slug = parts[1]?.trim();
  if (!slug || !/^[A-Za-z0-9_-]+$/.test(slug)) return null;
  return slug;
}

export function isReplayrClipUrl(raw: string): boolean {
  return parseReplayrClipSlug(raw) !== null;
}

function toCloudClip(clip: ReplayrClipRef, playbackUrl: string): CloudClip {
  return {
    id: clip.id,
    title: clip.title ?? null,
    slug: clip.slug,
    status: "ready",
    visibility: clip.visibility ?? "public",
    durationMs: clip.durationMs ?? null,
    width: null,
    height: null,
    fileSizeBytes: null,
    createdAt: new Date().toISOString(),
    thumbnailUrl: clip.thumbnailUrl ?? null,
    playbackUrl,
  };
}

/**
 * Open a Replayr-owned clip inside the desktop app.
 * Prefers local library file when linked; otherwise authorized cloud playback.
 * Never opens the system browser.
 */
export async function openReplayrClip(clip: ReplayrClipRef): Promise<void> {
  const slug = clip.slug?.trim();
  if (!slug) {
    useToastStore.getState().show("That clip is missing a share link.");
    return;
  }

  const local = useLibraryStore
    .getState()
    .clips.find((item) => item.cloudClipId && item.cloudClipId === clip.id && Boolean(item.filePath));
  if (local) {
    useLibraryStore.getState().play(local.localId);
    return;
  }

  const token = useAuthStore.getState().session?.access_token ?? null;
  try {
    const { playbackUrl } = await fetchClipPlayback(slug, token);
    await useCloudStore.getState().playRemote(toCloudClip(clip, playbackUrl), playbackUrl);
  } catch (caught) {
    useToastStore
      .getState()
      .show(caught instanceof Error ? caught.message : "Could not play that clip.");
  }
}

/** Resolve a validated Replayr clip URL and open it inside the app. */
export async function openReplayrClipUrl(raw: string): Promise<boolean> {
  const slug = parseReplayrClipSlug(raw);
  if (!slug) return false;
  await openReplayrClip({ id: slug, slug });
  return true;
}
