import Image from "next/image";
import Link from "next/link";

const checkoutFlow = [
  ["01", "Products being watched", "Ready"],
  ["02", "Ready to add to cart", "Ready"],
  ["03", "Priority item in cart", "Running"],
  ["04", "Order confirmed", "Success"],
];

const features = [
  {
    kicker: "Checkout",
    title: "From login to order.",
    copy: "Zyn signs in, adds the item to cart, pays, and places the order on Target or Pokémon Center US from one Mac or Windows app.",
  },
  {
    kicker: "Accounts",
    title: "Generate Target accounts. Jig the address.",
    copy: "Create Target accounts in the app. Each one can get a checkout profile with a slightly different shipping address, so they do not all look the same.",
  },
  {
    kicker: "Proxies",
    title: "Keep the lists that work.",
    copy: "Give a group several proxy lists. Zyn keeps using the ones that add to cart and sets aside the ones that don’t.",
  },
  {
    kicker: "Priority items",
    title: "Buy the product you care about first.",
    copy: "Star the items that matter. Running tasks switch to them before paying, and stop chasing a product you take off the list.",
  },
  {
    kicker: "Ready to cart",
    title: "Be ready when it restocks.",
    copy: "Collect Target session cookies ahead of time so checkout is not waiting around when the item comes back.",
  },
  {
    kicker: "Live run",
    title: "See the drop as it happens.",
    copy: "Watch how many tasks carted, submitted, and checked out without opening every account.",
  },
];

const differences = [
  {
    usualTitle: "Every store in one app",
    usual: "Amazon, Walmart, Best Buy, Target, and more — so setup is spread across sites you may never run.",
    zynTitle: "Target and Pokémon Center US",
    zyn: "The watch list, proxies, and checkout are built for Target and Pokémon Center US drops. Nothing else to configure.",
  },
  {
    usualTitle: "Same address on every account",
    usual: "You make Target accounts, then paste one shipping address onto every checkout profile.",
    zynTitle: "Generate accounts, jig the address",
    zyn: "The Target account generator can create matching profiles and give each one a slightly different shipping address.",
  },
  {
    usualTitle: "One proxy list per task",
    usual: "You pick a list, assign it, and hope it still works when the item comes back.",
    zynTitle: "Lists that keep working",
    zyn: "Give a group several lists. Zyn stays on the ones that add to cart and sets the rest aside.",
  },
  {
    usualTitle: "Whatever hits cart first",
    usual: "Tasks chase the first in-stock product on a long list — even if it is not the one you wanted.",
    zynTitle: "Star it, then switch",
    zyn: "Mark the product you care about. Running tasks move to it before they pay.",
  },
  {
    usualTitle: "Guess how the drop is going",
    usual: "Open every account to see who carted, who is paying, and who actually checked out.",
    zynTitle: "Carts, submits, checkouts",
    zyn: "Live counts for the whole group, so you can watch the restock in one place.",
  },
  {
    usualTitle: "Stuck on that computer",
    usual: "Accounts and settings usually live only on the machine you set up.",
    zynTitle: "Save your setup",
    zyn: "Back up from Settings so you are not starting over if you switch Macs or PCs.",
  },
  {
    usualTitle: "Pay before you run a drop",
    usual: "Most bots want a license first — often hundreds or thousands of dollars.",
    zynTitle: "$100 for two months",
    zyn: "Start at $100 for the first two months, then $40 each month. Target and Pokémon Center US are included.",
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
          <a href="#why">Why Zyn</a>
          <a href="#pricing">Pricing</a>
          <Link className="nav-cta" href="/buy">Buy Zyn</Link>
        </nav>
      </header>

      <section className="target-hero" id="top">
        <div className="target-hero-copy">
          <div className="target-chip"><i aria-hidden="true" /> Target and Pokémon Center US</div>
          <h1>Built for<br />Target and Pokémon Center drops.</h1>
          <p className="target-lede">
            Zyn is a desktop app for Target and Pokémon Center US restocks — not an all-in-one for every store.
            Watch the products you want, keep proxies that work, and check out when they come back.
          </p>
          <div className="hero-actions">
            <Link className="button button-primary" href="/buy">
              Buy Zyn — $100 <span aria-hidden="true">→</span>
            </Link>
            <a className="button button-secondary" href="#features">See how it works</a>
          </div>
          <p className="beta-promise">
            <strong>$100 for two months.</strong> Then $40 every month. Target and Pokémon Center US are included.
          </p>
          <div className="target-capabilities" aria-label="Supported retailers">
            <span>Target checkout</span>
            <span>Pokémon Center US</span>
            <span>Product watch lists</span>
            <span>Mac and Windows</span>
          </div>
        </div>

        <div className="performance-stage" aria-label="Preview of Zyn Target checkout">
          <div className="performance-halo" aria-hidden="true" />
          <div className="target-console">
            <div className="console-bar">
              <div className="console-brand">
                <Image src="/zyn-icon.png" alt="" width={26} height={26} unoptimized />
                <div><strong>Zyn</strong><span>Target and Pokémon Center US</span></div>
              </div>
              <div className="engine-status"><i /> Watching Target</div>
            </div>

            <div className="console-content">
              <div className="console-heading">
                <div><span>Live checkout</span><strong>Target restock group</strong></div>
                <em>Priority item ready</em>
              </div>

              <div className="console-metrics">
                <div><span>Carted</span><strong>12</strong></div>
                <div><span>Submit</span><strong>4</strong></div>
                <div><span>Checkout</span><strong>2</strong></div>
              </div>

              <div className="checkout-flow">
                <div className="flow-header"><span>This drop</span><span>Live</span></div>
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
              <span>Target · Pokémon Center US</span>
              <span>Mac and Windows</span>
            </div>
          </div>
          <div className="performance-tag tag-native"><span>Retailers</span><strong>Target + PCUS</strong></div>
          <div className="performance-tag tag-confirmed"><span>Checkout</span><strong>Confirmed</strong></div>
        </div>
      </section>

      <section className="feature-section" id="features">
        <div className="feature-intro">
          <p className="kicker">On a drop</p>
          <h2>What you actually use.</h2>
          <p>
            Watch the products you want, keep the proxies that work, and see carts, submits, and
            checkouts as they happen.
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

      <section className="difference-section" id="why">
        <div className="difference-intro">
          <p className="kicker">Unlike most bots</p>
          <h2>Zyn does Target and Pokémon Center US.</h2>
          <p>
            Most all-in-one bots try to cover every store, then charge thousands
            before you even run a drop. Zyn is built around Target and Pokémon Center
            US restocks — and a few things those bots do not give you.
          </p>
        </div>
        <div className="difference-board" aria-label="How Zyn compares with typical all-in-one bots">
          <div className="difference-head">
            <span>Typical all-in-one</span>
            <span>Zyn</span>
          </div>
          {differences.map((row) => (
            <div className="difference-row" key={row.zynTitle}>
              <div>
                <small>Typical all-in-one</small>
                <strong>{row.usualTitle}</strong>
                <p>{row.usual}</p>
              </div>
              <div>
                <small>Zyn</small>
                <strong>{row.zynTitle}</strong>
                <p>{row.zyn}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="beta-section" id="pricing">
        <div className="beta-copy">
          <p className="kicker">Simple pricing</p>
          <h2>$100 to start.<br />$40 to stay on.</h2>
          <p>
            Pay $100 once and you get two months of Zyn. After that it renews at $40
            every month. Target and Pokémon Center US are both included.
          </p>
        </div>

        <div className="beta-offer">
          <div className="offer-topline"><span>Zyn license</span><em>Self-serve</em></div>
          <div className="offer-price"><strong>$100</strong><span>first two months</span></div>
          <ul>
            <li><i aria-hidden="true">01</i><span><strong>Target and Pokémon Center US</strong>Watch lists, proxies, and checkout for both retailers on Mac and Windows.</span></li>
            <li><i aria-hidden="true">02</i><span><strong>$100 for two months</strong>Then $40 every month. Cancel from the billing email Stripe sends you.</span></li>
            <li><i aria-hidden="true">03</i><span><strong>Same desktop app</strong>Buy on the web, then sign in on Mac or Windows with the account Zyn creates for you.</span></li>
          </ul>
          <Link className="button button-primary offer-button" href="/buy">
            Buy Zyn <span aria-hidden="true">→</span>
          </Link>
          <p>Checkout is handled by Stripe. Existing invited accounts keep working.</p>
        </div>
      </section>

      <footer className="home-footer">
        <a className="brand" href="#top"><Image src="/zyn-icon.png" alt="" width={38} height={38} unoptimized /><span>Zyn</span></a>
        <p>Target and Pokémon Center US checkout automation.</p>
        <div><a href="mailto:hello@zynbot.app">Contact</a><span>© {new Date().getFullYear()} Zyn</span></div>
      </footer>
    </main>
  );
}
