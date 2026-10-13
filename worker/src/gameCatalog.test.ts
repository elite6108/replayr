import { describe, expect, it } from "vitest";
import {
  cleanWindowTitle,
  isDeniedProcess,
  parseCatalogWrite,
  parseGameDraft,
  parseObservation,
  parseSteamSearch,
  shouldPromote,
  slugifyGameName,
  staffCoverUrl,
  steamDirectoryName,
  steamHeaderUrl,
} from "./gameCatalog";
import { permissionForAdminRoute } from "./staffPermissions";

const HASH = "a".repeat(64);

describe("game catalog", () => {
  it("keeps a known title and rejects launchers, browsers, and one sighting", () => {
    expect(cleanWindowTitle("  Hood   Warfare  ")).toBe("Hood Warfare");
    expect(cleanWindowTitle("ELDEN RING™")).toBe("ELDEN RING");
    expect(steamDirectoryName("Hades II")).toBe("Hades II");
    expect(steamDirectoryName("Hades II Soundtrack")).toBeNull();
    expect(steamDirectoryName("Lost Ark")).toBe("Lost Ark");
    expect(isDeniedProcess("C:\\Program Files\\Google\\Chrome.exe")).toBe(true);
    expect(isDeniedProcess("hoodwarfare.exe")).toBe(false);
    expect(shouldPromote({
      processName: "chrome.exe",
      distinctInstalls: 10,
      distinctNetworks: 10,
      winningTitle: "Google Chrome",
      winningVotes: 10,
      blocked: false,
    })).toBe(false);
    expect(shouldPromote({
      processName: "hoodwarfare.exe",
      distinctInstalls: 1,
      distinctNetworks: 1,
      winningTitle: "Hood Warfare",
      winningVotes: 1,
      blocked: false,
    })).toBe(false);
    expect(shouldPromote({
      processName: "hoodwarfare.exe",
      distinctInstalls: 3,
      distinctNetworks: 3,
      winningTitle: "Hood Warfare",
      winningVotes: 2,
      blocked: false,
    })).toBe(false);
    expect(shouldPromote({
      processName: "hoodwarfare.exe",
      distinctInstalls: 3,
      distinctNetworks: 1,
      winningTitle: "Hood Warfare",
      winningVotes: 3,
      blocked: false,
    })).toBe(false);
    expect(shouldPromote({
      processName: "hoodwarfare.exe",
      distinctInstalls: 3,
      distinctNetworks: 3,
      winningTitle: "Hood Warfare",
      winningVotes: 3,
      blocked: true,
    })).toBe(false);
    expect(shouldPromote({
      processName: "hoodwarfare.exe",
      distinctInstalls: 4,
      distinctNetworks: 3,
      winningTitle: "Hood Warfare",
      winningVotes: 3,
      blocked: false,
    })).toBe(true);
  });

  it("accepts an anonymous play report and ignores account fields", () => {
    const parsed = parseObservation({
      processName: "HoodWarfare.exe",
      windowTitle: "Hood Warfare",
      installHash: HASH,
      userId: "should-not-matter",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual({
      processName: "hoodwarfare.exe",
      windowTitle: "Hood Warfare",
      installHash: HASH,
    });
    expect(parseObservation({ processName: "hoodwarfare.exe", windowTitle: "HoodWarfare", installHash: HASH }).ok).toBe(false);
  });

  it("requires a real executable and an https cover before a game can be saved", () => {
    expect(parseCatalogWrite({ name: "Hood Warfare", processNames: ["chrome.exe"] })).toMatchObject({ ok: false });
    expect(parseCatalogWrite({ name: "Hood Warfare", processNames: ["hoodwarfare.exe"], coverUrl: "http://cdn.cloudflare.steamstatic.com/x.jpg" })).toMatchObject({ ok: false });
    expect(staffCoverUrl("https://127.0.0.1/cover.jpg").ok).toBe(false);
    const saved = parseCatalogWrite({
      name: "Hood Warfare",
      publisher: "Example",
      processNames: "hoodwarfare.exe",
      coverUrl: "https://cdn.cloudflare.steamstatic.com/steam/apps/1/header.jpg",
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.value.slug).toBe("hood-warfare");
    expect(saved.value.processNames).toEqual(["hoodwarfare.exe"]);
  });

  it("drops unsafe executables and cover hosts from an AI draft", () => {
    const draft = parseGameDraft({
      name: "Hood Warfare",
      publisher: "Example",
      processNames: ["hoodwarfare.exe", "chrome.exe", "steam.exe"],
      coverUrl: "https://evil.example/cover.jpg",
    }, 4242);
    expect(draft).toMatchObject({
      name: "Hood Warfare",
      processNames: ["hoodwarfare.exe"],
      coverUrl: steamHeaderUrl(4242),
    });
    expect(slugifyGameName("Hood Warfare")).toBe("hood-warfare");
  });

  it("reads Steam search hits without treating them as detection games", () => {
    const hits = parseSteamSearch({
      items: [
        { id: 10, name: "Counter-Strike", tiny_image: "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/10/capsule.jpg" },
        { id: 0, name: "Missing" },
      ],
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.name).toBe("Counter-Strike");
    expect(hits[0]?.coverUrl).toContain("steamstatic.com");
  });

  it("requires the games permission for catalog routes", () => {
    expect(permissionForAdminRoute("GET", "/v1/admin/games")).toBe("games.manage");
    expect(permissionForAdminRoute("POST", "/v1/admin/games/draft")).toBe("games.manage");
    expect(permissionForAdminRoute("POST", "/v1/admin/games/observations/hoodwarfare.exe/block")).toBe("games.manage");
    expect(permissionForAdminRoute("PATCH", "/v1/admin/games/hood-warfare")).toBe("games.manage");
  });
});
