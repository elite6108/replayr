import { afterEach, describe, expect, it, vi } from "vitest";
import { handleAdmin } from "./admin";
import { AUDIT_ACTIONS, auditActionLabel, sanitizeAuditMetadata, writeAuditLog } from "./audit";
import type { Env } from "./env";

function testEnv(): Env {
  return {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_ANON_KEY: "anon",
    SUPABASE_SERVICE_ROLE_KEY: "service",
    R2_ACCOUNT_ID: "r2",
    R2_ACCESS_KEY_ID: "key",
    R2_SECRET_ACCESS_KEY: "secret",
    R2_BUCKET_NAME: "clips",
    PUBLIC_APP_URL: "https://www.replayr.tv",
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("audit log", () => {
  it("strips tokens, keys, and public tokens from metadata", () => {
    expect(
      sanitizeAuditMetadata({
        from: "viewer",
        to: "editor",
        token: "secret",
        public_token: "abc",
        storage_key: "users/x/file.mp4",
        rate: 0.015,
      }),
    ).toEqual({ from: "viewer", to: "editor", rate: 0.015 });
  });

  it("keeps stable action names and human labels", () => {
    expect(AUDIT_ACTIONS.folderOwnershipTransferred).toBe("folder.ownership_transferred");
    expect(auditActionLabel("folder.ownership_transferred")).toBe("Folder ownership transferred");
    expect(auditActionLabel("admin.config_changed")).toBe("Admin config changed");
  });

  it("rejects non-admin audit reads", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("/auth/v1/user")) {
          return new Response(JSON.stringify({ id: "11111111-1111-4111-8111-111111111111", app_metadata: { role: "user" } }), { status: 200 });
        }
        return new Response("[]", { status: 200 });
      }),
    );
    await expect(
      handleAdmin(
        new Request("https://www.replayr.tv/v1/admin/audit", { headers: { authorization: "Bearer t" } }),
        testEnv(),
        new URL("https://www.replayr.tv/v1/admin/audit"),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("writes the authenticated actor, not a request-body actor", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    await writeAuditLog(testEnv(), {
      actorUserId: "11111111-1111-4111-8111-111111111111",
      actorType: "admin",
      action: AUDIT_ACTIONS.adminConfigChanged,
      metadata: { actorUserId: "forged-user", token: "hide-me" },
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      actor_user_id: string;
      metadata: Record<string, unknown>;
    };
    expect(body.actor_user_id).toBe("11111111-1111-4111-8111-111111111111");
    expect(body.metadata.token).toBeUndefined();
    expect(body.metadata.actorUserId).toBe("forged-user");
  });
});
