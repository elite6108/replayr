import { Link } from "react-router-dom";
import { Seo } from "../components/Seo";

export function FeaturesPage() {
  return (
    <main className="page marketing">
      <Seo
        title="Features — Replayr"
        description="Instant Replay, a local Windows library, unlisted cloud shares, and game detection. Clipping stays on the PC."
      />
      <p className="eyebrow">Product</p>
      <h1>What Replay does today</h1>
      <p className="lede">
        These are capabilities on the Windows app or this site. Likes, comments, and Explore are not shipped. Do not clip
        from the browser.
      </p>

      <div className="feature-list">
        <article className="card">
          <h2>Instant Replay</h2>
          <p>
            A rolling buffer on the PC. Hotkeys and the tray save the last moments without starting a take after the play.
            Recording sessions exist too when you want a longer file.
          </p>
        </article>
        <article className="card">
          <h2>This PC vs cloud</h2>
          <p>
            The desktop library keeps two states distinct: files on this machine, and optional cloud copies. Deleting or
            renaming a cloud row does not wipe the local MP4.
          </p>
        </article>
        <article className="card">
          <h2>Game detection</h2>
          <p>
            Process watch matches running Windows image names against a catalog. Titles are data, including wildcards,
            not hardcoded app logic.
          </p>
        </article>
        <article className="card">
          <h2>Share without a username</h2>
          <p>
            Links look like <code>/c/H7ks92L</code>. Changing a username later cannot break an old share. Unlisted is the
            default upload visibility.
          </p>
        </article>
        <article className="card">
          <h2>Visibility</h2>
          <p>
            Unlisted: anyone with the URL. Private: owner only. Public: later discovery — not an Explore feed on this site
            yet. Unlisted rows never appear in public listings.
          </p>
        </article>
        <article className="card">
          <h2>Privacy of lookups</h2>
          <p>
            Public listings only see public + ready clips. Unlisted and private playback goes through a one-slug Worker
            lookup so the database cannot be scraped for every unlisted file.
          </p>
        </article>
      </div>

      <p className="row">
        <Link className="btn primary" to="/signin">
          Create free account
        </Link>
        <Link className="btn" to="/pricing">
          Pricing
        </Link>
      </p>
    </main>
  );
}
