import type { CloudClip, LocalClip } from "../types/clip";
import type { GameCatalogEntry } from "../types/game";
import { parseClipDate } from "../utils/format";

export type LibraryView = "all" | "local" | "cloud" | "screenshots" | "favorites";
export type LibraryLayout = "grid" | "list";
export type LibrarySort = "newest" | "oldest";
export type DateFilter = "any" | "today" | "week" | "month";
export type DurationFilter = "any" | "short" | "mid" | "long";
export type DateBucket = "today" | "week" | "older";

export type LibraryRow =
  | { kind: "local"; id: string; at: string; clip: LocalClip }
  | { kind: "cloud"; id: string; at: string; clip: CloudClip };

export type LibraryInfoTarget = { kind: "local" | "cloud"; id: string };

export function gameOf(catalog: GameCatalogEntry[], gameId: string | null | undefined) {
  if (!gameId) return null;
  return catalog.find((game) => game.slug === gameId || game.cloudId === gameId) ?? null;
}

export function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function startOfWeek(date: Date) {
  const day = startOfDay(date);
  const weekday = day.getDay();
  const mondayOffset = weekday === 0 ? 6 : weekday - 1;
  day.setDate(day.getDate() - mondayOffset);
  return day;
}

export function dateBucket(value: string, now = new Date()): DateBucket {
  const date = parseClipDate(value);
  if (!date) return "older";
  const today = startOfDay(now).getTime();
  const stamp = startOfDay(date).getTime();
  if (stamp === today) return "today";
  if (stamp >= startOfWeek(now).getTime()) return "week";
  return "older";
}

export function passesDateFilter(value: string, filter: DateFilter, now = new Date()) {
  if (filter === "any") return true;
  const date = parseClipDate(value);
  if (!date) return false;
  const stamp = startOfDay(date).getTime();
  if (filter === "today") return stamp === startOfDay(now).getTime();
  if (filter === "week") return stamp >= startOfWeek(now).getTime();
  const month = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  return stamp >= month;
}

export function passesDuration(ms: number | null | undefined, filter: DurationFilter) {
  if (filter === "any") return true;
  if (ms == null || ms <= 0) return false;
  if (filter === "short") return ms <= 30_000;
  if (filter === "mid") return ms > 30_000 && ms <= 120_000;
  return ms > 120_000;
}

export function libraryRows(input: {
  view: LibraryView;
  clips: LocalClip[];
  cloudClips: CloudClip[];
}): LibraryRow[] {
  const local = input.clips.filter((clip) => clip.captureKind !== "screenshot");
  const linked = new Set(local.map((clip) => clip.cloudClipId).filter((id): id is string => Boolean(id)));
  const cloudOnly = input.cloudClips.filter((clip) => !linked.has(clip.id));
  if (input.view === "cloud") {
    return input.cloudClips.map((clip) => ({ kind: "cloud", id: clip.id, at: clip.createdAt, clip }));
  }
  if (input.view === "favorites") {
    return local
      .filter((clip) => clip.favorite)
      .map((clip) => ({ kind: "local", id: clip.localId, at: clip.createdAt, clip }));
  }
  const locals = local.map((clip) => ({ kind: "local" as const, id: clip.localId, at: clip.createdAt, clip }));
  if (input.view === "local") return locals;
  return [
    ...locals,
    ...cloudOnly.map((clip) => ({ kind: "cloud" as const, id: clip.id, at: clip.createdAt, clip })),
  ];
}

export function filterLibraryRows(
  rows: LibraryRow[],
  options: {
    query: string;
    gameId: string;
    date: DateFilter;
    duration: DurationFilter;
    catalog: GameCatalogEntry[];
  },
) {
  const needle = options.query.trim().toLowerCase();
  return rows.filter((row) => {
    if (!passesDateFilter(row.at, options.date)) return false;
    const duration = row.kind === "local" ? row.clip.durationMs : row.clip.durationMs;
    if (!passesDuration(duration, options.duration)) return false;
    const gameId = row.kind === "local" ? row.clip.gameId : null;
    const game = gameOf(options.catalog, gameId);
    if (options.gameId !== "all" && gameId !== options.gameId && game?.cloudId !== options.gameId && game?.slug !== options.gameId) {
      return false;
    }
    if (!needle) return true;
    const title = (row.clip.title || "untitled clip").toLowerCase();
    const gameName = (game?.name || "").toLowerCase();
    const tags = row.kind === "local" ? (row.clip.tags ?? []).join(" ").toLowerCase() : "";
    return title.includes(needle) || gameName.includes(needle) || tags.includes(needle);
  });
}

export function sortLibraryRows(rows: LibraryRow[], sort: LibrarySort) {
  const next = [...rows];
  next.sort((a, b) => {
    const left = parseClipDate(a.at)?.getTime() ?? 0;
    const right = parseClipDate(b.at)?.getTime() ?? 0;
    return sort === "newest" ? right - left : left - right;
  });
  return next;
}

const BUCKETS: { id: DateBucket; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "week", label: "Earlier this week" },
  { id: "older", label: "Older" },
];

export function groupLibraryRows(rows: LibraryRow[], sort: LibrarySort, now = new Date()) {
  const order = sort === "newest" ? BUCKETS : [...BUCKETS].reverse();
  return order
    .map((bucket) => ({
      ...bucket,
      rows: rows.filter((row) => dateBucket(row.at, now) === bucket.id),
    }))
    .filter((group) => group.rows.length > 0);
}

export function clipCountLabel(count: number) {
  return `${count} clip${count === 1 ? "" : "s"}`;
}
