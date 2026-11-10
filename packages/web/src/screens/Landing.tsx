import { useEffect, useState } from "react";
import { readToken, writeToken } from "../api.ts";
import "../landing.css";
import "../landing-button.css";
import { Logo } from "../parts/icons.tsx";
import type { Info } from "../types.ts";

/**
 * What PureStrings is, for anyone who opens it without a token: the button paying for a cart, how a payment goes,
 * what it stops, and the PayPal it runs on. Below, the owner opens their PureStrings with its token.
 */

const REPO = "https://github.com/N-45div/PureStrings";

/** One payment on the button, from OpenClaw's ask to PayPal's answer: what the screen shows, and what's happening. */
const STEPS = [
  { at: "idle", ms: 1800, says: "Your assistant shops. The button waits." },
  { at: "ask", ms: 3200, says: "OpenClaw calls shop_buy over MCP. The button chimes and reads out the cart." },
  { at: "hold", ms: 2300, says: "You hold for two seconds. The key in its chip signs this exact cart." },
  { at: "paying", ms: 1900, says: "The shop checks the signature and the cart, then charges your PayPal." },
  { at: "paid", ms: 3200, says: "Paid, with a PayPal capture id in the ledger. Nothing else could have paid." },
] as const;

function useStep(): number {
  const [step, setStep] = useState(1);
  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const timer = window.setTimeout(() => setStep((at) => (at + 1) % STEPS.length), STEPS[step]!.ms);
    return () => window.clearTimeout(timer);
  }, [step]);
  return step;
}

/** The PureStrings button as it looks on a desk: its screen (in its own colours), its LED and its one button. */
function Button({ step }: { readonly step: number }) {
  const at = STEPS[step]!.at;
  return (
    <figure className="lp-device" data-at={at} aria-label="The PureStrings button paying for a cart">
      <div className="lp-board">
        <span className="lp-led" />
        <div className="lp-screen">
          {at === "idle" ? (
            <div className="lp-idle">
              <b>PureStrings</b>
              <small>Nothing to sign</small>
              <strong>$40.50</strong>
              <small>paid today</small>
              <em>key 96F7 9328 5AEA 9A32</em>
            </div>
          ) : at === "paying" || at === "paid" ? (
            <div className="lp-reply">
              <b className={at === "paid" ? "good" : ""}>{at === "paid" ? "Paid" : "Signed"}</b>
              <small>{at === "paid" ? "Paid $12.00 to Bean & Leaf with PayPal." : "Paying with PayPal..."}</small>
            </div>
          ) : (
            <div className="lp-sign">
              <small>OpenClaw asks</small>
              <strong>$12.00</strong>
              <span className="lp-shop">Bean &amp; Leaf</span>
              <small className="lp-id">{window.location.host}</small>
              <div className="lp-line">
                <span>1x House blend bea.</span>
                <span>12.00</span>
              </div>
              <small className="lp-hint">hold 2s: sign tap: no</small>
              <span className="lp-bar">
                <i />
              </span>
            </div>
          )}
        </div>
        <span className="lp-press" aria-hidden="true" />
      </div>
      <figcaption>
        <span className="lp-dots">
          {STEPS.map((one, index) => (
            <i key={one.at} className={index === step ? "on" : ""} />
          ))}
        </span>
        {STEPS[step]!.says}
      </figcaption>
    </figure>
  );
}

export function Landing({ info, locked, onOpen }: { readonly info: Info | null; readonly locked: boolean; readonly onOpen: () => void }) {
  const step = useStep();
  const [token, setToken] = useState("");
  const tried = locked && Boolean(readToken());
  const open = (
    <form
      className="lp-open"
      onSubmit={(event) => {
        event.preventDefault();
        writeToken(token.trim());
        onOpen();
      }}
    >
      <input className="input" type="password" autoComplete="current-password" placeholder="This PureStrings' token" value={token} onChange={(event) => setToken(event.target.value)} aria-label="Your PureStrings token" />
      <button type="submit" className="btn primary" disabled={!token.trim()}>
        Open PureStrings
      </button>
    </form>
  );

  return (
    <div className="lp">
      <header className="lp-top">
        <span className="lp-brand">
          <span className="lp-logo">
            <Logo />
          </span>
          PureStrings
        </span>
        <nav>
          <a href="#how">How it pays</a>
          <a href="#stops">What it stops</a>
          <a href="#paypal">PayPal</a>
          <a href={REPO}>GitHub</a>
          {locked ? (
            <a className="btn" href="#open">
              Open
            </a>
          ) : (
            <a className="btn primary" href="#/">
              Open the app
            </a>
          )}
        </nav>
      </header>

      <section className="lp-hero">
        <div className="lp-pitch">
          <span className="lp-kicker">Open source · self-hosted · PayPal{info?.paypal === "sandbox" ? " sandbox" : ""}</span>
          <h1>
            Your assistant can shop.
            <br />
            <span>Only your key can pay.</span>
          </h1>
          <p>
            PureStrings is the payment layer between your AI assistant and your PayPal. OpenClaw, Hermes Agent, Claude Code or any MCP client fills the cart. A key you hold signs that exact cart, and the shop checks the signature before PayPal is charged.
          </p>
          <ul className="lp-proof">
            <li>The key is a button on your desk, or the browser you're in</li>
            <li>It shows who asked, the shop, each line and the total, and says it aloud</li>
            <li>A prompt injection can fill a cart; it can't hold the button</li>
          </ul>
          {locked ? (
            <div id="open" className="lp-cta">
              {open}
              {tried ? <span className="error">That token wasn't right.</span> : <small className="muted">The token is in this PureStrings' settings (PURESTRINGS_TOKEN). A link ending #token=… opens it straight away.</small>}
            </div>
          ) : (
            <div className="lp-cta row">
              <a className="btn primary" href="#/">
                Open the app
              </a>
              <a className="btn" href={REPO}>
                Read the code
              </a>
            </div>
          )}
        </div>
        <Button step={step} />
      </section>

      <section id="how" className="lp-section">
        <h2>How a payment goes</h2>
        <ol className="lp-steps">
          <li>
            <b>Your assistant asks</b>
            <p>It searches the shop and calls shop_buy over MCP with its own token. Its name goes into what your key signs.</p>
          </li>
          <li>
            <b>Your key shows it</b>
            <p>The exact text it would sign: who asked, the shop, every line and the total. A shop it has never paid shows in red.</p>
          </li>
          <li>
            <b>You hold for two seconds</b>
            <p>A P-256 key made inside the button's chip (or in your browser) signs the text. A tap says no.</p>
          </li>
          <li>
            <b>The shop checks, then PayPal pays</b>
            <p>The shop matches the signature and the cart to the key you linked at PayPal, then charges the vault with Orders v2.</p>
          </li>
        </ol>
      </section>

      <section id="stops" className="lp-section lp-stops">
        <h2>What it stops</h2>
        <div className="lp-cards">
          <article>
            <span className="pill bad">refused by you</span>
            <h3>A $200 gift card from a poisoned page</h3>
            <p>Your assistant reads a page that tells it to buy a gift card. It asks, and your key shows "$200 gift card". You tap, and nothing is paid.</p>
          </article>
          <article>
            <span className="pill bad">409 at the shop</span>
            <h3>A cart changed after you signed</h3>
            <p>Swap an item or change the total, and the signature no longer matches. The shop refuses before PayPal is ever called.</p>
          </article>
          <article>
            <span className="pill bad">flagged by the auditor</span>
            <h3>A charge made around PureStrings</h3>
            <p>The auditor reads PayPal's own record. A capture no key signed is flagged, and a dispute is drafted for you.</p>
          </article>
          <article>
            <span className="pill good">within your limits</span>
            <h3>Small buys, without a hold</h3>
            <p>Say "up to $15 a time, $60 a month at Bean &amp; Leaf". The model writes it as an allowance, your key signs it once, and the shop holds payments to it.</p>
          </article>
        </div>
      </section>

      <section id="paypal" className="lp-section lp-split">
        <div>
          <h2>Built on PayPal</h2>
          <ul className="lp-list">
            <li>
              <b>Vault</b> saves your PayPal once per key, through PayPal's own approval page.
            </li>
            <li>
              <b>Orders v2</b> charges the vault only for a cart your key signed.
            </li>
            <li>
              <b>Webhooks</b>, each one verified with PayPal, mark captures and refunds as they happen.
            </li>
            <li>
              <b>Webhook events</b> let the auditor read back PayPal's record and match it to every signature.
            </li>
            <li>
              <b>Refunds</b> from the shop's admin, recorded against the payment.
            </li>
          </ul>
        </div>
        <div>
          <h2>AI where it helps</h2>
          <ul className="lp-list">
            <li>
              <b>Assistants shop over MCP</b>: shop_search, shop_buy, payment_status. The browser's own agent gets WebMCP tools.
            </li>
            <li>
              <b>Allowances from a sentence</b>: {info?.model ?? "a model"} turns your words into limits your key signs.
            </li>
            <li>
              <b>Disputes drafted</b> for any charge the auditor flags.
            </li>
            <li>
              <b>The button speaks</b>: OpenAI's voice says each payment out loud, but the screen is still what you trust.
            </li>
          </ul>
        </div>
      </section>

      <section className="lp-section lp-hardware">
        <div>
          <h2>A key you can hold</h2>
          <p>
            The PureStrings button is an ESP32-S3 with a 1.8" screen, a speaker and one button. It makes its key in its own chip, and the private half never leaves it. Plug it into the computer running PureStrings and it's linked. No Wi-Fi, no app, no driver.
          </p>
        </div>
        <dl className="lp-facts">
          <div>
            <dt>Signs</dt>
            <dd>ECDSA P-256 over the exact cart</dd>
          </div>
          <div>
            <dt>Shows</dt>
            <dd>who asked, the shop, every line, the total</dd>
          </div>
          <div>
            <dt>Asks for</dt>
            <dd>a full 2 s hold, every line seen first</dd>
          </div>
          <div>
            <dt>Warns</dt>
            <dd>on a shop it has never paid</dd>
          </div>
        </dl>
      </section>

      <footer className="lp-foot">
        <span>
          PureStrings {info?.version ?? ""} · AGPL-3.0 · <a href={REPO}>{REPO.replace("https://", "")}</a>
        </span>
        {info?.paypal === "sandbox" ? <span className="pill info">PayPal sandbox: no real money moves here</span> : null}
      </footer>
    </div>
  );
}
