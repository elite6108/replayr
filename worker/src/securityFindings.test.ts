import { describe, expect, it } from "vitest";
import { accountDeleteConfirmed } from "./billing";
import { inviteEmailIsConfirmed } from "./staffAuth";

describe("account delete confirm", () => {
  it("requires the DELETE confirm body", () => {
    expect(accountDeleteConfirmed({ confirm: "DELETE" })).toBe(true);
    expect(accountDeleteConfirmed({ confirm: "delete" })).toBe(false);
    expect(accountDeleteConfirmed({})).toBe(false);
    expect(accountDeleteConfirmed(null)).toBe(false);
  });
});

describe("staff invite email", () => {
  it("leaves the invite pending unless the confirmed email matches", () => {
    expect(
      inviteEmailIsConfirmed(
        { email: "staff@replayr.tv", email_confirmed_at: null, confirmed_at: null },
        "staff@replayr.tv",
      ),
    ).toBe(false);
    expect(
      inviteEmailIsConfirmed(
        { email: "other@replayr.tv", email_confirmed_at: "2026-11-05T00:00:00Z" },
        "staff@replayr.tv",
      ),
    ).toBe(false);
    expect(
      inviteEmailIsConfirmed(
        { email: "staff@replayr.tv", confirmed_at: "2026-11-05T00:00:00Z" },
        "staff@replayr.tv",
      ),
    ).toBe(true);
  });
});
