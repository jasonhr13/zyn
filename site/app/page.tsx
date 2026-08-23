import Image from "next/image";
import Link from "next/link";

const features = [
  {
    kicker: "All-in-one",
    title: "Three retailers. One desktop app.",
    copy: "Run Target, Pokémon Center US, and Walmart from the same Mac or Windows workspace instead of juggling separate bots.",
  },
  {
    kicker: "Target",
    title: "Watch, harvest, then check out.",
    copy: "Star the SKUs that matter, bank session cookies ahead of time, and switch running tasks to a priority item before they pay.",
  },
  {
    kicker: "Pokémon Center",
    title: "Wait for the queue. Then go.",
    copy: "Hold guest checkout on placeholder SKUs, wait for queue, and apply products to every waiting task when the drop opens.",
  },
  {
    kicker: "Walmart",
    title: "Log in first. Apply SKUs later.",
    copy: "Start on placeholder, get the account ready, then paste drop SKUs and send them to every waiting Walmart task at once.",
  },
  {
    kicker: "Workspace",
    title: "Profiles, accounts, and proxies together.",
    copy: "Keep checkout profiles, logins, and proxy lists in one place. Zyn stays on the lists that add to cart and sets the rest aside.",
  },
  {
    kicker: "Live drop",
    title: "See carts, submits, and checkouts.",
    copy: "Watch the restock as a group instead of opening every account. Mac and Windows, same license.",
  },
];

const differences = [
  {
    usualTitle: "A different app per store",
    usual: "Target in one bot, Pokémon Center in another, Walmart in a third — three setups, three logins, three places to fail.",
    zynTitle: "ZynAIO",
    zyn: "Target, Pokémon Center US, and Walmart share one desktop app, one account, and one drop workspace.",
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
    zyn: "Mark the product you care about. Running Target tasks move to it before they pay.",
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

const shots = [
  {
    src: "/screenshots/zyn-target.png",
    title: "Target",
    copy: "Watch lists, accounts, and live drop counts in one group.",
  },
  {
    src: "/screenshots/zyn-target-harvesters.png",
    title: "Cookie harvest",
    copy: "Bank Target login and add-to-cart sessions before the restock.",
  },
  {
    src: "/screenshots/zyn-pokemon-center.png",
    title: "Pokémon Center US",
    copy: "Queue wait, placeholders, and guest checkout on the same screen.",
  },
  {
    src: "/screenshots/zyn-walmart.png",
    title: "Walmart",
    copy: "Log in on placeholder, then apply drop SKUs to every waiting task.",
  },
  {
    src: "/screenshots/zyn-profiles.png",
    title: "Profiles",
    copy: "Checkout profiles, groups, and mailboxes for every retailer.",
  },
  {
    src: "/screenshots/zyn-proxies.png",
    title: "Proxies",
    copy: "Keep the lists that add to cart. Set the rest aside.",
  },
];

function BrandMark({ size = 44 }: { size?: number }) {
  return (
    <>
      <Image src="/zyn-icon.png" alt="" width={size} height={size} unoptimized />
      <span>Zyn<span className="aio-mark">AIO</span></span>
    </>
  );
}

export default function Home() {
  return (
    <main className="home-page">
      <header className="site-header home-header">
        <a className="brand" href="#top" aria-label="ZynAIO home">
          <BrandMark />
        </a>
        <nav aria-label="Main navigation">
          <a href="#features">Features</a>
          <a href="#product">Product</a>
          <a href="#why">Why ZynAIO</a>
          <a href="#pricing">Pricing</a>
          <Link className="nav-cta" href="/buy">Buy Zyn</Link>
        </nav>
      </header>

      <section className="target-hero" id="top">
        <div className="target-hero-copy">
          <div className="target-chip"><i aria-hidden="true" /> ZynAIO</div>
          <h1>One app for Target, Pokémon Center, and Walmart.</h1>
          <p className="target-lede">
            ZynAIO is the desktop checkout workspace for the drops that matter.
            Watch products, keep working proxies, and check out from one Mac or Windows app.
          </p>
          <div className="hero-actions">
            <Link className="button button-primary" href="/buy">
              Buy Zyn — $100 <span aria-hidden="true">→</span>
            </Link>
            <a className="button button-secondary" href="#product">See the app</a>
          </div>
          <p className="beta-promise">
            <strong>$100 for two months.</strong> Then $40 every month. Target and Pokémon Center US are included.
          </p>
          <div className="target-capabilities" aria-label="Supported retailers">
            <span>Target</span>
            <span>Pokémon Center US</span>
            <span>Walmart</span>
            <span>Mac and Windows</span>
          </div>
        </div>

        <div className="performance-stage" aria-label="Zyn Target workspace">
          <div className="performance-halo" aria-hidden="true" />
          <figure className="product-shot">
            <Image
              src="/screenshots/zyn-target.png"
              alt="Zyn Target task group with accounts, proxies, and live drop counts"
              width={1600}
              height={1000}
              unoptimized
              priority
            />
          </figure>
          <div className="performance-tag tag-native"><span>Retailers</span><strong>Target · PCUS · Walmart</strong></div>
          <div className="performance-tag tag-confirmed"><span>Desktop</span><strong>Mac + Windows</strong></div>
        </div>
      </section>

      <section className="feature-section" id="features">
        <div className="feature-intro">
          <p className="kicker">On a drop</p>
          <h2>What you actually use.</h2>
          <p>
            Three retailers, one workspace. Watch the products you want, keep the proxies that work,
            and see carts, submits, and checkouts as they happen.
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

      <section className="gallery-section" id="product">
        <div className="feature-intro">
          <p className="kicker">Inside the app</p>
          <h2>ZynAIO in the wild.</h2>
          <p>
            Target groups, cookie harvest, Pokémon Center queues, Walmart login-first tasks,
            plus the profiles and proxies that back every run.
          </p>
        </div>
        <div className="product-gallery">
          {shots.map((shot) => (
            <figure className="gallery-card" key={shot.src}>
              <Image src={shot.src} alt={shot.title} width={1600} height={1000} unoptimized />
              <figcaption>
                <strong>{shot.title}</strong>
                <span>{shot.copy}</span>
              </figcaption>
            </figure>
          ))}
        </div>
      </section>

      <section className="difference-section" id="why">
        <div className="difference-intro">
          <p className="kicker">Unlike most setups</p>
          <h2>ZynAIO is the whole drop in one place.</h2>
          <p>
            Most people pay for a different bot per store, then spend the drop switching windows.
            ZynAIO puts Target, Pokémon Center US, and Walmart on one desktop — with the Target
            tools you actually use mid-restock.
          </p>
        </div>
        <div className="difference-board" aria-label="How ZynAIO compares with typical setups">
          <div className="difference-head">
            <span>Typical setup</span>
            <span>ZynAIO</span>
          </div>
          {differences.map((row) => (
            <div className="difference-row" key={row.zynTitle}>
              <div>
                <small>Typical setup</small>
                <strong>{row.usualTitle}</strong>
                <p>{row.usual}</p>
              </div>
              <div>
                <small>ZynAIO</small>
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
          <div className="offer-topline"><span>ZynAIO license</span><em>Self-serve</em></div>
          <div className="offer-price"><strong>$100</strong><span>first two months</span></div>
          <ul>
            <li><i aria-hidden="true">01</i><span><strong>Target and Pokémon Center US</strong>Watch lists, proxies, and checkout for both retailers on Mac and Windows.</span></li>
            <li><i aria-hidden="true">02</i><span><strong>Walmart in the same app</strong>Log in on placeholder, then apply drop SKUs to waiting tasks.</span></li>
            <li><i aria-hidden="true">03</i><span><strong>$100 for two months</strong>Then $40 every month. Cancel from the billing email Stripe sends you.</span></li>
          </ul>
          <Link className="button button-primary offer-button" href="/buy">
            Buy Zyn <span aria-hidden="true">→</span>
          </Link>
          <p>Checkout is handled by Stripe. Existing invited accounts keep working.</p>
        </div>
      </section>

      <footer className="home-footer">
        <a className="brand" href="#top"><BrandMark size={38} /></a>
        <p>ZynAIO — Target, Pokémon Center US, and Walmart checkout.</p>
        <div><a href="mailto:hello@zynbot.app">Contact</a><span>© {new Date().getFullYear()} Zyn</span></div>
      </footer>
    </main>
  );
}
