import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

function read(rel: string) {
  return readFileSync(join(root, rel), "utf8");
}

const advertisedSurfaces = [
  "web/src/pages/PricingPage.tsx",
  "web/src/pages/LegalPage.tsx",
  "web/src/pages/ExplorePage.tsx",
  "web/src/pages/ClipPage.tsx",
  "web/src/pages/AccountPage.tsx",
  "web/public/coming-soon.html",
  "src/pages/SettingsPage.tsx",
  "src/pages/ProfilePage.tsx",
  "src/pages/ExplorePage.tsx",
  "src/components/settings/CloudSettings.tsx",
  "mobile/app/(tabs)/index.tsx",
  "mobile/app/c/[slug].web.tsx",
  "mobile/app/settings.tsx",
  "mobile/components/player/ClipPlayerCell.tsx",
  "worker/src/site-access.ts",
] as const;

describe("premium pricing copy", () => {
  it("advertises $6.99 monthly and hides yearly / $47.88 / Save 20%", () => {
    for (const rel of advertisedSurfaces) {
      const text = read(rel);
      expect(text, rel).toContain("$6.99");
      expect(text, rel).not.toContain("4.99");
      expect(text, rel).not.toContain("47.88");
      expect(text, rel).not.toContain("Save 20%");
      expect(text, rel).not.toMatch(/\$47(?:\.88)?/);
    }
  });

  it("keeps the website pricing page monthly-only", () => {
    const page = read("web/src/pages/PricingPage.tsx");
    expect(page).toContain('startCheckout(session.access_token, "month")');
    expect(page).toContain("Premium is $6.99 a month");
    expect(page).toContain("per month");
    expect(page).not.toContain('"year"');
    expect(page).not.toMatch(/interval|yearly|billed annually/i);
  });

  it("keeps Terms on monthly Premium only", () => {
    const terms = read("web/src/pages/LegalPage.tsx");
    expect(terms).toContain("Replayr Premium is $6.99 per month");
    expect(terms).not.toMatch(/year|annually|47\.88|Save 20%/i);
  });
});
