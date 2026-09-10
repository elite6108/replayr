import { describe, expect, it } from "vitest";
import { androidAssetLinks, appleAppSiteAssociation } from "./appLinks";
import type { Env } from "./env";

function env(partial: Partial<Env> = {}): Env {
  return {
    SUPABASE_URL: "",
    SUPABASE_ANON_KEY: "",
    R2_ACCOUNT_ID: "",
    R2_ACCESS_KEY_ID: "",
    R2_SECRET_ACCESS_KEY: "",
    R2_BUCKET_NAME: "",
    PUBLIC_APP_URL: "https://replayr.tv",
    ...partial,
  };
}

describe("app link manifests", () => {
  it("returns 404 AASA without Apple Team ID", async () => {
    const response = appleAppSiteAssociation(env());
    expect(response.status).toBe(404);
  });

  it("serves AASA with team id and clip paths", async () => {
    const response = appleAppSiteAssociation(env({ APPLE_TEAM_ID: "TEAM123" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as {
      applinks: { details: { appIDs: string[]; components: { "/": string }[] }[] };
    };
    expect(body.applinks.details[0].appIDs[0]).toBe("TEAM123.tv.elite.replay");
    expect(body.applinks.details[0].components.some((c) => c["/"] === "/c/*")).toBe(true);
    expect(body.applinks.details[0].components.some((c) => c["/"] === "/clip/*")).toBe(true);
  });

  it("serves assetlinks when fingerprints are set", async () => {
    const response = androidAssetLinks(
      env({ ANDROID_SHA256_CERT_FINGERPRINTS: "AA:BB, CC:DD" }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      target: { package_name: string; sha256_cert_fingerprints: string[] };
    }[];
    expect(body[0].target.package_name).toBe("tv.elite.replay");
    expect(body[0].target.sha256_cert_fingerprints).toEqual(["AA:BB", "CC:DD"]);
  });
});
