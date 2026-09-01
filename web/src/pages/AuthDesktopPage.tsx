import { useEffect } from "react";
import { Seo } from "../components/Seo";

function desktopCallbackUrl(code: string): string {
  return `replayr://auth-callback?code=${encodeURIComponent(code)}`;
}

export function AuthDesktopPage() {
  const params = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const code = params.get("code") || hash.get("code");
  const error = params.get("error_description") || params.get("error") || hash.get("error_description");

  useEffect(() => {
    if (!code) return;
    window.location.href = desktopCallbackUrl(code);
  }, [code]);

  function openApp() {
    if (!code) return;
    window.location.href = desktopCallbackUrl(code);
  }

  return (
    <main className="page narrow">
      <Seo title="Open Replayr" description="Finish signing in on the Replayr app." robots="noindex" />
      <h1>Finish signing in</h1>
      {error ? <p className="error">{error}</p> : null}
      {code ? (
        <>
          <p className="muted">Replayr is opening so you can finish sign-in. If nothing happens, open the app from this page.</p>
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
