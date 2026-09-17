import { describe, expect, it } from "vitest";
import { rankAfter, rankBetween } from "./lexorank";
import {
  canGrantPermissions,
  lastSuperAdminLockout,
  permissionForAdminRoute,
  roleIsSubset,
} from "./staffPermissions";

describe("lexorank", () => {
  it("orders values between neighbors without rewriting the column", () => {
    const a = rankAfter(null);
    const c = rankAfter(a);
    const b = rankBetween(a, c);
    expect(a < b && b < c).toBe(true);
    const d = rankBetween(c, null);
    expect(c < d).toBe(true);
  });
});

describe("privilege escalation", () => {
  const actor = new Set(["staff.access", "board.view", "board.cards.edit"]);

  it("blocks granting keys the actor does not have", () => {
    expect(canGrantPermissions(actor, ["clips.delete"], false)).toBe(
      "You cannot grant clips.delete because you do not have it.",
    );
  });

  it("blocks manage_all unless Super Admin", () => {
    expect(canGrantPermissions(actor, ["staff.roles.manage_all"], false)).toBe(
      "Only Super Admin can grant that permission.",
    );
    expect(canGrantPermissions(actor, ["staff.roles.manage_all"], true)).toBeNull();
  });

  it("allows a subset role assignment", () => {
    expect(roleIsSubset(new Set(["board.view"]), actor, false)).toBe(true);
    expect(roleIsSubset(new Set(["board.view", "clips.delete"]), actor, false)).toBe(false);
    expect(roleIsSubset(new Set(["clips.delete"]), actor, true)).toBe(true);
  });
});

describe("super admin lockout", () => {
  it("blocks removing the last Super Admin", () => {
    expect(lastSuperAdminLockout(1, true)).toBe("Cannot remove the last Super Admin.");
    expect(lastSuperAdminLockout(2, true)).toBeNull();
    expect(lastSuperAdminLockout(1, false)).toBeNull();
  });
});

describe("admin route permission map", () => {
  it("maps existing operator routes to catalog keys", () => {
    expect(permissionForAdminRoute("GET", "/v1/admin/users")).toBe("users.view");
    expect(permissionForAdminRoute("DELETE", "/v1/admin/clips/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")).toBe("clips.delete");
    expect(permissionForAdminRoute("GET", "/v1/admin/audit")).toBe("audit.view");
    expect(permissionForAdminRoute("GET", "/v1/admin/waitlist")).toBe("waitlist.view");
    expect(permissionForAdminRoute("POST", "/v1/admin/waitlist/campaigns")).toBe("waitlist.send");
    expect(permissionForAdminRoute("POST", "/v1/admin/waitlist/rewrite")).toBe("waitlist.send");
    expect(permissionForAdminRoute("POST", "/v1/admin/waitlist/templates")).toBe("waitlist.templates.manage");
  });
});
