export const CONFIRMATION_THRESHOLD = 3;

export type GameStatus = "confirmed" | "pending";

export interface MatchGame {
  id: string;
  name: string;
  aliases: string[];
  steamAppId: string | null;
  status: GameStatus;
  processNames: string[];
}

export interface StoredMatch {
  gameId: string;
  exeName: string | null;
  launcherKind: string | null;
  launcherId: string | null;
  status: GameStatus;
  confirmationCount: number;
}

export interface CaptureHint {
  exe: string | null;
  launcherKind: string | null;
  launcherId: string | null;
  title: string | null;
}

const LAUNCHERS = new Set(["steam", "epic", "xbox"]);

export function normalizeExe(value: string | null | undefined): string | null {
  if (!value) return null;
  const name = value.trim().toLowerCase().replace(/^.*[\\/]/, "");
  if (!/^[a-z0-9][a-z0-9._+-]{0,78}\.exe$/.test(name)) return null;
  return name;
}

export function normalizeLauncherKind(value: string | null | undefined): string | null {
  const kind = value?.trim().toLowerCase() ?? "";
  return LAUNCHERS.has(kind) ? kind : null;
}

export function normalizeLauncherId(value: string | null | undefined): string | null {
  const id = value?.trim() ?? "";
  if (!/^[A-Za-z0-9:_-]{1,32}$/.test(id)) return null;
  return id;
}

/** Lowercase, drop trademarks and punctuation, collapse spaces. */
export function normalizeTitle(value: string | null | undefined): string | null {
  if (!value) return null;
  const cleaned = value
    .replace(/[™®©]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  if (cleaned.length < 2 || cleaned.length > 80) return null;
  return cleaned;
}

export function cleanSearchTerm(raw: string | null | undefined): string | null {
  const term = (raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 -]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 40);
  return term.length >= 2 ? term : null;
}

export function nextMatchStatus(distinctUsers: number): GameStatus {
  return distinctUsers >= CONFIRMATION_THRESHOLD ? "confirmed" : "pending";
}

function globMatch(pattern: string, text: string): boolean {
  const walk = (pat: string, value: string): boolean => {
    if (!pat.length) return !value.length;
    if (pat[0] === "*") return walk(pat.slice(1), value) || (value.length > 0 && walk(pat, value.slice(1)));
    if (!value.length || pat[0] !== value[0]) return false;
    return walk(pat.slice(1), value.slice(1));
  };
  return walk(pattern, text);
}

function exeListed(game: MatchGame, exe: string): boolean {
  return game.processNames.some((pattern) => globMatch(pattern.trim().toLowerCase(), exe));
}

function titleHit(game: MatchGame, title: string): boolean {
  const names = [game.name, ...game.aliases];
  return names.some((name) => normalizeTitle(name) === title);
}

/**
 * Launcher id, then a confirmed exe, then a confirmed name or alias.
 * A blocklisted exe never matches. Pending games are not guessed.
 */
export function resolveGame(
  hint: CaptureHint,
  games: MatchGame[],
  matches: StoredMatch[],
  blocked: ReadonlySet<string>,
): string | null {
  const exe = normalizeExe(hint.exe);
  const kind = normalizeLauncherKind(hint.launcherKind);
  const launcherId = normalizeLauncherId(hint.launcherId);
  const title = normalizeTitle(hint.title);
  if (exe && blocked.has(exe)) return null;

  if (kind && launcherId) {
    const fromMatch = matches
      .filter((row) => row.launcherKind === kind && row.launcherId === launcherId && row.status === "confirmed")
      .sort((a, b) => b.confirmationCount - a.confirmationCount)[0];
    if (fromMatch) return fromMatch.gameId;
    if (kind === "steam") {
      const fromCatalog = games.find((game) => game.status === "confirmed" && game.steamAppId === launcherId);
      if (fromCatalog) return fromCatalog.id;
    }
  }

  if (exe) {
    const fromMatch = matches
      .filter((row) => row.exeName === exe && row.status === "confirmed")
      .sort((a, b) => b.confirmationCount - a.confirmationCount)[0];
    if (fromMatch) return fromMatch.gameId;
    const fromCatalog = games.find((game) => game.status === "confirmed" && exeListed(game, exe));
    if (fromCatalog) return fromCatalog.id;
  }

  if (title) {
    const fromName = games.find((game) => game.status === "confirmed" && titleHit(game, title));
    if (fromName) return fromName.id;
  }

  return null;
}
