import { useEffect, useState } from "react";
import { fetchLibrary, fetchPlayback, fetchPublicClips, type PlaybackClip } from "./api";

export type ClipFeedSource = "library" | "foryou" | "single";

export type ClipFeedItem = {
  slug: string;
  clipId?: string;
};

export type LibraryFeedFilter = {
  visibility: "all" | "public" | "unlisted" | "private";
  query: string;
};

export type ClipFeedSession = {
  source: ClipFeedSource;
  items: ClipFeedItem[];
  startSlug: string;
  page: number;
  hasMore: boolean;
  loadingMore: boolean;
  libraryFilter?: LibraryFeedFilter;
};

const PAGE_SIZE = 24;
const listeners = new Set<() => void>();
const playbackCache = new Map<string, PlaybackClip>();

let session: ClipFeedSession | null = null;

function emit() {
  for (const listen of listeners) listen();
}

function snapshot(): ClipFeedSession | null {
  if (!session) return null;
  return {
    ...session,
    items: session.items.slice(),
    libraryFilter: session.libraryFilter ? { ...session.libraryFilter } : undefined,
  };
}

function dedupe(items: ClipFeedItem[]) {
  const seen = new Set<string>();
  const next: ClipFeedItem[] = [];
  for (const item of items) {
    const slug = item.slug.trim();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    next.push({ slug, clipId: item.clipId });
  }
  return next;
}

export function getClipFeed() {
  return snapshot();
}

export function seedClipFeed(next: Omit<ClipFeedSession, "loadingMore">) {
  session = {
    ...next,
    items: dedupe(next.items),
    loadingMore: false,
  };
  emit();
}

export function seedSingleClip(slug: string, clipId?: string) {
  const trimmed = slug.trim();
  if (!trimmed) return;
  seedClipFeed({
    source: "single",
    items: [{ slug: trimmed, clipId }],
    startSlug: trimmed,
    page: 1,
    hasMore: false,
  });
}

export function ensureClipFeed(slug: string, clipId?: string) {
  const current = session;
  if (current?.items.some((item) => item.slug === slug)) return;
  seedSingleClip(slug, clipId);
}

export function clearClipFeed() {
  session = null;
  playbackCache.clear();
  emit();
}

export function removeClipFromFeed(slug: string) {
  if (!session) return;
  session = {
    ...session,
    items: session.items.filter((item) => item.slug !== slug),
  };
  playbackCache.delete(slug);
  emit();
}

export function useClipFeed() {
  const [feed, setFeed] = useState<ClipFeedSession | null>(() => snapshot());
  useEffect(() => {
    const listen = () => setFeed(snapshot());
    listeners.add(listen);
    listen();
    return () => {
      listeners.delete(listen);
    };
  }, []);
  return feed;
}

export async function loadPlayback(slug: string, token?: string | null): Promise<PlaybackClip> {
  const cached = playbackCache.get(slug);
  if (cached) return cached;
  const clip = await fetchPlayback(slug, token);
  playbackCache.set(slug, clip);
  return clip;
}

export function prefetchPlayback(slug: string, token?: string | null) {
  if (!slug || playbackCache.has(slug)) return;
  void loadPlayback(slug, token).catch(() => undefined);
}

export function retainPlayback(slugs: string[]) {
  const keep = new Set(slugs);
  for (const slug of playbackCache.keys()) {
    if (!keep.has(slug)) playbackCache.delete(slug);
  }
}

export async function loadMoreClipFeed(token?: string | null) {
  const current = session;
  if (!current || current.loadingMore || !current.hasMore || current.source === "single") return;
  session = { ...current, loadingMore: true };
  emit();
  try {
    if (current.source === "library") {
      if (!token) {
        session = { ...current, loadingMore: false, hasMore: false };
        emit();
        return;
      }
      const nextPage = current.page + 1;
      const page = await fetchLibrary(token, { page: nextPage, limit: PAGE_SIZE });
      const filter = current.libraryFilter;
      const needle = filter?.query.trim().toLowerCase() ?? "";
      const added = page.clips
        .filter((clip) => {
          if (clip.status !== "ready") return false;
          if (filter && filter.visibility !== "all" && clip.visibility !== filter.visibility) return false;
          if (needle && !(clip.title || "").toLowerCase().includes(needle) && !clip.slug.includes(needle)) return false;
          return true;
        })
        .map((clip) => ({ slug: clip.slug, clipId: clip.id }));
      const items = dedupe([...current.items, ...added]);
      session = {
        ...current,
        items,
        page: nextPage,
        hasMore: page.clips.length > 0 && nextPage * page.limit < page.total,
        loadingMore: false,
      };
      emit();
      return;
    }

    const nextPage = current.page + 1;
    const clips = await fetchPublicClips(token, { page: nextPage, limit: PAGE_SIZE });
    const items = dedupe([...current.items, ...clips.map((clip) => ({ slug: clip.slug }))]);
    session = {
      ...current,
      items,
      page: nextPage,
      hasMore: clips.length >= PAGE_SIZE && items.length > current.items.length,
      loadingMore: false,
    };
    emit();
  } catch {
    if (session) {
      session = { ...session, loadingMore: false };
      emit();
    }
  }
}
