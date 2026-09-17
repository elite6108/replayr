import { describe, expect, it, vi } from "vitest";
import type { Env } from "./env";
import {
  escapeHtml,
  roleChangedEmail,
  sendReplayrEmail,
  staffInviteEmail,
} from "./email";

function env(overrides: Partial<Env> = {}): Env {
  return {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_ANON_KEY: "anon",
    R2_ACCOUNT_ID: "account",
    R2_ACCESS_KEY_ID: "access",
    R2_SECRET_ACCESS_KEY: "secret",
    R2_BUCKET_NAME: "clips",
    PUBLIC_APP_URL: "https://www.replayr.tv",
    ...overrides,
  };
}

describe("Replayr email templates", () => {
  it("escapes untrusted names and role labels", () => {
    const invite = staffInviteEmail({
      recipientName: "<script>alert(1)</script>",
      inviterName: "Admin & Owner",
      roles: ["Editor <root>"],
      expiresAt: "2026-09-30T00:00:00.000Z",
      inviteUrl: "https://www.replayr.tv/signin?next=%2Fstaff",
    });

    expect(invite.html).not.toContain("<script>");
    expect(invite.html).toContain("&lt;script&gt;");
    expect(invite.html).toContain("Admin &amp; Owner");
    expect(invite.html).toContain("Editor &lt;root&gt;");
    expect(invite.text).toContain("Editor <root>");
  });

  it("renders role-change content without executable markup", () => {
    const message = roleChangedEmail({
      recipientName: "A < B",
      roles: ["Support", "Board Editor"],
      staffUrl: "https://www.replayr.tv/staff",
    });
    expect(message.subject).toContain("roles changed");
    expect(message.html).toContain("Support and Board Editor");
    expect(message.html).toContain("A &lt; B");
  });

  it("escapes all HTML-significant characters", () => {
    expect(escapeHtml(`<a href="'">&`)).toBe("&lt;a href=&quot;&#039;&quot;&gt;&amp;");
  });
});

describe("Resend delivery", () => {
  const message = {
    to: "member@example.com",
    subject: "Test",
    html: "<p>Test</p>",
    text: "Test",
    idempotencyKey: "staff-invite/123",
  };

  it("returns a visible warning when the provider is not configured", async () => {
    await expect(sendReplayrEmail(env(), message)).resolves.toEqual({
      sent: false,
      warning: "Email delivery is not configured.",
    });
  });

  it("sends the expected Resend request with an idempotency key", async () => {
    let captured: Parameters<typeof fetch> | undefined;
    const fetcher = vi.fn(async (...args: Parameters<typeof fetch>) => {
      captured = args;
      return new Response(JSON.stringify({ id: "email_123" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const result = await sendReplayrEmail(
      env({ RESEND_API_KEY: "re_test", RESEND_FROM_EMAIL: "Replayr <support@replayr.tv>" }),
      message,
      fetcher as typeof fetch,
    );

    expect(result).toEqual({ sent: true, providerId: "email_123" });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(captured).toBeDefined();
    const [url, init] = captured!;
    expect(init).toBeDefined();
    const requestInit = init!;
    expect(url).toBe("https://api.resend.com/emails");
    expect(requestInit.headers).toMatchObject({
      authorization: "Bearer re_test",
      "idempotency-key": "staff-invite/123",
    });
    expect(JSON.parse(String(requestInit.body))).toMatchObject({
      from: "Replayr <support@replayr.tv>",
      reply_to: "support@replayr.tv",
      to: ["member@example.com"],
      subject: "Test",
    });
  });

  it("does not throw or claim success when Resend rejects delivery", async () => {
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({ name: "validation_error", message: "Bad sender" }), {
        status: 422,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      sendReplayrEmail(env({ RESEND_API_KEY: "re_test" }), message, fetcher as typeof fetch),
    ).resolves.toEqual({
      sent: false,
      warning: "The change was saved, but its email could not be sent.",
    });
  });
});
