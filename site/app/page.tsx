import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";

const iconProps = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: "1.75",
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

const retailers: { name: string; kind: string; copy: string }[] = [
  {
    name: "Target",
    kind: "Checkout",
    copy: "Task groups, a shared watch list, cookie harvest, and a live drop overview. Start All when the drop opens.",
  },
  {
    name: "Pokémon Center US",
    kind: "Checkout",
    copy: "Guest checkout from profiles. Wait for the queue, solve captcha when it appears, and apply SKUs to tasks already in line.",
  },
  {
    name: "Walmart",
    kind: "Checkout",
    copy: "One task per account. Log in on placeholder, then apply SKUs or raffle item IDs when they land.",
  },
  {
    name: "Costco",
    kind: "Queue farm",
    copy: "Farm the waiting room with unique proxy sessions. On pass, a browser opens on that same proxy so you can check out.",
  },
];

const harvestTelemetry = {
  icon: (
    <svg {...iconProps}>
      <path d="M4 19V5M4 19h16M8 15V9M12 15V7M16 15v-3" />
    </svg>
  ),
  title: "Harvest telemetry",
  copy: "Total proxy data, MB per hour, and bytes per cookie in one harvester drawer — plus download, upload estimate, and blocked assets. No other bot shows harvest data usage in one place.",
  stats: [
    { value: "Total", label: "proxy data" },
    { value: "MB/hr", label: "average rate" },
    { value: "/cookie", label: "bytes used" },
  ],
};

const features: { icon: ReactNode; title: string; copy: string }[] = [
  {
    icon: (
      <svg {...iconProps}>
        <circle cx="12" cy="12" r="8" />
        <circle cx="9.5" cy="10.5" r="1" fill="currentColor" stroke="none" />
        <circle cx="14" cy="9.5" r=".8" fill="currentColor" stroke="none" />
        <circle cx="13.5" cy="14" r="1" fill="currentColor" stroke="none" />
      </svg>
    ),
    title: "Cookie harvest",
    copy: "Bank Target Shape before go-time from this machine, extra PCs, or any Chromium extension. ATC+ uses less data.",
  },
  {
    icon: (
      <svg {...iconProps}>
        <rect x="5" y="7" width="14" height="12" rx="2" />
        <path d="M8 7V5.5a4 4 0 0 1 8 0V7" />
        <path d="M9 13h6" />
      </svg>
    ),
    title: "Walmart Draw",
    copy: "Raffle Entry logs in, sets address and payment, then enters the drawing. Use the item ID from the product page. Qty is how many entries to request.",
  },
  {
    icon: (
      <svg {...iconProps}>
        <path d="M4 8h16M4 12h16M4 16h10" />
        <circle cx="18" cy="16" r="2" />
      </svg>
    ),
    title: "Costco queues",
    copy: "Each task is one waiting-room session on its own proxy. On pass, a headed browser opens so you can check out.",
  },
  {
    icon: (
      <svg {...iconProps}>
        <circle cx="12" cy="12" r="8" />
        <path d="M12 8v4.2l3 1.8" />
      </svg>
    ),
    title: "Pokémon Center queues",
    copy: "Wait for the queue around the clock. Apply SKUs to tasks already in line. Captcha windows open when you need them.",
  },
  {
    icon: (
      <svg {...iconProps}>
        <circle cx="12" cy="12" r="8" />
        <path d="M3.5 12h17M12 4c2.4 2.4 3.6 5.1 3.6 8s-1.2 5.6-3.6 8c-2.4-2.4-3.6-5.1-3.6-8s1.2-5.6 3.6-8Z" />
      </svg>
    ),
    title: "Proxy tester",
    copy: "Paste a list, run a sample or full test, and see working percent plus latency. Assign the list to any site’s tasks.",
  },
  {
    icon: (
      <svg {...iconProps}>
        <path d="M8 14.5a3.5 3.5 0 1 1 0-7h1" />
        <path d="M9 11h8.5a2.5 2.5 0 0 1 0 5H16" />
        <circle cx="16.5" cy="13.5" r=".8" fill="currentColor" stroke="none" />
      </svg>
    ),
    title: "Login codes",
    copy: "Target and Walmart pull OTP from the profile mailbox or AYCD Inbox. If it misses, type the code on the task.",
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
    <main className="home-page pitch-page">
      <header className="site-header home-header">
        <a className="brand" href="#top" aria-label="ZynAIO home">
          <BrandMark />
        </a>
        <nav aria-label="Main navigation">
          <a href="#sites">Sites</a>
          <a href="#features">Features</a>
          <Link href="/guide">Guide</Link>
          <Link className="nav-cta" href="/buy">Buy Zyn</Link>
        </nav>
      </header>

      <section className="pitch" id="top">
        <div className="target-chip"><i aria-hidden="true" /> ZynAIO</div>
        <h1>Target, Pokémon Center, Walmart, and Costco.</h1>
        <p className="target-lede">
          Checkout on Target, Pokémon Center US, and Walmart. Costco waiting rooms in the same desktop app. Mac and Windows.
        </p>
        <div className="hero-actions">
          <Link className="button button-primary" href="/buy">
            Buy Zyn — $100 <span aria-hidden="true">→</span>
          </Link>
          <Link className="button button-secondary" href="/guide">
            How to run a drop
          </Link>
        </div>
        <p className="beta-promise">
          <strong>$100 for two months.</strong> Then $40 every month. Target and Pokémon Center US are included.
        </p>
        <div className="target-capabilities" aria-label="Supported retailers">
          <span>Target</span>
          <span>Pokémon Center US</span>
          <span>Walmart</span>
          <span>Costco</span>
        </div>
      </section>

      <section className="retailer-section" id="sites">
        <div className="feature-intro">
          <p className="kicker">Sites</p>
          <h2>What Zyn runs.</h2>
          <p>One workspace for profiles, accounts, and proxies. Each site has its own task page.</p>
        </div>
        <div className="retailer-grid">
          {retailers.map((retailer) => (
            <article className="retailer-card" key={retailer.name}>
              <span>{retailer.kind}</span>
              <h3>{retailer.name}</h3>
              <p>{retailer.copy}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="feature-section" id="features">
        <div className="feature-intro">
          <p className="kicker">Features</p>
          <h2>What’s in the app.</h2>
        </div>
        <div className="home-feature-grid">
          <article className="home-feature-card home-feature-spotlight">
            <span className="home-feature-icon">{harvestTelemetry.icon}</span>
            <div className="home-feature-spotlight-copy">
              <h3>{harvestTelemetry.title}</h3>
              <p>{harvestTelemetry.copy}</p>
            </div>
            <ul className="home-feature-metrics">
              {harvestTelemetry.stats.map((stat) => (
                <li key={stat.value}>
                  <strong>{stat.value}</strong>
                  <span>{stat.label}</span>
                </li>
              ))}
            </ul>
          </article>
          {features.map((feature) => (
            <article className="home-feature-card" key={feature.title}>
              <span className="home-feature-icon">{feature.icon}</span>
              <h3>{feature.title}</h3>
              <p>{feature.copy}</p>
            </article>
          ))}
        </div>
        <p className="home-feature-extra">Plus Discord webhooks for checkouts and declines.</p>
      </section>

      <section className="pitch-close">
        <Link className="button button-primary" href="/buy">
          Buy Zyn — $100 <span aria-hidden="true">→</span>
        </Link>
      </section>

      <footer className="home-footer">
        <a className="brand" href="#top"><BrandMark size={38} /></a>
        <p>ZynAIO — Target, Pokémon Center US, Walmart, and Costco.</p>
        <div>
          <Link href="/guide">Guide</Link>
          <Link href="/join">Waiting list</Link>
          <a href="mailto:hello@zynbot.app">Contact</a>
          <span>© {new Date().getFullYear()} Zyn</span>
        </div>
      </footer>
    </main>
  );
}
