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

const features: { icon: ReactNode; title: string; copy: string }[] = [
  {
    icon: (
      <svg {...iconProps}>
        <rect x="4" y="4" width="16" height="5" rx="1.2" />
        <rect x="4" y="10.5" width="16" height="5" rx="1.2" />
        <rect x="4" y="17" width="16" height="3" rx="1.2" />
      </svg>
    ),
    title: "Task Groups",
    copy: "Run, edit, or stop hundreds of tasks together.",
  },
  {
    icon: (
      <svg {...iconProps}>
        <circle cx="12" cy="12" r="8" />
        <path d="M12 8v4.2l3 1.8" />
      </svg>
    ),
    title: "Scheduled Tasks",
    copy: "Start groups on a schedule so they fire when a drop opens.",
  },
  {
    icon: (
      <svg {...iconProps}>
        <path d="M8 14.5a3.5 3.5 0 1 1 0-7h1" />
        <path d="M9 11h8.5a2.5 2.5 0 0 1 0 5H16" />
        <circle cx="16.5" cy="13.5" r=".8" fill="currentColor" stroke="none" />
      </svg>
    ),
    title: "2FA Handling",
    copy: "Pulls login codes from your inbox so checkout does not stall.",
  },
  {
    icon: (
      <svg {...iconProps}>
        <circle cx="12" cy="12" r="8" />
        <circle cx="9.5" cy="10.5" r="1" fill="currentColor" stroke="none" />
        <circle cx="14" cy="9.5" r=".8" fill="currentColor" stroke="none" />
        <circle cx="13.5" cy="14" r="1" fill="currentColor" stroke="none" />
      </svg>
    ),
    title: "Cookie Harvest",
    copy: "Bank Shape before the drop.",
  },
  {
    icon: (
      <svg {...iconProps}>
        <circle cx="12" cy="12" r="8" />
        <path d="M3.5 12h17M12 4c2.4 2.4 3.6 5.1 3.6 8s-1.2 5.6-3.6 8c-2.4-2.4-3.6-5.1-3.6-8s1.2-5.6 3.6-8Z" />
      </svg>
    ),
    title: "Proxy Support",
    copy: "Assign proxy lists to groups and tasks.",
  },
  {
    icon: (
      <svg {...iconProps}>
        <rect x="6" y="11" width="12" height="9" rx="2" />
        <path d="M9 11V8a3 3 0 0 1 6 0v3" />
      </svg>
    ),
    title: "Local & Secure",
    copy: "Accounts, payments, and proxies stay on your device.",
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
          <a href="#features">Features</a>
          <Link className="nav-cta" href="/buy">Buy Zyn</Link>
        </nav>
      </header>

      <section className="pitch" id="top">
        <div className="target-chip"><i aria-hidden="true" /> ZynAIO</div>
        <h1>Retail automation for Target, Pokémon Center, and Walmart.</h1>
        <p className="target-lede">
          Top-tier checkout on the three sites that matter. One desktop app. Mac and Windows.
        </p>
        <div className="hero-actions">
          <Link className="button button-primary" href="/buy">
            Buy Zyn — $100 <span aria-hidden="true">→</span>
          </Link>
        </div>
        <p className="beta-promise">
          <strong>$100 for two months.</strong> Then $40 every month. Target and Pokémon Center US are included.
        </p>
        <div className="target-capabilities" aria-label="Supported retailers">
          <span>Target</span>
          <span>Pokémon Center US</span>
          <span>Walmart</span>
        </div>
      </section>

      <section className="feature-section" id="features">
        <div className="feature-intro">
          <p className="kicker">Features</p>
          <h2>What’s in the app.</h2>
        </div>
        <div className="home-feature-grid">
          {features.map((feature) => (
            <article className="home-feature-card" key={feature.title}>
              <span className="home-feature-icon">{feature.icon}</span>
              <h3>{feature.title}</h3>
              <p>{feature.copy}</p>
            </article>
          ))}
        </div>
        <p className="home-feature-extra">Plus Discord webhooks, queue handling, and multi-account.</p>
      </section>

      <section className="pitch-close">
        <Link className="button button-primary" href="/buy">
          Buy Zyn — $100 <span aria-hidden="true">→</span>
        </Link>
      </section>

      <footer className="home-footer">
        <a className="brand" href="#top"><BrandMark size={38} /></a>
        <p>ZynAIO — Target, Pokémon Center US, and Walmart.</p>
        <div>
          <Link href="/join">Waiting list</Link>
          <a href="mailto:hello@zynbot.app">Contact</a>
          <span>© {new Date().getFullYear()} Zyn</span>
        </div>
      </footer>
    </main>
  );
}
