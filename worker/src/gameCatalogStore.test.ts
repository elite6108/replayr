import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "./env";
import { matchSteamTitle, recordPlayObservation } from "./gameCatalogStore";

const env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role",
  SUPABASE_ANON_KEY: "anon",
} as Env;

const calls: Array<{ method: string; path: string; body: unknown }> = [];

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  calls.length = 0;
  vi.unstubAllGlobals();
});

describe("public game confirmation", () => {
  it("does not attach a new exe to a confirmed Steam game", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const path = url.pathname.replace("/rest/v1", "");
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ method: init?.method ?? "GET", path, body });
      if (path === "/rpc/match_steam_app") {
        return jsonResponse([{ app_id: 70, name: "Hades II", cover_url: null }]);
      }
      if (path === "/rpc/game_by_process") return jsonResponse([]);
      if (path.startsWith("/games") && (init?.method ?? "GET") === "GET") {
        return jsonResponse([
          {
            id: "game-1",
            slug: "hades-ii",
            name: "Hades II",
            publisher: null,
            cover_url: null,
            process_names: ["hades.exe"],
            catalog_source: "steam",
            status: "confirmed",
          },
        ]);
      }
      return jsonResponse([]);
    });

    const game = await matchSteamTitle(env, "Hades2.exe", "Hades II");
    expect(game?.name).toBe("Hades II");
    expect(game?.processNames).toEqual(["hades.exe"]);
    expect(calls.some((call) => call.method === "PATCH" || call.method === "POST" && call.path === "/games")).toBe(false);
  });

  it("does not insert or return a pending Steam game", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const path = url.pathname.replace("/rest/v1", "");
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ method: init?.method ?? "GET", path, body });
      if (path === "/rpc/match_steam_app") {
        return jsonResponse([{ app_id: 70, name: "Hades II", cover_url: null }]);
      }
      if (path === "/rpc/game_by_process") return jsonResponse([]);
      if (path.startsWith("/games") && (init?.method ?? "GET") === "GET") {
        return jsonResponse([
          {
            id: "game-2",
            slug: "hades-ii",
            name: "Hades II",
            publisher: null,
            cover_url: null,
            process_names: ["hades2.exe"],
            catalog_source: "steam",
            status: "pending",
          },
        ]);
      }
      return jsonResponse([]);
    });

    const game = await matchSteamTitle(env, "Hades2.exe", "Hades II");
    expect(game).toBeNull();
    expect(calls.some((call) => call.method === "POST" && call.path === "/games")).toBe(false);
  });

  it("stores a play report without promoting the process", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const path = url.pathname.replace("/rest/v1", "");
      calls.push({
        method: init?.method ?? "GET",
        path,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (path === "/rpc/record_game_observation") {
        return jsonResponse({
          stored: true,
          blocked: false,
          distinctInstalls: 8,
          distinctNetworks: 4,
          winningTitle: "Hades II",
          winningVotes: 8,
        });
      }
      return jsonResponse([]);
    });

    const result = await recordPlayObservation(env, {
      processName: "hades2.exe",
      windowTitle: "Hades II",
      installHash: "a".repeat(64),
      networkHash: "b".repeat(64),
    });
    expect(result).toEqual({ stored: true, promotedSlug: null });
    expect(calls.map((call) => call.path)).toEqual(["/rpc/record_game_observation"]);
  });
});
