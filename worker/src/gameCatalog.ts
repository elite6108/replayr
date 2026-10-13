/** Distinct installs that must agree on a title before it becomes a global game. */
export const PROMOTION_MIN_INSTALLS = 3;

const PROCESS_PATTERN = /^[a-z0-9][a-z0-9._+-]{0,78}\.exe$/;

const DENIED_PROCESSES = new Set([
  "replay.exe",
  "replayr.exe",
  "explorer.exe",
  "searchhost.exe",
  "shellexperiencehost.exe",
  "applicationframehost.exe",
  "startmenuexperiencehost.exe",
  "textinputhost.exe",
  "systemsettings.exe",
  "lockapp.exe",
  "dwm.exe",
  "sihost.exe",
  "taskmgr.exe",
  "gamebar.exe",
  "gamebarftserver.exe",
  "chrome.exe",
  "msedge.exe",
  "firefox.exe",
  "brave.exe",
  "opera.exe",
  "discord.exe",
  "discordptb.exe",
  "discordcanary.exe",
  "spotify.exe",
  "steam.exe",
  "steamwebhelper.exe",
  "epicgameslauncher.exe",
  "epicwebhelper.exe",
  "battle.net.exe",
  "riotclientservices.exe",
  "riotclientux.exe",
  "riotclientuxrender.exe",
  "galaxyclient.exe",
  "upc.exe",
  "eadesktop.exe",
  "origin.exe",
]);

const GENERIC_TITLES = new Set([
  "program manager",
  "windows input experience",
  "windows shell experience",
  "settings",
  "task manager",
  "search",
  "start",
  "replayr",
  "discord",
  "spotify",
  "steam",
  "epic games launcher",
]);

const STEAM_COVER_HOSTS = new Set([
  "cdn.akamai.steamstatic.com",
  "shared.akamai.steamstatic.com",
  "cdn.cloudflare.steamstatic.com",
  "shared.cloudflare.steamstatic.com",
  "steamcdn-a.akamaihd.net",
  "shared.fastly.steamstatic.com",
]);

export type CatalogGame = {
  id: string;
  slug: string;
  name: string;
  publisher: string | null;
  coverUrl: string | null;
  processNames: string[];
  catalogSource: string;
};

export type CatalogWrite = {
  slug: string;
  name: string;
  publisher: string | null;
  coverUrl: string | null;
  processNames: string[];
};

export type GameDraft = {
  name: string;
  publisher: string | null;
  processNames: string[];
  coverUrl: string | null;
};

export type SteamHit = {
  appId: number;
  name: string;
  coverUrl: string | null;
};

export type ObservationReport = {
  processName: string;
  windowTitle: string;
  installHash: string;
};

export type ObservationInput = ObservationReport & {
  networkHash: string;
};

export type PromotionInput = {
  processName: string;
  distinctInstalls: number;
  distinctNetworks: number;
  winningTitle: string;
  winningVotes: number;
  blocked: boolean;
};

export function normalizeProcessName(value: string): string {
  const file = value.split(/[/\\]/).pop() ?? value;
  return file.trim().replace(/^"|"$/g, "").toLowerCase();
}

export function isDeniedProcess(processName: string): boolean {
  return DENIED_PROCESSES.has(normalizeProcessName(processName));
}

export function isReportableProcess(processName: string): boolean {
  return PROCESS_PATTERN.test(normalizeProcessName(processName));
}

export function cleanWindowTitle(value: string): string | null {
  if (/[\u0000-\u001f]/.test(value)) return null;
  const collapsed = value.replace(/\s+/g, " ").trim();
  const shortened = [...collapsed].slice(0, 80).join("").trim();
  if ([...shortened].length < 2) return null;
  const lower = shortened.toLowerCase();
  if (GENERIC_TITLES.has(lower) || lower.startsWith("http://") || lower.startsWith("https://")) return null;
  return shortened;
}

export function titleIsExecutable(title: string, processName: string): boolean {
  const cleaned = title.trim().toLowerCase();
  const process = normalizeProcessName(processName);
  if (cleaned === process) return true;
  const stem = process.endsWith(".exe") ? process.slice(0, -4) : process;
  return stem.length > 0 && cleaned === stem;
}

export function slugifyGameName(name: string): string {
  const slug = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug || "game";
}

export function steamHeaderUrl(appId: number): string | null {
  if (!Number.isInteger(appId) || appId < 1 || appId > 2_000_000_000) return null;
  return `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg`;
}

export function shouldPromote(input: PromotionInput): boolean {
  if (input.blocked || isDeniedProcess(input.processName) || !isReportableProcess(input.processName)) return false;
  const title = cleanWindowTitle(input.winningTitle);
  if (!title || titleIsExecutable(title, input.processName)) return false;
  return (
    input.distinctInstalls >= PROMOTION_MIN_INSTALLS &&
    input.distinctNetworks >= PROMOTION_MIN_INSTALLS &&
    input.winningVotes >= PROMOTION_MIN_INSTALLS
  );
}

export function parseObservation(body: unknown): { ok: true; value: ObservationReport } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Play report was not usable." };
  }
  const record = body as Record<string, unknown>;
  const processName = typeof record.processName === "string" ? normalizeProcessName(record.processName) : "";
  const windowTitle = typeof record.windowTitle === "string" ? cleanWindowTitle(record.windowTitle) : null;
  const installHash = typeof record.installHash === "string" ? record.installHash.trim().toLowerCase() : "";
  if (!isReportableProcess(processName)) return { ok: false, error: "Play report was not usable." };
  if (!windowTitle || titleIsExecutable(windowTitle, processName)) return { ok: false, error: "Play report was not usable." };
  if (!/^[a-f0-9]{64}$/.test(installHash)) return { ok: false, error: "Play report was not usable." };
  return { ok: true, value: { processName, windowTitle, installHash } };
}

export function parseCatalogWrite(body: unknown): { ok: true; value: CatalogWrite } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Game details were not usable." };
  }
  const record = body as Record<string, unknown>;
  const name = typeof record.name === "string" ? cleanWindowTitle(record.name) : null;
  if (!name) return { ok: false, error: "Enter the game's name." };
  const requestedSlug = typeof record.slug === "string" && record.slug.trim() ? record.slug : name;
  const slug = slugifyGameName(requestedSlug);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return { ok: false, error: "That slug is not usable." };
  const publisher = optionalText(record.publisher, 80);
  if (publisher instanceof Error) return { ok: false, error: publisher.message };
  let coverUrl: string | null = null;
  if (typeof record.coverUrl === "string" && record.coverUrl.trim()) {
    const cover = staffCoverUrl(record.coverUrl);
    if (!cover.ok) return cover;
    coverUrl = cover.value;
  }
  const processNames = parseProcessNames(record.processNames);
  if (!processNames.ok) return processNames;
  if (processNames.value.length === 0) return { ok: false, error: "Add the game's .exe before saving." };
  return { ok: true, value: { slug, name, publisher, coverUrl, processNames: processNames.value } };
}

export function parseGameDraft(value: unknown, steamAppId?: number): GameDraft | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const name = typeof record.name === "string" ? cleanWindowTitle(record.name) : null;
  if (!name) return null;
  const publisher = optionalText(record.publisher, 80);
  const modelCover = typeof record.coverUrl === "string" ? steamCoverUrl(record.coverUrl) : null;
  const steamCover = steamAppId == null ? null : steamHeaderUrl(steamAppId);
  return {
    name,
    publisher: publisher instanceof Error ? null : publisher,
    processNames: filterProcessNames(record.processNames).slice(0, 4),
    coverUrl: steamCover ?? modelCover,
  };
}

export function parseSteamSearch(payload: unknown): SteamHit[] {
  if (!payload || typeof payload !== "object") return [];
  const items = (payload as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  const hits: SteamHit[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const record = item as { id?: unknown; name?: unknown; tiny_image?: unknown };
    const appId = typeof record.id === "number" ? record.id : Number(record.id);
    const name = typeof record.name === "string" ? cleanWindowTitle(record.name) : null;
    if (!name || !steamHeaderUrl(appId)) continue;
    const cover = typeof record.tiny_image === "string" ? steamCoverUrl(record.tiny_image) : steamHeaderUrl(appId);
    hits.push({ appId, name, coverUrl: cover });
    if (hits.length >= 12) break;
  }
  return hits;
}

export function searchTerm(value: string): string | null {
  const term = value.replace(/[%*,().\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  return term.length >= 2 ? term : null;
}

export function mergeProcessNames(existing: string[], incoming: string[]): string[] {
  const names: string[] = [];
  for (const name of [...existing, ...incoming]) {
    const normalized = normalizeProcessName(name);
    if (!isReportableProcess(normalized) || isDeniedProcess(normalized)) continue;
    if (names.some((item) => normalizeProcessName(item) === normalized)) continue;
    names.push(normalized);
  }
  return names.slice(0, 8);
}

function filterProcessNames(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : [];
  const names: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const normalized = normalizeProcessName(item);
    if (!isReportableProcess(normalized) || isDeniedProcess(normalized) || names.includes(normalized)) continue;
    names.push(normalized);
  }
  return names;
}

function parseProcessNames(value: unknown): { ok: true; value: string[] } | { ok: false; error: string } {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\s,]+/)
      : [];
  const names: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !item.trim()) continue;
    const normalized = normalizeProcessName(item);
    if (!isReportableProcess(normalized)) return { ok: false, error: "Process names must look like Game.exe." };
    if (isDeniedProcess(normalized)) {
      return { ok: false, error: "Browsers, launchers, and Windows apps can't be used for detection." };
    }
    if (!names.includes(normalized)) names.push(normalized);
    if (names.length > 8) return { ok: false, error: "Use at most 8 process names." };
  }
  return { ok: true, value: names };
}

function optionalText(value: unknown, max: number): string | null | Error {
  if (value == null || value === "") return null;
  if (typeof value !== "string") return new Error("That text was not usable.");
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  if ([...cleaned].length > max || /[\u0000-\u001f]/.test(cleaned)) return new Error("That text was not usable.");
  return cleaned;
}

export function staffCoverUrl(value: string): { ok: true; value: string } | { ok: false; error: string } {
  const parsed = publicHttpsUrl(value);
  if (!parsed) return { ok: false, error: "Cover art must be an https link." };
  return { ok: true, value: parsed.toString() };
}

export function steamCoverUrl(value: string): string | null {
  const parsed = publicHttpsUrl(value);
  if (!parsed || !STEAM_COVER_HOSTS.has(parsed.hostname)) return null;
  return parsed.toString();
}

function publicHttpsUrl(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  if (url.toString().length > 300) return null;
  const host = url.hostname.toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return null;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(":")) return null;
  return url;
}

export type CatalogActor = { id: string; requestId: string | null };
