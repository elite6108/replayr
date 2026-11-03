import { describe, expect, it } from "vitest";
import {
  CONFIRMATION_THRESHOLD,
  cleanSearchTerm,
  nextMatchStatus,
  resolveGame,
  type MatchGame,
  type StoredMatch,
} from "./gameMatch";

const gta: MatchGame = {
  id: "gta",
  name: "Grand Theft Auto V",
  aliases: ["GTA V", "GTAV"],
  steamAppId: "271590",
  status: "confirmed",
  processNames: ["GTA5.exe", "*GTAProcess.exe"],
};

const pending: MatchGame = {
  id: "pending-game",
  name: "Hood Warfare",
  aliases: [],
  steamAppId: null,
  status: "pending",
  processNames: ["HoodWarfare.exe"],
};

const blocked = new Set(["discord.exe", "chrome.exe"]);

function exeMatch(over: Partial<StoredMatch> = {}): StoredMatch {
  return {
    gameId: "gta",
    exeName: "gta5.exe",
    launcherKind: null,
    launcherId: null,
    status: "confirmed",
    confirmationCount: 3,
    ...over,
  };
}

describe("resolveGame", () => {
  it("returns null for a blocklisted exe", () => {
    expect(
      resolveGame({ exe: "Discord.exe", launcherKind: "steam", launcherId: "271590", title: "Grand Theft Auto V" }, [gta], [], blocked),
    ).toBeNull();
  });

  it("prefers an exact launcher id over a different exe match", () => {
    const other: StoredMatch = exeMatch({ gameId: "other", exeName: "launcher.exe" });
    expect(
      resolveGame(
        { exe: "launcher.exe", launcherKind: "steam", launcherId: "271590", title: null },
        [gta],
        [other],
        blocked,
      ),
    ).toBe("gta");
  });

  it("uses a confirmed exe match, including a catalog glob", () => {
    expect(resolveGame({ exe: "GTA5.exe", launcherKind: null, launcherId: null, title: null }, [gta], [], blocked)).toBe("gta");
    expect(
      resolveGame({ exe: "FiveM_b3095_GTAProcess.exe", launcherKind: null, launcherId: null, title: null }, [gta], [], blocked),
    ).toBe("gta");
  });

  it("matches a confirmed name or alias and ignores a pending game", () => {
    expect(
      resolveGame({ exe: null, launcherKind: null, launcherId: null, title: "GTA V" }, [gta, pending], [], blocked),
    ).toBe("gta");
    expect(
      resolveGame({ exe: "HoodWarfare.exe", launcherKind: null, launcherId: null, title: "Hood Warfare" }, [pending], [], blocked),
    ).toBeNull();
  });

  it("returns null when nothing matches", () => {
    expect(
      resolveGame({ exe: "unknown.exe", launcherKind: null, launcherId: null, title: "Not a game" }, [gta], [], blocked),
    ).toBeNull();
  });
});

describe("search text", () => {
  it("drops characters that could change a database filter", () => {
    expect(cleanSearchTerm(" GTA V,or=(*) ")).toBe("gta v or");
    expect(cleanSearchTerm("a")).toBeNull();
  });
});

describe("confirmation threshold", () => {
  it("stays pending until three different users agree", () => {
    expect(nextMatchStatus(1)).toBe("pending");
    expect(nextMatchStatus(2)).toBe("pending");
    expect(nextMatchStatus(CONFIRMATION_THRESHOLD)).toBe("confirmed");
    expect(nextMatchStatus(4)).toBe("confirmed");
  });
});
