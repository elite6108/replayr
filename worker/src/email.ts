import type { Env } from "./env";

const RESEND_EMAILS_URL = "https://api.resend.com/emails";
const DEFAULT_FROM = "Replayr <support@replayr.tv>";
const DEFAULT_REPLY_TO = "support@replayr.tv";

export type EmailDelivery = {
  sent: boolean;
  providerId?: string;
  warning?: string;
};

export type ReplayrEmail = {
  to: string;
  subject: string;
  html: string;
  text: string;
  idempotencyKey: string;
};

export type StaffInviteEmailInput = {
  recipientName?: string | null;
  inviterName: string;
  roles: string[];
  expiresAt: string;
  inviteUrl: string;
};

export type RoleChangedEmailInput = {
  recipientName: string;
  roles: string[];
  staffUrl: string;
};

export async function sendReplayrEmail(
  env: Env,
  email: ReplayrEmail,
  fetcher: typeof fetch = fetch,
): Promise<EmailDelivery> {
  if (!env.RESEND_API_KEY) {
    return { sent: false, warning: "Email delivery is not configured." };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetcher(RESEND_EMAILS_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        "content-type": "application/json",
        "idempotency-key": email.idempotencyKey.slice(0, 256),
      },
      body: JSON.stringify({
        from: env.RESEND_FROM_EMAIL || DEFAULT_FROM,
        reply_to: env.RESEND_REPLY_TO || DEFAULT_REPLY_TO,
        to: [email.to],
        subject: email.subject,
        html: email.html,
        text: email.text,
      }),
      signal: controller.signal,
    });

    const body = (await response.json().catch(() => ({}))) as {
      id?: string;
      message?: string;
      name?: string;
    };
    if (!response.ok || !body.id) {
      console.error("Resend email failed", {
        status: response.status,
        name: body.name,
        message: body.message,
      });
      return { sent: false, warning: "The change was saved, but its email could not be sent." };
    }
    return { sent: true, providerId: body.id };
  } catch (caught) {
    console.error("Resend email request failed", {
      message: caught instanceof Error ? caught.message : "Unknown error",
    });
    return { sent: false, warning: "The change was saved, but its email could not be sent." };
  } finally {
    clearTimeout(timeout);
  }
}

export function staffInviteEmail(input: StaffInviteEmailInput): Omit<ReplayrEmail, "to" | "idempotencyKey"> {
  const name = input.recipientName?.trim() || "there";
  const roleText = formatRoleList(input.roles);
  const expiration = formatDate(input.expiresAt);
  const safeName = escapeHtml(name);
  const safeInviter = escapeHtml(input.inviterName);
  const safeRoles = escapeHtml(roleText);
  const safeExpiration = escapeHtml(expiration);
  const safeUrl = escapeHtml(input.inviteUrl);

  return {
    subject: "You’re invited to Replayr Staff",
    text: [
      `Hi ${name},`,
      "",
      `${input.inviterName} invited you to Replayr Staff as ${roleText}.`,
      `This invitation expires ${expiration}.`,
      "",
      `Sign in or create your Replayr account with this email address: ${input.inviteUrl}`,
      "",
      "The invitation only activates after your email is verified and you sign in.",
    ].join("\n"),
    html: emailFrame(
      "You’re invited to Replayr Staff",
      `<p>Hi ${safeName},</p>
       <p><strong>${safeInviter}</strong> invited you to Replayr Staff as <strong>${safeRoles}</strong>.</p>
       <p>This invitation expires ${safeExpiration}.</p>
       ${emailButton("Open Replayr Staff", safeUrl)}
       <p class="muted">Sign in or create your Replayr account with this email address. The invitation only activates after your email is verified and you sign in.</p>`,
    ),
  };
}

export function roleChangedEmail(input: RoleChangedEmailInput): Omit<ReplayrEmail, "to" | "idempotencyKey"> {
  const roleText = formatRoleList(input.roles);
  const safeName = escapeHtml(input.recipientName);
  const safeRoles = escapeHtml(roleText);
  const safeUrl = escapeHtml(input.staffUrl);
  return {
    subject: "Your Replayr Staff roles changed",
    text: [
      `Hi ${input.recipientName},`,
      "",
      `Your Replayr Staff roles are now: ${roleText}.`,
      "Your effective permissions update the next time your session refreshes.",
      "",
      `Open Staff Tools: ${input.staffUrl}`,
    ].join("\n"),
    html: emailFrame(
      "Your Replayr Staff roles changed",
      `<p>Hi ${safeName},</p>
       <p>Your Replayr Staff roles are now <strong>${safeRoles}</strong>.</p>
       <p>Your effective permissions update the next time your session refreshes.</p>
       ${emailButton("Open Staff Tools", safeUrl)}`,
    ),
  };
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatRoleList(roles: string[]): string {
  if (!roles.length) return "Staff";
  if (roles.length === 1) return roles[0]!;
  if (roles.length === 2) return `${roles[0]} and ${roles[1]}`;
  return `${roles.slice(0, -1).join(", ")}, and ${roles.at(-1)}`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function emailButton(label: string, href: string): string {
  return `<p style="margin:28px 0"><a href="${href}" style="display:inline-block;background:#00d8f0;color:#041418;text-decoration:none;font-weight:700;padding:12px 18px;border-radius:999px">${escapeHtml(label)}</a></p>`;
}

function emailFrame(title: string, content: string): string {
  return `<!doctype html>
<html>
  <body style="margin:0;background:#090b10;color:#f4f7fb;font-family:Inter,Arial,sans-serif">
    <div style="max-width:560px;margin:0 auto;padding:40px 20px">
      <p style="color:#00d8f0;font-size:13px;font-weight:800;letter-spacing:1.2px;text-transform:uppercase">Replayr</p>
      <div style="background:#141820;border:1px solid #1e2530;border-radius:16px;padding:28px">
        <h1 style="font-size:24px;margin:0 0 18px">${escapeHtml(title)}</h1>
        <div style="font-size:16px;line-height:1.6">${content}</div>
      </div>
      <p style="color:#8b93a3;font-size:12px;line-height:1.5;margin-top:18px">This is an account message from Replayr. If you were not expecting it, contact support@replayr.tv.</p>
    </div>
  </body>
</html>`;
}
