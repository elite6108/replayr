import { describe, expect, it } from "vitest";
import { comingSoonContentSecurityPolicy, webContentSecurityPolicy } from "./contentSecurity";
import { comingSoonSecurityHeaders } from "./site-access";

function connectSrc(policy: string): string {
  const directive = policy.split(";").map((part) => part.trim()).find((part) => part.startsWith("connect-src "));
  return directive ?? "";
}

describe("site content security policy", () => {
  it("allows first-party analytics on the app and the beta page", () => {
    for (const policy of [webContentSecurityPolicy(), comingSoonContentSecurityPolicy()]) {
      const connect = connectSrc(policy);
      expect(connect).toContain("'self'");
      expect(connect).toContain("https://replayr.tv");
      expect(connect).toContain("https://www.replayr.tv");
    }
  });

  it("sends the beta-page policy on the coming-soon response", () => {
    const policy = comingSoonSecurityHeaders().get("Content-Security-Policy") ?? "";
    expect(policy).toBe(comingSoonContentSecurityPolicy());
    const connect = connectSrc(policy);
    expect(connect).toContain("'self'");
    expect(connect).toContain("https://replayr.tv");
    expect(connect).toContain("https://www.replayr.tv");
  });
});
