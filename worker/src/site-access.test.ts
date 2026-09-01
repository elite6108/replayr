import { describe, expect, it } from "vitest";
import { isOAuthHandoff, isSiteGatedPath } from "./site-access";

describe("isSiteGatedPath", () => {
  it("keeps desktop OAuth return paths open", () => {
    expect(isSiteGatedPath("/auth/desktop")).toBe(false);
    expect(isSiteGatedPath("/auth/callback")).toBe(false);
  });

  it("still gates the marketing homepage", () => {
    expect(isSiteGatedPath("/")).toBe(true);
    expect(isSiteGatedPath("/signin")).toBe(true);
  });
});

describe("isOAuthHandoff", () => {
  it("treats a homepage return with a code as an OAuth handoff", () => {
    expect(isOAuthHandoff(new URL("https://www.replayr.tv/?code=abc"))).toBe(true);
    expect(isOAuthHandoff(new URL("https://www.replayr.tv/"))).toBe(false);
  });
});
