# Replayr email delivery

Replayr uses Resend in two ways:

- Supabase Auth uses Resend SMTP for confirmation, recovery, magic-link, and Auth invitation mail.
- The Cloudflare Worker uses the Resend HTTPS API for staff invitations and role-change notices.

## 1. Verify the sender

In Resend, add `replayr.tv` and publish every DKIM/SPF record Resend supplies in Cloudflare DNS. Wait until the domain is marked **Verified**.

Sender:

```text
Replayr <support@replayr.tv>
```

Do not enable production delivery before the domain is verified.

## 2. Configure Supabase Auth SMTP

In Supabase Dashboard → Authentication → SMTP Settings:

```text
Host: smtp.resend.com
Port: 465 (or 587 with STARTTLS)
Username: resend
Password: <Resend API key>
Sender email: support@replayr.tv
Sender name: Replayr
```

In Authentication → URL Configuration:

```text
Site URL: https://www.replayr.tv
Allowed redirect: https://www.replayr.tv/auth/callback
Allowed redirect: tv.elite.replay://auth/callback
```

Brand the Confirm signup, Invite user, Magic Link, Change Email, and Reset Password templates. Keep Supabase's generated confirmation URL variable in the action link; do not construct verification tokens in application code.

Send a confirmation test from a non-team email address after saving SMTP. Supabase's built-in SMTP service is restricted and is not suitable for production.

## 3. Configure the Worker

For local development, add these to the root `.env` or the gitignored `worker/.dev.vars`:

```text
RESEND_API_KEY=<Resend API key>
RESEND_FROM_EMAIL=Replayr <support@replayr.tv>
RESEND_REPLY_TO=support@replayr.tv
```

For production:

```bash
cd worker
npx wrangler secret put RESEND_API_KEY
```

`RESEND_FROM_EMAIL` and `RESEND_REPLY_TO` are optional; the Worker defaults to the Replayr sender above. If they are set as production variables, never put the API key in `wrangler.toml`.

## 4. Acceptance checks

1. Create a Replayr account with email/password and confirm the email.
2. Invite a staff member and verify the email lists the assigned roles and 14-day expiration.
3. Sign up or sign in with the invited, verified email and open Staff Tools.
4. Change that member's assigned roles and verify the member receives the new role list.
5. Temporarily use an invalid local API key and verify RBAC changes persist while the operator sees an email warning.
6. Review both Supabase Auth logs and Resend delivery logs.
