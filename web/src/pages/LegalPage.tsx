import { Seo } from "../components/Seo";
import { APP_NAME, SUPPORT_EMAIL } from "../lib/branding";

export function LegalPage({ kind }: { kind: "privacy" | "terms" }) {
  const privacy = kind === "privacy";
  return (
    <main className="page marketing">
      <Seo
        title={privacy ? `Privacy — ${APP_NAME}` : `Terms — ${APP_NAME}`}
        description={
          privacy
            ? `How ${APP_NAME} treats account data, local files, and cloud copies.`
            : `Placeholder terms for the ${APP_NAME} website and Windows app.`
        }
      />
      <p className="eyebrow">Legal</p>
      <h1>{privacy ? "Privacy" : "Terms"}</h1>
      {privacy ? (
        <>
          <p className="lede">
            Capture stays on your Windows PC. Cloud copies you upload are stored as objects; clip metadata lives in our
            database. Unlisted clips are not listed publicly. This page is a stub until counsel reviews a full policy.
          </p>
          <p className="muted">Contact {SUPPORT_EMAIL} for data questions.</p>
        </>
      ) : (
        <>
          <p className="lede">
            {APP_NAME} is a Windows clipper plus this website for watching shares and managing cloud copies. These
            terms are a placeholder and are not a contract yet.
          </p>
          <p className="muted">Contact {SUPPORT_EMAIL}.</p>
        </>
      )}
    </main>
  );
}
