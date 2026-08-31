import { describe, expect, it } from "vitest";
import {
  allowedInviteRoles,
  canChangeMemberRole,
  canInviteRole,
  canRemoveMember,
  generatePublicFolderToken,
  hashPublicFolderToken,
  mapFolderTransferError,
  OWNER_LEAVE_MESSAGE,
  permissionsFromRole,
  PUBLIC_FOLDER_TOKEN,
} from "./folders";

describe("permissionsFromRole", () => {
  it("gives the owner every permission", () => {
    const permissions = permissionsFromRole("owner", true);
    expect(permissions.view).toBe(true);
    expect(permissions.deleteFolder).toBe(true);
    expect(permissions.transferOwnership).toBe(true);
  });

  it("blocks managers, editors, viewers, and public visitors from transfer", () => {
    const permissions = permissionsFromRole("manager", true);
    expect(permissions.manageMembers).toBe(true);
    expect(permissions.managePublicShare).toBe(true);
    expect(permissions.deleteFolder).toBe(false);
    expect(permissions.transferOwnership).toBe(false);
    expect(permissionsFromRole("editor", true).transferOwnership).toBe(false);
    expect(permissionsFromRole("viewer", true).transferOwnership).toBe(false);
    expect(permissionsFromRole("public", true).transferOwnership).toBe(false);
  });

  it("blocks editors from member and folder management", () => {
    const permissions = permissionsFromRole("editor", true);
    expect(permissions.addClips).toBe(true);
    expect(permissions.removeClips).toBe(true);
    expect(permissions.manageMembers).toBe(false);
    expect(permissions.managePublicShare).toBe(false);
    expect(permissions.manageFolder).toBe(false);
  });

  it("respects allowDownloads for viewers and public links", () => {
    expect(permissionsFromRole("viewer", false).download).toBe(false);
    expect(permissionsFromRole("viewer", true).download).toBe(true);
    expect(permissionsFromRole("public", false).addClips).toBe(false);
    expect(permissionsFromRole("public", true).download).toBe(true);
  });

  it("denies everything when there is no role", () => {
    expect(permissionsFromRole(null, true).view).toBe(false);
  });
});

describe("folder collaboration roles", () => {
  it("lets the owner invite manager, editor, and viewer", () => {
    expect(allowedInviteRoles("owner")).toEqual(["manager", "editor", "viewer"]);
    expect(canInviteRole("owner", "manager")).toBe(true);
  });

  it("lets a manager invite editor and viewer only", () => {
    expect(canInviteRole("manager", "editor")).toBe(true);
    expect(canInviteRole("manager", "viewer")).toBe(true);
    expect(canInviteRole("manager", "manager")).toBe(false);
  });

  it("blocks editor and viewer from inviting", () => {
    expect(canInviteRole("editor", "viewer")).toBe(false);
    expect(canInviteRole("viewer", "viewer")).toBe(false);
  });

  it("lets a manager change editor to viewer but not another manager", () => {
    expect(canChangeMemberRole("manager", "editor", "viewer")).toBe(true);
    expect(canChangeMemberRole("manager", "manager", "editor")).toBe(false);
    expect(canChangeMemberRole("owner", "manager", "editor")).toBe(true);
  });

  it("lets the owner remove any member and a manager remove editor or viewer only", () => {
    expect(canRemoveMember("owner", "manager")).toBe(true);
    expect(canRemoveMember("manager", "editor")).toBe(true);
    expect(canRemoveMember("manager", "manager")).toBe(false);
    expect(canRemoveMember("editor", "viewer")).toBe(false);
  });
});

describe("folder ownership transfer", () => {
  it("lets only the owner transfer ownership", () => {
    expect(permissionsFromRole("owner", true).transferOwnership).toBe(true);
    expect(permissionsFromRole("manager", true).transferOwnership).toBe(false);
    expect(permissionsFromRole("editor", true).transferOwnership).toBe(false);
    expect(permissionsFromRole("viewer", true).transferOwnership).toBe(false);
    expect(permissionsFromRole("public", false).transferOwnership).toBe(false);
  });

  it("maps transfer RPC failures without leaking internals", () => {
    expect(mapFolderTransferError("FOLDER_TRANSFER_SELF")?.status).toBe(400);
    expect(mapFolderTransferError("FOLDER_TRANSFER_NOT_MEMBER")?.message).toBe(
      "That person is not an active member of this folder.",
    );
    expect(mapFolderTransferError("FOLDER_TRANSFER_FORBIDDEN")?.status).toBe(403);
    expect(mapFolderTransferError("FOLDER_TRANSFER_NOT_FOUND")?.status).toBe(404);
    expect(mapFolderTransferError("FOLDER_TRANSFER_INVALID_USER")?.status).toBe(404);
    expect(mapFolderTransferError("some other error")).toBeNull();
  });

  it("blocks the owner from leaving until they transfer or delete", () => {
    expect(OWNER_LEAVE_MESSAGE).toBe("You must transfer ownership or delete the folder before leaving.");
  });
});

describe("public folder tokens", () => {
  it("creates high-entropy URL-safe tokens", () => {
    const token = generatePublicFolderToken();
    expect(PUBLIC_FOLDER_TOKEN.test(token)).toBe(true);
    expect(token).not.toMatch(/[+/=]/);
    expect(new Set(Array.from({ length: 8 }, () => generatePublicFolderToken())).size).toBe(8);
  });

  it("hashes tokens so the raw secret is not the lookup key", async () => {
    const token = generatePublicFolderToken();
    const hash = await hashPublicFolderToken(token);
    expect(hash).toHaveLength(64);
    expect(hash).toBe(await hashPublicFolderToken(token));
    expect(hash).not.toBe(await hashPublicFolderToken(generatePublicFolderToken()));
  });

  it("keeps public visitors read-only and respects download policy", () => {
    const denied = permissionsFromRole("public", false);
    expect(denied.view).toBe(true);
    expect(denied.download).toBe(false);
    expect(denied.addClips).toBe(false);
    expect(denied.managePublicShare).toBe(false);
    expect(permissionsFromRole("editor", true).managePublicShare).toBe(false);
    expect(permissionsFromRole("viewer", true).managePublicShare).toBe(false);
    expect(permissionsFromRole("owner", true).managePublicShare).toBe(true);
    expect(permissionsFromRole("manager", true).managePublicShare).toBe(true);
  });
});
