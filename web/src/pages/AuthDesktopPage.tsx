import { Seo } from "../components/Seo";

export function AuthDesktopPage() {
  const params = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const code = params.get("code") || hash.get("code");
  const error = params.get("error_description") || params.get("error") || hash.get("error_description");

  function openApp() {
    if (!code) return;
    window.location.href = `replayr://auth-callback?code=${encodeURIComponent(code)}`;
  }

  return (
    <main className="page narrow">
      <Seo title="Open Replayr" description="Finish signing in on the Windows app." robots="noindex" />
      <h1>Finish signing in</h1>
      {error ? <p className="error">{error}</p> : null}
      {code ? (
        <>
          <p className="muted">Replayr is ready on this PC. Open the app to finish — this page will not sign you in on the website.</p>
          <button className="btn primary" type="button" onClick={openApp}>
            Open Replayr
          </button>
        </>
      ) : (
        <p className="muted">No sign-in code was found. Start again from the Replayr app.</p>
      )}
    </main>
  );
}
