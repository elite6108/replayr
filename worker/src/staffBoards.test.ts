import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "./env";
import { boardCapabilities, requireBoardAccess, type BoardAccess } from "./staffBoards";
import type { StaffActor } from "./staffAuth";

const BOARD_ID = "00000000-0000-4000-8000-000000000111";
const STAFF_ID = "00000000-0000-4000-8000-000000000222";
const OWNER_ID = "00000000-0000-4000-8000-000000000555";

function env(): Env {
  return {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_ANON_KEY: "anon",
    SUPABASE_SERVICE_ROLE_KEY: "service",
    R2_ACCOUNT_ID: "account",
    R2_ACCESS_KEY_ID: "access",
    R2_SECRET_ACCESS_KEY: "secret",
    R2_BUCKET_NAME: "clips",
    PUBLIC_APP_URL: "https://www.replayr.tv",
  };
}

function actor(overrides: Partial<StaffActor> = {}): StaffActor {
  return {
    userId: "00000000-0000-4000-8000-000000000333",
    staffId: STAFF_ID,
    displayName: "Admin",
    email: "admin@example.com",
    status: "active",
    jobTitle: null,
    department: null,
    permissions: new Set(["board.view", "board.edit", "board.delete", "board.members.manage"]),
    roles: [],
    isSuperAdmin: false,
    notifyBoardEmail: true,
    notifyOwnBoardEmail: false,
    serviceKey: "service",
    requestId: null,
    ...overrides,
  };
}

function mockBoardAccess(memberRole?: "admin" | "editor" | "viewer", ownerId = OWNER_ID) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/staff_boards?")) {
        return Response.json([
          {
            id: BOARD_ID,
            workspace_id: "00000000-0000-4000-8000-000000000444",
            name: "Private board",
            slug: "private-board",
            description: null,
            visibility: "staff",
            archived_at: null,
            created_by: ownerId,
            created_at: "2026-09-17T00:00:00.000Z",
            updated_at: "2026-09-17T00:00:00.000Z",
          },
        ]);
      }
      if (url.includes("/staff_board_members?")) {
        return Response.json(memberRole ? [{ staff_id: STAFF_ID, board_role: memberRole }] : []);
      }
      return new Response("Not found", { status: 404 });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("requireBoardAccess", () => {
  it("does not grant regular admins implicit access to staff-visible boards", async () => {
    mockBoardAccess();
    await expect(requireBoardAccess(env(), actor(), BOARD_ID)).rejects.toMatchObject({ status: 403 });
  });

  it("uses explicit viewer membership as read-only access", async () => {
    mockBoardAccess("viewer");
    await expect(requireBoardAccess(env(), actor(), BOARD_ID)).resolves.toMatchObject({
      boardRole: "viewer",
      canMutate: false,
      isOwner: false,
    });
  });

  it("allows explicit board admins to mutate", async () => {
    mockBoardAccess("admin");
    await expect(requireBoardAccess(env(), actor(), BOARD_ID)).resolves.toMatchObject({
      boardRole: "admin",
      canMutate: true,
      isOwner: false,
    });
  });

  it("identifies the immutable creator as board owner", async () => {
    mockBoardAccess("admin", STAFF_ID);
    await expect(requireBoardAccess(env(), actor(), BOARD_ID)).resolves.toMatchObject({ isOwner: true });
  });

  it("keeps Super Admin emergency access without membership", async () => {
    mockBoardAccess();
    await expect(
      requireBoardAccess(env(), actor({ isSuperAdmin: true, staffId: "00000000-0000-4000-8000-000000000999" }), BOARD_ID),
    ).resolves.toMatchObject({
      boardRole: "admin",
      canMutate: true,
      isOwner: false,
    });
  });
});

describe("boardCapabilities", () => {
  const access = (overrides: Partial<BoardAccess> = {}): BoardAccess => ({
    board: {
      id: BOARD_ID,
      workspace_id: "00000000-0000-4000-8000-000000000444",
      name: "Private board",
      slug: "private-board",
      description: null,
      visibility: "private",
      archived_at: null,
      created_by: OWNER_ID,
      created_at: "2026-09-17T00:00:00.000Z",
      updated_at: "2026-09-17T00:00:00.000Z",
    },
    boardRole: "viewer",
    canMutate: false,
    isOwner: false,
    ...overrides,
  });

  it("does not let a global admin manage a board unless they are its board admin", () => {
    expect(boardCapabilities(actor(), access())).toEqual({
      isOwner: false,
      canManageMembers: false,
      canDelete: false,
    });
  });

  it("lets board admins manage members without granting owner-only deletion", () => {
    expect(boardCapabilities(actor(), access({ boardRole: "admin", canMutate: true }))).toEqual({
      isOwner: false,
      canManageMembers: true,
      canDelete: false,
    });
  });

  it("lets the owner delete and Super Admin recover every board", () => {
    expect(boardCapabilities(actor(), access({ boardRole: "admin", canMutate: true, isOwner: true })).canDelete).toBe(true);
    expect(boardCapabilities(actor({ isSuperAdmin: true }), access())).toMatchObject({
      canManageMembers: true,
      canDelete: true,
    });
  });
});
