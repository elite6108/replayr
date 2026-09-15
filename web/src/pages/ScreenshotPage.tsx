import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Seo } from "../components/Seo";
import { fetchPublicScreenshot, type PublicScreenshot } from "../lib/api";

export function ScreenshotPage() {
  const { slug = "" } = useParams();
  const [shot, setShot] = useState<PublicScreenshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchPublicScreenshot(slug)
      .then((next) => {
        if (!cancelled) setShot(next);
      })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Screenshot unavailable");
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const missing = Boolean(error);
  const title = missing ? "Screenshot unavailable" : "Screenshot · Replayr";
  const image = shot ? `/s/${shot.slug}.png` : null;

  return (
    <main className="page">
      <Seo
        title={title}
        description={missing ? "This screenshot is no longer available." : "A Replayr screenshot."}
        robots="noindex,nofollow"
        image={image}
      />
      {missing ? (
        <>
          <h1>Screenshot unavailable</h1>
          <p className="muted">{error || "This link no longer has an image."}</p>
        </>
      ) : !shot ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <img
            src={`/s/${shot.slug}.png`}
            alt="Replayr screenshot"
            width={shot.width}
            height={shot.height}
            style={{ maxWidth: "100%", height: "auto", borderRadius: 8 }}
          />
          <p className="muted" style={{ marginTop: 16 }}>
            {shot.width}×{shot.height}
          </p>
          <p>
            <Link className="btn primary" to="/">
              Captured with Replayr
            </Link>
          </p>
        </>
      )}
    </main>
  );
}
