import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AppDownloadLink } from "../components/analytics/AppDownloadLink";
import { GameCover } from "../components/GameCover";
import { Seo } from "../components/Seo";
import { WINDOWS_DOWNLOAD_PATH } from "../lib/branding";
import { fetchGames, type CatalogGame } from "../lib/games";

const moments = [
  { src: "/marketing/record-preview.png", title: "Instant Replay", detail: "Saved on this PC", meta: "00:30" },
  { src: "/marketing/local-library.png", title: "Library", detail: "This PC", meta: "Local" },
  { src: "/marketing/clip-editor.jpg", title: "Editor", detail: "Trim the take", meta: "Edit" },
  { src: "/marketing/share-privacy.png", title: "Share", detail: "Unlisted link", meta: "Cloud" },
];

const steps = [
  {
    title: "It happens",
    body: "The play is already in the rolling buffer. You do not start a recording after the moment.",
  },
  {
    title: "You hit the hotkey",
    body: "F9 saves the recent gameplay. One key turns the buffer into a clip.",
  },
  {
    title: "Replayr saves it",
    body: "The file lands in the library on this PC. Local clips stay unmarked.",
  },
  {
    title: "You keep, trim, or share it",
    body: "Trim in the editor, or upload an unlisted link when you want a copy off this machine.",
  },
];

const questions = [
  {
    q: "Does Replayr run on Windows?",
    a: "Yes. Capture and the library are the Windows app. You do not clip from the browser.",
  },
  {
    q: "What does the hotkey do?",
    a: "F9 saves the recent buffer. You do not have to start a take after the play. Recording sessions are there when you want a longer file.",
  },
  {
    q: "What stays on this PC, and what is cloud?",
    a: "Local files stay on the machine and are unmarked. Cloud copies are optional. Deleting or renaming a cloud row does not wipe the local MP4.",
  },
  {
    q: "Which games does Replayr see?",
    a: "Replayr watches the running Windows process and matches it to the game catalog. Titles are data, including wildcards.",
  },
  {
    q: "Do I need an account?",
    a: "You can capture on this PC without uploading. An account is for cloud copies and for sharing an unlisted link like /c/H7ks92L.",
  },
  {
    q: "What does Replayr+ cost?",
    a: "Replayr+ is $6.99 a month, with a 7-day trial that requires a card. Free includes 5 GB, 20-minute 1080p uploads, a watermark on shared and uploaded copies, and house ads. Replayr+ includes 100 GB, original quality including 4K, no watermark, and no ads. Local files are not billed against cloud storage.",
  },
];

export function HomePage() {
  const [open, setOpen] = useState(0);
  const [games, setGames] = useState<CatalogGame[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchGames()
      .then((next) => {
        if (!cancelled) setGames(next.slice(0, 16));
      })
      .catch(() => {
        if (!cancelled) setGames([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="home-stage">
      <Seo
        title="Replayr — Instant replay. Real moments."
        description="Great plays don't wait for Record. Replayr keeps your recent gameplay ready. One hotkey, F9, makes it yours."
      />
      <section className="home-hero">
        <img className="home-hero-scene" src="/marketing/home-hero.jpg" alt="" />
        <div className="home-hero-shade" />
        <div className="home-hero-copy">
          <p className="home-kicker">Instant replay. Real moments.</p>
          <h1>
            That just
            <br />
            happened!
            <br />
            <span>Keep it.</span>
          </h1>
          <p className="home-lede">
            Great plays don&apos;t wait for Record. Replayr keeps your recent gameplay ready. One hotkey{" "}
            <span className="home-hotkey">F9</span> makes it yours.
          </p>
        </div>
      </section>

      <section className="home-section home-center" id="keep">
        <p className="home-kicker">The moment happens once.</p>
        <h2>
          Keep it <span>forever.</span>
        </h2>
        <div className="home-moments-row">
          {moments.map((moment) => (
            <article className="home-moment-card" key={moment.title}>
              <img src={moment.src} alt="" />
              <div>
                <strong>{moment.title}</strong>
                <span>{moment.detail}</span>
                <span>{moment.meta}</span>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="home-section" id="flow">
        <div className="home-center">
          <p className="home-kicker">From gameplay to clip.</p>
          <h2>
            Without losing <span>momentum.</span>
          </h2>
        </div>
        <div className="home-steps">
          {steps.slice(0, 2).map((step, index) => (
            <article className="home-step" key={step.title}>
              <b>{index + 1}</b>
              <strong>{step.title}</strong>
              <p>{step.body}</p>
            </article>
          ))}
          <img className="home-steps-still" src="/marketing/record-preview.png" alt="" />
          {steps.slice(2).map((step, index) => (
            <article className="home-step" key={step.title}>
              <b>{index + 3}</b>
              <strong>{step.title}</strong>
              <p>{step.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="home-section" id="pc">
        <div className="home-center">
          <p className="home-kicker">On your PC.</p>
          <h2>
            On your <span>terms.</span>
          </h2>
        </div>
        <div className="home-split">
          <article className="home-panel">
            <img src="/marketing/local-library.png" alt="" />
            <div>
              <h3>This PC</h3>
              <p>
                Files stay on this machine. Local clips are unmarked and are not billed against cloud storage.
                Deleting a cloud copy does not wipe the local MP4.
              </p>
            </div>
          </article>
          <article className="home-panel">
            <img src="/marketing/share-privacy.png" alt="" />
            <div>
              <h3>Cloud</h3>
              <p>
                Upload when you want a copy off this PC. Shares look like <code>/c/H7ks92L</code>. Unlisted is the
                default, so the link is not a public listing.
              </p>
            </div>
          </article>
        </div>
      </section>

      <section className="home-section" id="games">
        <div className="home-center">
          <p className="home-kicker">Your game.</p>
          <h2>
            Your <span>moment.</span>
          </h2>
        </div>
        {games === null ? <p className="home-lede home-center">Loading games…</p> : null}
        <div className="home-games">
          {(games ?? []).map((game) => (
            <Link className="home-game" key={game.id} to={`/games/${game.slug}`}>
              <GameCover name={game.name} coverUrl={game.coverUrl} />
              <strong>{game.name}</strong>
            </Link>
          ))}
        </div>
      </section>

      <section className="home-section" id="plans">
        <div className="home-center">
          <p className="home-kicker">Start free.</p>
          <h2>
            Upgrade for <span>more.</span>
          </h2>
        </div>
        <div className="home-prices">
          <article className="home-price">
            <h3>Free</h3>
            <p className="home-price-figure">
              $0 <span>/ mo</span>
            </p>
            <ul>
              <li>5 GB cloud storage</li>
              <li>20-minute 1080p uploads</li>
              <li>Watermark on share, export, and cloud</li>
              <li>House ads on web and mobile</li>
              <li>Local library unlimited and unmarked</li>
            </ul>
            <AppDownloadLink className="home-cta" href={WINDOWS_DOWNLOAD_PATH} platform="windows" surface="homepage">
              Download for Windows
            </AppDownloadLink>
          </article>
          <article className="home-price home-price-plus">
            <h3>Replayr+</h3>
            <p className="home-price-figure">
              $6.99 <span>/ mo</span>
            </p>
            <ul>
              <li>100 GB cloud storage</li>
              <li>No cloud length cap</li>
              <li>Original quality, including 4K</li>
              <li>No watermark</li>
              <li>No ads</li>
              <li>7-day trial with a card</li>
            </ul>
            <Link className="home-cta" to="/pricing">
              Get Replayr+
            </Link>
          </article>
        </div>
      </section>

      <section className="home-section" id="questions">
        <div className="home-center">
          <p className="home-kicker">Before you hit download.</p>
          <h2>Questions</h2>
        </div>
        <div className="home-faq">
          {questions.map((item, index) => {
            const expanded = open === index;
            return (
              <div className="home-faq-item" key={item.q}>
                <button type="button" aria-expanded={expanded} onClick={() => setOpen(expanded ? -1 : index)}>
                  {item.q}
                  <span aria-hidden="true">{expanded ? "–" : "+"}</span>
                </button>
                {expanded ? <p>{item.a}</p> : null}
              </div>
            );
          })}
        </div>
      </section>

      <section className="home-close" id="again">
        <div>
          <p className="home-kicker">Next time it happens.</p>
          <h2>
            Keep <span>it.</span>
          </h2>
          <AppDownloadLink className="home-cta" href={WINDOWS_DOWNLOAD_PATH} platform="windows" surface="homepage">
            Download for Windows
          </AppDownloadLink>
        </div>
        <img src="/marketing/local-library.png" alt="" />
      </section>
    </main>
  );
}
