import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Env } from "./env";
import {
  comingSoonFallbackHtml,
  COMING_SOON_PUBLIC_PATHS,
  handlePublicTextFiles,
  handleWaitlistPages,
  isComingSoonPath,
  isOAuthHandoff,
  isPublicAppPath,
  isSiteGatedPath,
  isStaffUiAssetPath,
  isWaitlistAliasPath,
  looksLikeSpaShell,
} from "./site-access";

const comingSoonPage = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../web/public/coming-soon.html"),
  "utf8",
);
const comingSoonJs = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../web/public/coming-soon.js"),
  "utf8",
);

function expectWaitlistConversionCopy(html: string) {
  expect(html).toContain("Your best plays,");
  expect(html).toContain("already captured.");
  expect(html).toContain("Join the waitlist");
  expect(html).toContain("Join waitlist");
  expect(html).toContain("https://x.com/Replayr_TV");
  expect(html).toContain("Early emails get beta access when it opens.");
  expect(html).toContain("No spam. Just launch updates and early access.");
  expect(html).toContain("Windows first");
  expect(html).toContain("$6.99/mo");
  expect(html).toContain("Thanks — we'll email you when beta opens.");
  expect(html).toContain("/instant-replay.png");
  expect(html).toContain('id="waitlist"');
  expect(html).toContain('id="waitlist-cta"');
  expect(html).toContain('id="waitConfirm"');
  expect(html).toContain("Already have access?");
  expect(html).toContain('href="/terms"');
  expect(html).toContain('href="/privacy"');
  expect(html).not.toContain("4.99");
  expect(html).not.toContain("47.88");
}

describe("isSiteGatedPath", () => {
  it("keeps OAuth, sign-in, and legal paths open and gates staff and marketing", () => {
    expect(isSiteGatedPath("/auth/desktop")).toBe(false);
    expect(isSiteGatedPath("/auth/callback")).toBe(false);
    expect(isSiteGatedPath("/auth/reset")).toBe(false);
    expect(isSiteGatedPath("/")).toBe(true);
    expect(isSiteGatedPath("/pricing")).toBe(true);
    expect(isSiteGatedPath("/signin")).toBe(false);
    expect(isSiteGatedPath("/terms")).toBe(false);
    expect(isSiteGatedPath("/privacy")).toBe(false);
    expect(isSiteGatedPath("/auth/mobile")).toBe(false);
    expect(isSiteGatedPath("/staff")).toBe(true);
    expect(isSiteGatedPath("/staff/boards")).toBe(true);
    expect(isSiteGatedPath("/admin")).toBe(true);
    expect(isSiteGatedPath("/releases/Replayr.exe")).toBe(false);
    expect(isSiteGatedPath("/releases/latest.json")).toBe(false);
    expect(isSiteGatedPath("/robots.txt")).toBe(false);
    expect(isSiteGatedPath("/sitemap.xml")).toBe(false);
    expect(isSiteGatedPath("/foo.txt")).toBe(true);
    expect(isSiteGatedPath("/no-such.json")).toBe(true);
    expect(isSiteGatedPath("/assets/index-D5n4TYz1.js")).toBe(false);
    expect(isSiteGatedPath("/assets/AdminApp-BJuTdEvc.js")).toBe(true);
    expect(isSiteGatedPath("/assets/StaffApp-BUvTwDhc.js")).toBe(true);
  });

  it("keeps screenshot share links open", () => {
    expect(isSiteGatedPath("/s/abcdefghijk2")).toBe(false);
    expect(isSiteGatedPath("/s/abcdefghijk2.png")).toBe(false);
  });

  it("treats operator console chunks as gated and other hashed assets as public", () => {
    expect(isStaffUiAssetPath("/assets/AdminApp-BJuTdEvc.js")).toBe(true);
    expect(isStaffUiAssetPath("/assets/StaffApp-BUvTwDhc.js")).toBe(true);
    expect(isStaffUiAssetPath("/assets/index-D5n4TYz1.js")).toBe(false);
    expect(isPublicAppPath("/signin")).toBe(true);
    expect(isPublicAppPath("/terms")).toBe(true);
    expect(isPublicAppPath("/privacy")).toBe(true);
    expect(isPublicAppPath("/auth/reset")).toBe(true);
    expect(isPublicAppPath("/pricing")).toBe(false);
  });

  it("keeps coming-soon marketing assets on the public allowlist", () => {
    expect(isSiteGatedPath("/coming-soon.css")).toBe(false);
    expect(isSiteGatedPath("/marketing/record-preview.png")).toBe(false);
    expect(COMING_SOON_PUBLIC_PATHS.has("/coming-soon.css")).toBe(true);
    expect(COMING_SOON_PUBLIC_PATHS.has("/marketing/social-explore-or-following.png")).toBe(true);
    expect(COMING_SOON_PUBLIC_PATHS.has("/marketing/clip-editor.jpg")).toBe(true);
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

  it("ships screenshot narratives and FAQ on the full page", () => {
    expect(comingSoonPage).toContain("/coming-soon.css");
    expect(comingSoonPage).toContain("/marketing/record-preview.png");
    expect(comingSoonPage).toContain("/marketing/local-library.png");
    expect(comingSoonPage).toContain("/marketing/clip-editor.jpg");
    expect(comingSoonPage).toContain("/marketing/share-privacy.png");
    expect(comingSoonPage).toContain("/marketing/social-explore-or-following.png");
    expect(comingSoonPage).toContain("/marketing/overlay-pack-or-scene.png");
    expect(comingSoonPage).toContain("Capture instantly.");
    expect(comingSoonPage).toContain('id="faq"');
    expect(comingSoonPage).toContain("When beta opens.");
    expect(comingSoonPage).toContain('class="waitlist"');
    expect(comingSoonPage).toContain('id="waitlist-cta-form"');
    expect(comingSoonPage).toContain("/coming-soon.js");
    expect(comingSoonJs).toContain('querySelectorAll("form.waitlist")');
    expect(comingSoonJs).toContain("/v1/waitlist");
    expect(comingSoonJs).toContain("/v1/site-access");
  });
});

describe("public text files", () => {
  it("serves robots.txt and sitemap.xml without the SPA shell", async () => {
    const robots = handlePublicTextFiles(new Request("https://replayr.tv/robots.txt"));
    expect(robots?.status).toBe(200);
    expect(robots?.headers.get("content-type")).toMatch(/text\/plain/);
    const robotsBody = await robots!.text();
    expect(robotsBody).toContain("Allow: /signin");
    expect(robotsBody).toContain("Disallow: /admin");
    expect(looksLikeSpaShell(robotsBody)).toBe(false);

    const sitemap = handlePublicTextFiles(new Request("https://replayr.tv/sitemap.xml"));
    expect(sitemap?.status).toBe(200);
    expect(sitemap?.headers.get("content-type")).toMatch(/xml/);
    const mapBody = await sitemap!.text();
    expect(mapBody).toContain("https://www.replayr.tv/terms");
    expect(looksLikeSpaShell(mapBody)).toBe(false);

    const head = handlePublicTextFiles(new Request("https://replayr.tv/robots.txt", { method: "HEAD" }));
    expect(head?.status).toBe(200);
    expect(await head!.text()).toBe("");
  });

  it("does not treat the Vite shell as a real static file", () => {
    expect(looksLikeSpaShell('<div id="root"></div><script src="/assets/index-abc.js"></script>')).toBe(true);
    expect(looksLikeSpaShell("<!doctype html><title>Replayr — Beta waitlist</title>")).toBe(false);
  });
});

describe("isOAuthHandoff", () => {
  it("treats a homepage return with a code as an OAuth handoff", () => {
    expect(isOAuthHandoff(new URL("https://www.replayr.tv/?code=abc"))).toBe(true);
    expect(isOAuthHandoff(new URL("https://www.replayr.tv/"))).toBe(false);
  });
});
