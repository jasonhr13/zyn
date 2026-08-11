import Image from "next/image";
import Link from "next/link";

const checkoutFlow = [
  ["01", "Stock signal received", "Detected"],
  ["02", "Checkout session prepared", "Ready"],
  ["03", "Checkout task launched", "Running"],
  ["04", "Order confirmed", "Success"],
];

export default function Home() {
  return (
    <main className="home-page">
      <header className="site-header home-header">
        <a className="brand" href="#top" aria-label="Zyn home">
          <Image src="/zyn-icon.png" alt="" width={44} height={44} unoptimized />
          <span>Zyn</span>
        </a>
        <nav aria-label="Main navigation">
          <a href="#beta">Free beta</a>
          <Link className="nav-cta" href="/join">Join waiting list</Link>
        </nav>
      </header>

      <section className="target-hero" id="top">
        <div className="target-hero-copy">
          <div className="target-chip"><i aria-hidden="true" /> Target + Pokémon Center US support</div>
          <h1>Peak checkout<br />performance.</h1>
          <p className="target-lede">
            Zyn turns product drops into confirmed orders on Target and Pokémon Center US—with
            focused desktop automation and complete control.
          </p>
          <div className="hero-actions">
            <Link className="button button-primary" href="/join">
              Join the free beta <span aria-hidden="true">→</span>
            </Link>
            <a className="button button-secondary" href="#beta">Beta details</a>
          </div>
          <p className="beta-promise">
            <strong>Free during beta.</strong> Every beta user gets one full year free after paid access launches.
          </p>
          <div className="target-capabilities" aria-label="Supported retailers and core capabilities">
            <span>Target</span>
            <span>Pokémon Center US</span>
            <span>Native checkout engines</span>
          </div>
        </div>

        <div className="performance-stage" aria-label="Preview of Zyn retailer automation">
          <div className="performance-halo" aria-hidden="true" />
          <div className="target-console">
            <div className="console-bar">
              <div className="console-brand">
                <Image src="/zyn-icon.png" alt="" width={26} height={26} unoptimized />
                <div><strong>Zyn</strong><span>Retailer engines</span></div>
              </div>
              <div className="engine-status"><i /> 2 retailers online</div>
            </div>

            <div className="console-content">
              <div className="console-heading">
                <div><span>Live checkout</span><strong>Pokémon TCG release</strong></div>
                <em>Pokémon Center US</em>
              </div>

              <div className="console-metrics">
                <div><span>Target</span><strong>Ready</strong></div>
                <div><span>Pokémon Center</span><strong>Running</strong></div>
                <div><span>Tasks</span><strong>Armed</strong></div>
              </div>

              <div className="checkout-flow">
                <div className="flow-header"><span>Checkout pipeline</span><span>Live</span></div>
                {checkoutFlow.map(([number, label, state], index) => (
                  <div className="flow-row" key={number}>
                    <span className="flow-number">{number}</span>
                    <div className="flow-line" aria-hidden="true"><i className={index === checkoutFlow.length - 1 ? "complete" : ""} /></div>
                    <strong>{label}</strong>
                    <em className={state.toLowerCase()}>{state}</em>
                  </div>
                ))}
              </div>
            </div>

            <div className="console-footer">
              <span>Target + Pokémon Center US</span>
              <span>macOS · Apple Silicon + Intel</span>
            </div>
          </div>
          <div className="performance-tag tag-native"><span>Retailers</span><strong>02 supported</strong></div>
          <div className="performance-tag tag-confirmed"><span>Checkout</span><strong>Confirmed</strong></div>
        </div>
      </section>

      <section className="beta-section" id="beta">
        <div className="beta-copy">
          <p className="kicker">The beta deal</p>
          <h2>Free now.<br />Free for your first year.</h2>
          <p>
            Pricing for the full release is coming soon. Join the beta and your first 12 months of
            full access stay free—even after paid plans roll out.
          </p>
        </div>

        <div className="beta-offer">
          <div className="offer-topline"><span>Beta access</span><em>Limited rollout</em></div>
          <div className="offer-price"><strong>$0</strong><span>during beta</span></div>
          <ul>
            <li><i aria-hidden="true">01</i><span><strong>Two focused retailer engines</strong>Target and Pokémon Center US automation in one desktop app.</span></li>
            <li><i aria-hidden="true">02</i><span><strong>Full beta access</strong>Use the complete beta without a subscription fee.</span></li>
            <li><i aria-hidden="true">03</i><span><strong>One-year beta promise</strong>Every beta user receives 12 months free after paid access launches.</span></li>
          </ul>
          <Link className="button button-primary offer-button" href="/join">
            Join the waiting list <span aria-hidden="true">→</span>
          </Link>
          <p>No payment required to join. We’ll email you when your beta spot is ready.</p>
        </div>
      </section>

      <footer className="home-footer">
        <a className="brand" href="#top"><Image src="/zyn-icon.png" alt="" width={38} height={38} unoptimized /><span>Zyn</span></a>
        <p>Target + Pokémon Center US automation.</p>
        <div><a href="mailto:hello@zynbot.app">Contact</a><span>© {new Date().getFullYear()} Zyn</span></div>
      </footer>
    </main>
  );
}
