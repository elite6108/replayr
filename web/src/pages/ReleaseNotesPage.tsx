import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Seo } from "../components/Seo";
import { AppDownloadLink } from "../components/analytics/AppDownloadLink";
import { MAC_DOWNLOAD_PATH, WINDOWS_DOWNLOAD_PATH } from "../lib/branding";
import { fetchReleaseNotes, type ReleaseNoteEntry } from "../lib/releaseNotes";

export function ReleaseNotesPage() {
  const [releases, setReleases] = useState<ReleaseNoteEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchReleaseNotes()
      .then((next) => {
        if (!cancelled) setReleases(next);
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : "Could not load release notes.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="page marketing">
      <Seo
        title="Release notes — Replayr"
        description="What changed in each Replayr desktop release for Windows and macOS."
      />
      <p className="eyebrow">Desktop app</p>
      <h1>Release notes</h1>
      <p className="lede">
        Changes shipped in each desktop build. The Windows app also shows these notes when an update is ready in Settings.
      </p>
      <div className="download-actions">
        <AppDownloadLink className="btn glow" href={WINDOWS_DOWNLOAD_PATH} platform="windows" surface="other">
          Download for Windows
        </AppDownloadLink>
        <AppDownloadLink className="btn outline" href={MAC_DOWNLOAD_PATH} platform="macos" surface="other">
          Download for macOS
        </AppDownloadLink>
      </div>

      {error ? <p className="error">{error}</p> : null}
      {!error && releases.length === 0 ? <p className="muted">Release notes are not available right now.</p> : null}

      <div className="release-notes-list">
        {releases.map((release, index) => (
          <article key={release.version} className="card release-notes-entry">
            <div className="release-notes-entry-head">
              <h2>v{release.version}</h2>
              {index === 0 ? <span className="release-notes-badge">Latest</span> : null}
            </div>
            <ul>
              {release.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </article>
        ))}
      </div>

      <p className="muted">
        Need an older build? <Link to="/">Return home</Link> and download the current installer, or check for updates in the installed app.
      </p>
    </main>
  );
}
