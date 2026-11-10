import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AppDownloadLink } from "../components/analytics/AppDownloadLink";
import { Seo } from "../components/Seo";
import { MAC_DOWNLOAD_PATH, SUPPORT_EMAIL, WINDOWS_DOWNLOAD_PATH } from "../lib/branding";
import "../landing.css";

const asset = "/marketing/landing";

const questions = [
  {
    q: "How can I save something that already happened?",
    a: "Replayr keeps your recent gameplay ready in the background. When something worth saving happens, hit your hotkey and turn that moment into a clip — even though it already happened.",
  },
  {
    q: "Do I have to upload my clips?",
    a: "No. Clips stay on this PC until you choose to upload. Cloud is optional, and deleting a cloud copy does not wipe the local file.",
  },
  {
    q: "Can I use Replayr on Windows and macOS?",
    a: "Windows is capture and Instant Replay. macOS is the library and sharing.",
  },
  {
    q: "Does Free limit my local clips?",
    a: "No. The local library is unlimited and unmarked. Free cloud storage is 5 GB.",
  },
  {
    q: "What changes when I choose Premium?",
    a: "Premium is 100 GB, original quality including 4K, no cloud length cap, no watermark, and no ads.",
  },
  {
    q: "Who can see a shared clip?",
    a: "Shares are unlisted. Someone needs the link. The link is not a public listing.",
  },
  {
    q: "Will Replayr affect my game’s performance?",
    a: "Replayr keeps a short rolling buffer so you can save the moment after it happens, instead of starting a recording first.",
  },
];

export function HomePage() {
  const [open, setOpen] = useState(0);

  useEffect(() => {
    if (!document.getElementById("land-display")) {
      const display = document.createElement("link");
      display.id = "land-display";
      display.rel = "stylesheet";
      display.href = "https://api.fontshare.com/v2/css?f[]=clash-display@600&display=swap";
      document.head.append(display);
    }
  }, []);

  return (
    <div className="land">
      <Seo
        title="Replayr — That just happened. Keep it."
        description="Great plays don’t wait for Record. Replayr keeps your recent gameplay ready. One hotkey, F9, makes it yours."
      />
      <main>
        <section className="land-hero">
          <img className="land-hero-room" src={`${asset}/hero-scene.jpg`} alt="" />
          <div className="land-hero-copy">
            <p className="land-kicker">Instant replay. Real moments.</p>
            <h1>
              That just
              <br />
              happened!
              <br />
              <span>Keep it.</span>
            </h1>
            <p className="land-lede">
              Great plays don’t wait for Record. Replayr keeps your recent gameplay ready. One hotkey{" "}
              <span className="land-key">F9</span> makes it yours.
            </p>
            <div className="land-hero-actions">
              <AppDownloadLink className="land-btn" href={WINDOWS_DOWNLOAD_PATH} platform="windows" surface="homepage">
                <img src={`${asset}/windows.svg`} alt="" />
                Download for Windows
              </AppDownloadLink>
              <a className="land-watch" href="#how">
                <img src={`${asset}/play.svg`} alt="" />
                Watch how it works
                <img src={`${asset}/arrow.svg`} alt="" />
              </a>
            </div>
          </div>
        </section>

        <section className="land-block" id="features">
          <Pill>How Replayr works</Pill>
          <h2>
            The moment happens once.
            <br />
            Keep it forever.
          </h2>
          <p className="land-sub">
            No need to start recording before something happens. Play normally, hit your Replayr hotkey after the
            moment, and keep the part that matters.
          </p>
          <img className="land-shot" src={`${asset}/section-moment.png`} alt="Saved clips of the moment that just happened" />
        </section>

        <section className="land-block land-block-carbon" id="how">
          <Pill>Built around your game</Pill>
          <h2>
            From gameplay to clip.
            <br />
            Without losing momentum.
          </h2>
          <p className="land-sub">
            Capture, clean up, and share the moment while it’s still fresh
            <br />
            then get straight back to playing.
          </p>
          <div className="land-tabs" role="tablist" aria-label="From gameplay to clip">
            <span className="is-on" role="tab" aria-selected="true">Play</span>
            <span role="tab" aria-selected="false">Cut</span>
            <span role="tab" aria-selected="false">Share</span>
          </div>
          <div className="land-play">
            <div>
              <h3>Play first. Save after.</h3>
              <p>No need to predict when something great is about to happen. Hit your hotkey after the play and Replayr keeps the moment.</p>
              <a className="land-btn" href="#download">
                Try it out
                <img src={`${asset}/arrow.svg`} alt="" />
              </a>
            </div>
            <img className="land-shot" src={`${asset}/section-capture.png`} alt="One hotkey captures the last three minutes" />
          </div>
        </section>

        <section className="land-block land-library" id="library">
          <div className="land-library-copy">
            <Pill>Your clips. Your control.</Pill>
            <h2>
              On your PC.
              <br />
              On your terms.
            </h2>
            <p>Keep clips on your PC, move the moments that matter to the cloud, and find everything in one clean Replayr library.</p>
            <Link className="land-btn" to="/library">
              Explore the library
              <img src={`${asset}/arrow.svg`} alt="" />
            </Link>
          </div>
          <img className="land-shot" src={`${asset}/section-library.png`} alt="Library on this PC, with optional cloud copies" />
        </section>

        <section className="land-block" id="games">
          <Pill>Made for how you play</Pill>
          <h2>
            Your game.
            <br />
            Your moment.
          </h2>
          <p className="land-sub">
            Ranked wins. Impossible saves. Perfect timing. Complete chaos. Replayr is built to keep the moments worth replaying.
          </p>
          <Link className="land-btn" to="/games">
            See supported games
            <img src={`${asset}/arrow.svg`} alt="" />
          </Link>
          <img className="land-games-strip" src={`${asset}/games-strip.png`} alt="Games Replayr can keep a moment from" />
        </section>

        <section className="land-block" id="pricing">
          <Pill>Simple pricing</Pill>
          <h2>
            Start free.
            <br />
            Upgrade for more.
          </h2>
          <p className="land-sub">
            Start saving your best moments for $0. Move to Premium when you want more storage and the full Replayr experience.
          </p>
          <div className="land-prices">
            <article className="land-price">
              <header>
                <h3>Free</h3>
                <p>Everything you need to start clipping.</p>
              </header>
              <p className="land-price-figure">
                $0 <span>free forever</span>
              </p>
              <AppDownloadLink className="land-price-cta" href={WINDOWS_DOWNLOAD_PATH} platform="windows" surface="homepage">
                Start Free
              </AppDownloadLink>
              <p className="land-storage"><b>5 GB</b> cloud storage</p>
              <ul>
                <li>Cloud clips up to 3 minutes</li>
                <li>1080p uploads at any frame rate</li>
                <li>Unlimited, unmarked local library</li>
              </ul>
              <p className="land-price-note">Replayr.tv watermark on share, export, and cloud.</p>
              <p className="land-price-note">House upgrade ads on web and mobile.</p>
            </article>
            <article className="land-price land-price-plus">
              <header>
                <h3>Premium</h3>
                <span>Most popular</span>
                <p>For players who never want to leave a moment behind.</p>
              </header>
              <p className="land-price-figure">
                $7.99 <span>per month</span>
              </p>
              <Link className="land-btn land-price-cta" to="/pricing">Start your 7-day trial</Link>
              <p className="land-trial">Try Premium free for 7 days.</p>
              <p className="land-storage"><b>100 GB</b> cloud storage</p>
              <ul>
                <li>No cloud clip length cap</li>
                <li>Original-quality uploads, including 4K</li>
                <li>No watermark</li>
                <li>No ads · Premium badge</li>
              </ul>
            </article>
          </div>
        </section>

        <section className="land-block" id="faq">
          <Pill>Quick answers</Pill>
          <h2>Before you hit download.</h2>
          <div className="land-faq">
            {questions.map((item, index) => {
              const expanded = open === index;
              return (
                <div className="land-faq-item" key={item.q}>
                  <button type="button" aria-expanded={expanded} onClick={() => setOpen(expanded ? -1 : index)}>
                    {item.q}
                    <span aria-hidden="true">{expanded ? "–" : "+"}</span>
                  </button>
                  {expanded ? <p>{item.a}</p> : null}
                </div>
              );
            })}
          </div>
          <div className="land-ask">
            <strong>Still have a question?</strong>
            <a className="land-btn" href={`mailto:${SUPPORT_EMAIL}`}>
              Talk to Support
              <img src={`${asset}/arrow.svg`} alt="" />
            </a>
          </div>
        </section>

        <section className="land-cta" id="download">
          <Pill>Your next clip starts here</Pill>
          <h2>
            Next time it happens,
            <br />
            keep it.
          </h2>
          <p className="land-sub">Download Replayr and turn every “did you clip that?” into an easy yes.</p>
          <div className="land-cta-frame">
            <img src={`${asset}/cta-shot.png`} alt="Replayr on the desktop" />
            <div className="land-cta-actions">
              <AppDownloadLink className="land-btn land-btn-square" href={WINDOWS_DOWNLOAD_PATH} platform="windows" surface="homepage">
                Download for Windows
                <img src={`${asset}/windows.svg`} alt="" />
              </AppDownloadLink>
              <AppDownloadLink className="land-btn land-btn-square" href={MAC_DOWNLOAD_PATH} platform="macos" surface="homepage">
                Downloads for Mac
                <img src={`${asset}/apple.svg`} alt="" />
              </AppDownloadLink>
            </div>
            <p className="land-platforms">
              Available on <span>Browser</span> <span>iOS</span> <span>Android</span> <span>Local download</span>
            </p>
            <p className="land-platform-note">Windows: capture &amp; Instant Replay · macOS: library &amp; sharing</p>
          </div>
        </section>
      </main>

      <footer className="land-foot">
        <div className="land-foot-card">
          <div className="land-foot-top">
            <div>
              <span className="land-foot-logo">
                <img src="/replayr-mark.png" alt="" />
                <span className="replayr-logo-name">Replayr<span>.</span></span>
              </span>
              <p>Did you clip it?</p>
            </div>
            <nav aria-label="Footer">
              <a href="#pricing">Pricing</a>
              <Link to="/releases">Release notes</Link>
              <a href={`mailto:${SUPPORT_EMAIL}`}>Support</a>
              <a href="https://x.com/Replayr_TV" target="_blank" rel="noreferrer">X / Twitter</a>
            </nav>
          </div>
          <div className="land-foot-bottom">
            <span>© {new Date().getFullYear()} Replayr</span>
            <span>Game artwork belongs to its respective owners.</span>
            <span>
              <Link to="/privacy">Privacy</Link>
              <Link to="/terms">Terms</Link>
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}

function Pill({ children }: { children: string }) {
  return <p className="land-pill">{children}</p>;
}
