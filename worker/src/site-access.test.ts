import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Env } from "./env";
import {
  comingSoonFallbackHtml,
  handleWaitlistPages,
  isComingSoonPath,
  isOAuthHandoff,
  isSiteGatedPath,
  isWaitlistAliasPath,
} from "./site-access";

const comingSoonPage = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../web/public/coming-soon.html"),
  "utf8",
);

function expectWaitlistConversionCopy(html: string) {
  expect(html).toContain("Join the beta waitlist");
  expect(html).toContain("Early emails get beta access when it opens.");
  expect(html).toContain("No spam. We'll only email you when beta opens.");
  expect(html).toContain("Free to start · Premium $6.99/mo");
  expect(html).toContain("$6.99/mo");
  expect(html).toContain("Thanks — we'll email you when beta opens.");
  expect(html).toContain("/instant-replay.png");
  expect(html).toContain("Already have access?");
  expect(html).not.toMatch(/\bWindows\b/);
  expect(html).not.toContain("4.99");
  expect(html).not.toContain("47.88");
}

describe("isSiteGatedPath", () => {
  it("keeps desktop OAuth return paths open", () => {
    expect(isSiteGatedPath("/auth/desktop")).toBe(false);
    expect(isSiteGatedPath("/auth/callback")).toBe(false);
  });

  it("keeps staff invitation entry routes open while gating marketing", () => {
    expect(isSiteGatedPath("/")).toBe(true);
    expect(isSiteGatedPath("/pricing")).toBe(true);
    expect(isSiteGatedPath("/signin")).toBe(false);
    expect(isSiteGatedPath("/staff")).toBe(false);
    expect(isSiteGatedPath("/staff/boards")).toBe(false);
  });

  it("keeps screenshot share links open", () => {
    expect(isSiteGatedPath("/s/abcdefghijk2")).toBe(false);
    expect(isSiteGatedPath("/s/abcdefghijk2.png")).toBe(false);
  });
});

describe("waitlist landing routes", () => {
  it("treats /waitlist aliases as paid-traffic redirects", () => {
    expect(isWaitlistAliasPath("/waitlist")).toBe(true);
    expect(isWaitlistAliasPath("/waitlist/")).toBe(true);
    expect(isWaitlistAliasPath("/v1/waitlist")).toBe(false);
    expect(isComingSoonPath("/coming-soon")).toBe(true);
    expect(isComingSoonPath("/coming-soon/")).toBe(true);
    expect(isComingSoonPath("/coming-soon.html")).toBe(true);
  });

  it("redirects /waitlist to /coming-soon and keeps ad query params", async () => {
    const response = await handleWaitlistPages(
      new Request("https://replayr.tv/waitlist?utm_source=reddit&utm_campaign=beta"),
      {} as Env,
    );
    expect(response?.status).toBe(301);
    expect(response?.headers.get("location")).toBe("/coming-soon?utm_source=reddit&utm_campaign=beta");
  });

  it("always serves the waitlist page at /coming-soon", async () => {
    const response = await handleWaitlistPages(new Request("https://replayr.tv/coming-soon"), {} as Env);
    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toMatch(/text\/html/);
    expectWaitlistConversionCopy(await response!.text());
  });

  it("does not intercept the homepage download landing", async () => {
    expect(await handleWaitlistPages(new Request("https://replayr.tv/"), {} as Env)).toBeNull();
  });
});

describe("coming-soon conversion copy", () => {
  it("keeps the public page and worker fallback aligned for ads", () => {
    expectWaitlistConversionCopy(comingSoonPage);
    expectWaitlistConversionCopy(comingSoonFallbackHtml());
    expect(comingSoonPage).toContain('id="unlockToggle"');
    expect(comingSoonPage).toContain("<footer>");
    expect(comingSoonPage.indexOf('id="waitlist"')).toBeLessThan(comingSoonPage.indexOf('id="unlockToggle"'));
  });
});

describe("isOAuthHandoff", () => {
  it("treats a homepage return with a code as an OAuth handoff", () => {
    expect(isOAuthHandoff(new URL("https://www.replayr.tv/?code=abc"))).toBe(true);
    expect(isOAuthHandoff(new URL("https://www.replayr.tv/"))).toBe(false);
  });
});
