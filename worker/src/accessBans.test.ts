import { describe, expect, it } from "vitest";
import { bannedNetworkResponse, normalizeBanIp, requestClientIp } from "./accessBans";
import { permissionForAdminRoute } from "./staffPermissions";

describe("ban ip normalization", () => {
  it("keeps a public address and rejects loopback or unspecified", () => {
    expect(normalizeBanIp(" 203.0.113.9 ")).toBe("203.0.113.9");
    expect(normalizeBanIp("127.0.0.1")).toBeNull();
    expect(normalizeBanIp("0.0.0.0")).toBeNull();
    expect(normalizeBanIp("255.255.255.255")).toBeNull();
    expect(normalizeBanIp("01.2.3.4")).toBeNull();
    expect(normalizeBanIp("::1")).toBeNull();
    expect(normalizeBanIp("localhost")).toBeNull();
    expect(normalizeBanIp("203.0.113.9:443")).toBeNull();
    expect(normalizeBanIp("2001:db8::1")).toBe("2001:db8::1");
  });

  it("trusts only the Cloudflare client IP when that header is present", () => {
    const request = new Request("https://www.replayr.tv/", {
      headers: {
        "cf-connecting-ip": "203.0.113.9",
        "x-forwarded-for": "198.51.100.4",
      },
    });
    expect(requestClientIp(request)).toBe("203.0.113.9");
  });

  it("does not fall back to a forwarded header when Cloudflare sent an unusable address", () => {
    const request = new Request("https://www.replayr.tv/", {
      headers: {
        "cf-connecting-ip": "127.0.0.1",
        "x-forwarded-for": "203.0.113.10",
      },
    });
    expect(requestClientIp(request)).toBeNull();
  });

  it("uses the first forwarded hop only for local requests without Cloudflare", () => {
    const request = new Request("http://127.0.0.1:8787/", {
      headers: { "x-forwarded-for": "203.0.113.10, 10.0.0.1" },
    });
    expect(requestClientIp(request)).toBe("203.0.113.10");
  });

  it("returns a page for documents and json for the api", async () => {
    const page = new Request("https://www.replayr.tv/", { headers: { accept: "text/html" } });
    const html = bannedNetworkResponse(page, new URL(page.url));
    expect(html.status).toBe(403);
    expect(html.headers.get("content-type")).toContain("text/html");
    expect(await html.text()).not.toContain("reason");

    const api = new Request("https://www.replayr.tv/v1/me", { headers: { accept: "text/html" } });
    const body = bannedNetworkResponse(api, new URL(api.url));
    expect(body.headers.get("content-type")).toContain("application/json");
    expect(await body.json()).toEqual({
      error: "Replayr is not available from this network.",
      code: "ip_banned",
    });
  });
});

describe("ban admin routes", () => {
  it("requires the ban permission", () => {
    expect(permissionForAdminRoute("GET", "/v1/admin/bans")).toBe("users.ban");
    expect(permissionForAdminRoute("POST", "/v1/admin/bans")).toBe("users.ban");
    expect(permissionForAdminRoute("POST", "/v1/admin/bans/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/lift")).toBe("users.ban");
    expect(permissionForAdminRoute("POST", "/v1/admin/bans/account/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/restore")).toBe(
      "users.ban",
    );
  });
});
