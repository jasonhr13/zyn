import Image from "next/image";
import Link from "next/link";

const checkoutFlow = [
  ["01", "Watch list armed", "Ready"],
  ["02", "ATC cookie taken", "Ready"],
  ["03", "Priority SKU carted", "Running"],
  ["04", "Order confirmed", "Success"],
];

const features = [
  {
    kicker: "Native engine",
    title: "Checkout stays on Target.",
    copy: "A compiled Target engine handles login, cart, payment, and order on Mac and Windows. No Wine, no extra retailer modules.",
  },
  {
    kicker: "Proxy folders",
    title: "Use the lists that work.",
    copy: "Assign a folder of proxy lists to a group. Checkout rotates across them, stays on the ones that cart, and sets dead lines aside.",
  },
  {
    kicker: "Priority SKUs",
    title: "Switch before payment.",
    copy: "Mark the SKUs that matter. Running tasks move to a priority item before the order submits, and a removed SKU is dropped from checkout.",
  },
  {
    kicker: "Cookie harvesters",
    title: "Farm ATC cookies separately.",
    copy: "Harvesters run on their own proxy lists and bank Shape cookies. When a task carts, it uses the cookie and the harvest IP that minted it.",
  },
  {
    kicker: "Drop pulse",
    title: "See the run as it happens.",
    copy: "The group header shows live cart, submit, and checkout counts so you can read a drop without opening every task.",
  },
  {
    kicker: "Task groups",
    title: "One watch list, many accounts.",
    copy: "Share a Target watch list across accounts, keep OTP on the task row, and back the workspace up from Settings.",
  },
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
          <a href="#features">Features</a>
          <a href="#beta">Free beta</a>
          <Link className="nav-cta" href="/join">Join waiting list</Link>
        </nav>
      </header>

      <section className="target-hero" id="top">
        <div className="target-hero-copy">
          <div className="target-chip"><i aria-hidden="true" /> Target.com only</div>
          <h1>Built for<br />Target drops.</h1>
          <p className="target-lede">
            Zyn is a desktop checkout app for Target. Watch lists, cookie harvesters, proxy
            folders, and a native engine stay pointed at one retailer.
          </p>
          <div className="hero-actions">
            <Link className="button button-primary" href="/join">
              Join the free beta <span aria-hidden="true">→</span>
            </Link>
            <a className="button button-secondary" href="#features">See the stack</a>
          </div>
          <p className="beta-promise">
            <strong>Free during beta.</strong> Every beta user gets one full year free after paid access launches.
          </p>
          <div className="target-capabilities" aria-label="Core Target capabilities">
            <span>Native Target engine</span>
            <span>Proxy folders</span>
            <span>ATC cookie bank</span>
            <span>macOS + Windows</span>
          </div>
        </div>

        <div className="performance-stage" aria-label="Preview of Zyn Target checkout">
          <div className="performance-halo" aria-hidden="true" />
          <div className="target-console">
            <div className="console-bar">
              <div className="console-brand">
                <Image src="/zyn-icon.png" alt="" width={26} height={26} unoptimized />
                <div><strong>Zyn</strong><span>Target engine</span></div>
              </div>
              <div className="engine-status"><i /> Target online</div>
            </div>

            <div className="console-content">
              <div className="console-heading">
                <div><span>Live checkout</span><strong>Target restock group</strong></div>
                <em>Priority SKU armed</em>
              </div>

              <div className="console-metrics">
                <div><span>Carted</span><strong>12</strong></div>
                <div><span>Submit</span><strong>4</strong></div>
                <div><span>Checkout</span><strong>2</strong></div>
              </div>

              <div className="checkout-flow">
                <div className="flow-header"><span>Target pipeline</span><span>Live</span></div>
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
              <span>Target.com</span>
              <span>macOS · Apple Silicon + Intel · Windows</span>
            </div>
          </div>
          <div className="performance-tag tag-native"><span>Retailer</span><strong>Target only</strong></div>
          <div className="performance-tag tag-confirmed"><span>Checkout</span><strong>Confirmed</strong></div>
        </div>
      </section>

      <section className="feature-section" id="features">
        <div className="feature-intro">
          <p className="kicker">The Target stack</p>
          <h2>What the app is actually for.</h2>
          <p>
            These are the pieces people run on a drop: a native Target engine, folders of proxies,
            a cookie bank, and a group that can change SKUs before payment.
          </p>
        </div>
        <div className="home-feature-grid">
          {features.map((feature) => (
            <article className="home-feature-card" key={feature.kicker}>
              <p>{feature.kicker}</p>
              <h3>{feature.title}</h3>
              <span>{feature.copy}</span>
            </article>
          ))}
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
            <li><i aria-hidden="true">01</i><span><strong>Target-only desktop app</strong>Native checkout, harvesters, and proxy folders for Target.com.</span></li>
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
        <p>Target.com checkout automation.</p>
        <div><a href="mailto:hello@zynbot.app">Contact</a><span>© {new Date().getFullYear()} Zyn</span></div>
      </footer>
    </main>
  );
}
