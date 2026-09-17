import { describe, expect, it, vi, afterEach } from "vitest";
import type { Env } from "./env";
import {
  assigneeSetChanged,
  boardActivityIdempotencyKey,
  dueAtChanged,
  filterBoardEmailRecipients,
  notifyBoardActivityEmail,
  shouldNotifyBoardMove,
  type BoardEmailCandidate,
} from "./boardActivity";

const ACTOR = "00000000-0000-4000-8000-000000000001";
const MEMBER = "00000000-0000-4000-8000-000000000002";
const STRANGER = "00000000-0000-4000-8000-000000000003";
const OWNER = "00000000-0000-4000-8000-000000000004";
const BOARD = "00000000-0000-4000-8000-000000000111";
const TASK = "00000000-0000-4000-8000-000000000222";
const USER = "00000000-0000-4000-8000-000000000333";
const OWNER_USER = "00000000-0000-4000-8000-000000000666";

function candidate(overrides: Partial<BoardEmailCandidate> = {}): BoardEmailCandidate {
  return {
    staffId: MEMBER,
    userId: USER,
    status: "active",
    notifyBoardEmail: true,
    notifyOwnBoardEmail: false,
    muted: false,
    canAccess: true,
    ...overrides,
  };
}

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
    RESEND_API_KEY: "re_test",
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("board activity recipient filter", () => {
  it("skips the actor, muted boards, master-off, and people without access", () => {
    const kept = filterBoardEmailRecipients(
      [
        candidate(),
        candidate({ staffId: ACTOR, userId: "actor-user" }),
        candidate({ staffId: "muted", userId: "muted-user", muted: true }),
        candidate({ staffId: "off", userId: "off-user", notifyBoardEmail: false }),
        candidate({ staffId: STRANGER, userId: "stranger-user", canAccess: false }),
        candidate({ staffId: "inactive", userId: "inactive-user", status: "suspended" }),
      ],
      ACTOR,
    );
    expect(kept.map((row) => row.staffId)).toEqual([MEMBER]);
  });

  it("lets a board owner opt into mail for their own edits", () => {
    const kept = filterBoardEmailRecipients(
      [candidate({ staffId: ACTOR, userId: "actor-user", notifyOwnBoardEmail: true })],
      ACTOR,
      ACTOR,
    );
    expect(kept.map((row) => row.staffId)).toEqual([ACTOR]);
  });

  it("does not email a non-owner actor even if own-edit mail is on", () => {
    const kept = filterBoardEmailRecipients(
      [candidate({ staffId: MEMBER, notifyOwnBoardEmail: true })],
      MEMBER,
      ACTOR,
    );
    expect(kept).toEqual([]);
  });

  it("treats a private non-member as excluded even if global email is on", () => {
    const kept = filterBoardEmailRecipients(
      [candidate({ staffId: STRANGER, canAccess: false, notifyBoardEmail: true, muted: false })],
      ACTOR,
    );
    expect(kept).toEqual([]);
  });
});

describe("which mutations send board emails", () => {
  it("does not send for rank-only moves in the same column", () => {
    const column = "00000000-0000-4000-8000-000000000444";
    expect(shouldNotifyBoardMove(column, column)).toBe(false);
    expect(shouldNotifyBoardMove(column, "00000000-0000-4000-8000-000000000555")).toBe(true);
  });

  it("sends for due-date changes and not for title-only patches", () => {
    expect(dueAtChanged("2026-09-17T00:00:00.000Z", "2026-09-18T00:00:00.000Z")).toBe(true);
    expect(dueAtChanged("2026-09-17T00:00:00.000Z", "2026-09-17T00:00:00.000Z")).toBe(false);
    expect(dueAtChanged(null, "2026-09-17T00:00:00.000Z")).toBe(true);
  });

  it("skips assignee writes that do not change the set", () => {
    expect(assigneeSetChanged([MEMBER, ACTOR], [ACTOR, MEMBER])).toBe(false);
    expect(assigneeSetChanged([MEMBER], [MEMBER, ACTOR])).toBe(true);
  });
});

describe("notifyBoardActivityEmail", () => {
  it("emails members with access and skips the actor", async () => {
    const sent: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/staff_boards?")) {
          return Response.json([{ id: BOARD, name: "Ops", visibility: "private", created_by: OWNER }]);
        }
        if (url.includes("/staff_board_members?")) {
          return Response.json([
            {
              staff_id: ACTOR,
              staff_members: {
                id: ACTOR,
                user_id: "actor-user",
                status: "active",
                display_name: "Actor",
                notify_board_email: true,
              },
            },
            {
              staff_id: MEMBER,
              staff_members: {
                id: MEMBER,
                user_id: USER,
                status: "active",
                display_name: "Member",
                notify_board_email: true,
              },
            },
            {
              staff_id: STRANGER,
              staff_members: {
                id: STRANGER,
                user_id: "stranger-user",
                status: "active",
                display_name: "Stranger",
                notify_board_email: true,
              },
            },
          ]);
        }
        if (url.includes("/staff_members?id=eq.")) {
          return Response.json([
            {
              id: OWNER,
              user_id: OWNER_USER,
              status: "active",
              display_name: "Owner",
              notify_board_email: true,
            },
          ]);
        }
        if (url.includes("/staff_role_assignments?")) {
          return Response.json([]);
        }
        if (url.includes("/staff_board_email_prefs?")) {
          return Response.json([{ staff_id: STRANGER, email: false }]);
        }
        if (url.includes("/auth/v1/admin/users/")) {
          const id = url.split("/").pop();
          return Response.json({
            email: id === USER ? "member@example.com" : id === OWNER_USER ? "owner@example.com" : "other@example.com",
            email_confirmed_at: "2026-01-01T00:00:00.000Z",
          });
        }
        if (url.includes("api.resend.com")) {
          const body = JSON.parse(String(init?.body || "{}")) as { to?: string[] };
          sent.push(body.to?.[0] || "");
          return Response.json({ id: "email_1" });
        }
        return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
      }),
    );

    await notifyBoardActivityEmail(env(), {
      boardId: BOARD,
      taskId: TASK,
      actorStaffId: ACTOR,
      actorName: "Actor",
      kind: "added",
      summary: "Actor added a card.",
      taskTitle: "Ship it",
      boardName: "Ops",
    });

    expect(sent).toEqual(["member@example.com", "owner@example.com"]);
    expect(boardActivityIdempotencyKey("added", TASK, USER, 1_800_000)).toBe(
      `staff-board/added/${TASK}/${USER}/30`,
    );
  });

  it("emails the board owner even when they are not a member row", async () => {
    const sent: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/staff_boards?")) {
          return Response.json([{ id: BOARD, name: "Ops", visibility: "private", created_by: OWNER }]);
        }
        if (url.includes("/staff_board_members?")) {
          return Response.json([
            {
              staff_id: ACTOR,
              staff_members: {
                id: ACTOR,
                user_id: "actor-user",
                status: "active",
                display_name: "Actor",
                notify_board_email: true,
              },
            },
          ]);
        }
        if (url.includes("/staff_members?id=eq.")) {
          return Response.json([
            {
              id: OWNER,
              user_id: OWNER_USER,
              status: "active",
              display_name: "Owner",
              notify_board_email: true,
            },
          ]);
        }
        if (url.includes("/staff_role_assignments?") || url.includes("/staff_board_email_prefs?")) {
          return Response.json([]);
        }
        if (url.includes("/auth/v1/admin/users/")) {
          return Response.json({
            email: "owner@example.com",
            email_confirmed_at: "2026-01-01T00:00:00.000Z",
          });
        }
        if (url.includes("api.resend.com")) {
          const body = JSON.parse(String(init?.body || "{}")) as { to?: string[] };
          sent.push(body.to?.[0] || "");
          return Response.json({ id: "email_1" });
        }
        return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
      }),
    );

    await notifyBoardActivityEmail(env(), {
      boardId: BOARD,
      taskId: TASK,
      actorStaffId: ACTOR,
      actorName: "Actor",
      kind: "moved",
      summary: "Actor moved a card.",
      taskTitle: "Ship it",
      boardName: "Ops",
    });

    expect(sent).toEqual(["owner@example.com"]);
  });
});
