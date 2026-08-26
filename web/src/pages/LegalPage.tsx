import { Link } from "react-router-dom";
import { Seo } from "../components/Seo";
import { APP_NAME, SUPPORT_EMAIL } from "../lib/branding";

const UPDATED = "August 24, 2026";

export function LegalPage({ kind }: { kind: "privacy" | "terms" }) {
  const privacy = kind === "privacy";
  return (
    <main className="page legal">
      <Seo
        title={privacy ? `Privacy Policy — ${APP_NAME}` : `Terms of Service — ${APP_NAME}`}
        description={
          privacy
            ? `How ${APP_NAME} handles accounts, local capture, cloud clips, friends, and messages.`
            : `Terms for using the ${APP_NAME} Windows app, website, and companion apps.`
        }
      />
      <p className="eyebrow">Legal</p>
      <h1>{privacy ? "Privacy Policy" : "Terms of Service"}</h1>
      <p className="legal-updated">Last updated {UPDATED}</p>
      <p className="lede">
        {privacy
          ? `${APP_NAME} captures gameplay on your Windows PC. Cloud copies, friends, and messages exist only after you create an account and choose to use those features.`
          : `These terms govern the ${APP_NAME} Windows app, replayr.tv, and the companion apps that sign into the same account.`}
      </p>
      {privacy ? <PrivacyBody /> : <TermsBody />}
      <p className="legal-switch">
        {privacy ? (
          <>
            Also see the <Link to="/terms">Terms of Service</Link>.
          </>
        ) : (
          <>
            Also see the <Link to="/privacy">Privacy Policy</Link>.
          </>
        )}
      </p>
    </main>
  );
}

function PrivacyBody() {
  return (
    <div className="legal-doc">
      <h2>1. Who we are</h2>
      <p>
        Replayr (“we”, “us”) operates replayr.tv and the Replayr Windows, iOS, and Android apps. Contact{" "}
        <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> for privacy questions, access requests, or deletion
        help.
      </p>

      <h2>2. What this policy covers</h2>
      <p>
        It covers the website, the Windows clipper, and the phone apps that watch the same cloud library. Capture and
        Instant Replay run on your PC. We do not receive a clip unless you upload it.
      </p>

      <h2>3. Information we collect</h2>
      <h3>Account</h3>
      <p>
        Email and password, or an identifier from Google, Discord, or X if you sign in that way. You can add a username
        and display name. We store a plan and how much cloud storage you are using.
      </p>
      <h3>Clips you upload</h3>
      <p>
        The video file, optional audio in that file, duration, game title when we can match it, visibility (unlisted,
        private, or public), and a short share slug such as <code>/c/H7ks92L</code>. Local recordings that stay on your
        PC never leave the machine unless you upload or export them yourself.
      </p>
      <h3>Friends and messages</h3>
      <p>
        Friend requests, acceptances, and the text you send in messages. We store those so both people can see them
        across devices.
      </p>
      <h3>On your Windows PC only</h3>
      <p>
        Gameplay video, microphone, game audio, and desktop audio are captured locally when you turn those sources on.
        Settings, the local library, and the Instant Replay buffer live on disk on that PC. We do not stream that
        capture to our servers in the background.
      </p>
      <h3>Technical data</h3>
      <p>
        When you use the site or API we see ordinary request metadata (IP address, user agent, timestamps) in
        Cloudflare and host logs, used to run the service and debug failures. Replayr does not embed advertising or
        analytics SDKs.
      </p>

      <h2>4. How we use it</h2>
      <ul>
        <li>Sign you in and keep the same account on Windows, the web, and phones.</li>
        <li>Store and play cloud copies you upload, at the visibility you set.</li>
        <li>Show public clips on Explore and game pages; keep unlisted clips off those lists.</li>
        <li>Deliver friends and messages.</li>
        <li>Enforce storage limits, moderate abuse, and keep the service working.</li>
        <li>Email you about the account when needed (for example a confirmation link).</li>
      </ul>

      <h2>5. How sharing works</h2>
      <p>
        <strong>Private</strong> clips are only for you. <strong>Unlisted</strong> clips play for anyone with the exact
        link; they are not listed on public pages. <strong>Public</strong> clips can appear on the site. Friends and
        messages are visible to the people in that relationship, not to the public. Do not put secrets in an unlisted
        URL you paste elsewhere.
      </p>

      <h2>6. Who else sees data</h2>
      <ul>
        <li>
          <strong>Supabase</strong> — authentication and the database for profiles, clips metadata, friends, and
          messages.
        </li>
        <li>
          <strong>Cloudflare</strong> — the API worker, the website, and object storage for uploaded files.
        </li>
        <li>
          <strong>Google, Discord, or X</strong> — only if you choose that sign-in. They send us the account details
          their OAuth flow provides (typically email and a stable id).
        </li>
      </ul>
      <p>
        We do not sell personal information. We do not share it for cross-context advertising. We may disclose
        information if the law requires it or to protect Replayr, our users, or the public from serious harm.
      </p>

      <h2>7. Cookies and local storage</h2>
      <p>
        We use storage that keeps you signed in (session tokens). We do not use advertising cookies or a third-party
        tracking pixel. The Windows app stores settings and the local library on your PC.
      </p>

      <h2>8. Retention</h2>
      <p>
        Account data and cloud clips stay until you delete them or close the account. Local files on Windows stay until
        you delete them in the app or on disk. Host logs are kept only as long as we need them to operate and secure
        the service.
      </p>

      <h2>9. Your choices</h2>
      <ul>
        <li>Leave capture sources off (microphone, game audio, desktop audio) in the Windows app.</li>
        <li>Keep clips on the PC and never upload.</li>
        <li>Change a cloud clip’s visibility, or delete it.</li>
        <li>
          Delete the account from Account on the website or in the phone app. That removes the Replayr account and
          cloud copies. It does not erase MP4s that already sit on your PC.
        </li>
        <li>
          Email <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> to ask what we hold or to request deletion if
          you cannot use the in-app control.
        </li>
      </ul>

      <h2>10. Children</h2>
      <p>
        Replayr is not directed at children under 13, and we do not knowingly collect personal information from them.
        If you believe a child under 13 created an account, contact us and we will delete it.
      </p>

      <h2>11. International users</h2>
      <p>
        The service is hosted in the United States. If you use Replayr from elsewhere, you understand that account
        data and uploaded clips are processed in the U.S.
      </p>

      <h2>12. Changes</h2>
      <p>
        We will update this page when the product changes how data is handled. The date at the top is the latest
        version. Continued use after a change means you accept the updated policy.
      </p>
    </div>
  );
}

function TermsBody() {
  return (
    <div className="legal-doc">
      <h2>1. Agreement</h2>
      <p>
        By downloading Replayr, creating an account, or using replayr.tv, you agree to these Terms and the{" "}
        <Link to="/privacy">Privacy Policy</Link>. If you do not agree, do not use the service.
      </p>

      <h2>2. The service</h2>
      <p>
        Replayr is a Windows gameplay clipper with an optional cloud library, website, and companion apps. Instant
        Replay and recording happen on your PC. Cloud storage, sharing, friends, and messages need an account. Features
        can change as we ship.
      </p>

      <h2>3. Eligibility</h2>
      <p>
        You must be at least 13. If you are under 18, you may use Replayr only with a parent or guardian’s permission.
        You are responsible for the account and for what is captured or uploaded from it.
      </p>

      <h2>4. Accounts</h2>
      <p>
        Keep your password and sign-in methods to yourself. Usernames must not impersonate others or use hateful or
        illegal material. We may reclaim a username or suspend an account that breaks these terms. You can delete the
        account from the website or phone app; that removes cloud data, not files already on your PC.
      </p>

      <h2>5. License to use Replayr</h2>
      <p>
        We grant you a personal, non-exclusive, non-transferable license to install the Windows app and use the site
        and companion apps for lawful gameplay clipping and sharing. You may not reverse engineer, scrape at scale,
        resell, or wrap Replayr as someone else’s product.
      </p>

      <h2>6. Your content</h2>
      <p>
        You own the clips you capture. If you upload a clip, you grant Replayr a license to store, transcode if needed,
        and serve it according to the visibility you choose, including to people who open an unlisted link. You can
        delete a cloud copy; cached copies and shares already opened may persist briefly.
      </p>
      <p>
        You represent that you have the right to record and upload the content — including game footage, voice chat,
        and anyone whose voice or image is in the clip. Follow each game’s and platform’s rules as well as the law.
      </p>

      <h2>7. Acceptable use</h2>
      <p>Do not use Replayr to:</p>
      <ul>
        <li>Upload or share illegal content, including child sexual abuse material.</li>
        <li>Harass, dox, or threaten people, or post others’ private information.</li>
        <li>Infringe copyright, trademarks, or other rights.</li>
        <li>Malware, phishing, or attacks on our infrastructure or other users.</li>
        <li>Bypass plan limits, scrape the service, or impersonate Replayr.</li>
      </ul>
      <p>We may remove content or close accounts that violate this section.</p>

      <h2>8. Cloud storage and plans</h2>
      <p>
        Free accounts include 5 GB of cloud storage, 20-minute 1080p uploads, a Replayr.tv watermark on shared
        and uploaded copies, and house upgrade ads on the website and mobile app. Replayr Premium is $4.99 per month or
        $47.88 per year, with a 7-day trial that requires a card. Premium includes 100 GB, original-quality uploads,
        no watermark, and no ads. You can cancel in the Stripe Customer Portal; access continues until the end of the
        paid period. Local files on this PC are not billed against cloud quota. We may change limits with notice on
        the site.
      </p>

      <h2>9. Disclaimers</h2>
      <p>
        Replayr is provided “as is.” Capture depends on your hardware, Windows, the game, and drivers. We do not
        warrant uninterrupted recording, perfect audio, or that a clip will always encode. Use Instant Replay and
        backups knowing a crash can lose unsaved buffer.
      </p>

      <h2>10. Limitation of liability</h2>
      <p>
        To the fullest extent the law allows, Replayr is not liable for lost clips, lost profits, or indirect damages
        arising from the service. Our total liability for a claim relating to Replayr is limited to the greater of
        fifty U.S. dollars (US $50) or the amount you paid us in the three months before the claim. Some places do not
        allow these limits; there they apply only as far as permitted.
      </p>

      <h2>11. Termination</h2>
      <p>
        You may stop using Replayr at any time. We may suspend or end access if you break these terms or if we shut
        the service down. After termination, cloud copies may be deleted; keep local exports of anything you need.
      </p>

      <h2>12. Changes</h2>
      <p>
        We may update these terms. The date at the top will change. If you keep using Replayr after an update, the new
        terms apply. Material changes may also be noted in the app or on the site.
      </p>

      <h2>13. Contact</h2>
      <p>
        Questions: <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
      </p>
    </div>
  );
}
