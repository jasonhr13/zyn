import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";

export const GUIDE_NAV = [
  { href: "/guide", label: "Get started" },
  { href: "/guide/install", label: "Install & sign in" },
  { href: "/guide/profiles", label: "Profiles" },
  { href: "/guide/accounts", label: "Accounts" },
  { href: "/guide/proxies", label: "Proxies" },
  { href: "/guide/target", label: "Target" },
  { href: "/guide/harvesters", label: "Cookie harvest" },
  { href: "/guide/pokemon-center", label: "Pokémon Center" },
  { href: "/guide/walmart", label: "Walmart" },
  { href: "/guide/costco", label: "Costco" },
  { href: "/guide/settings", label: "Before a drop" },
] as const;

export type GuideHref = (typeof GUIDE_NAV)[number]["href"];

export function guideMetadata(title: string, description: string) {
  return {
    title,
    description,
    openGraph: {
      title: `${title} — Zyn Guide`,
      description,
      url: "https://zynbot.app/guide",
      images: [{ url: "https://zynbot.app/og-aio.png", width: 1200, height: 630, alt: "ZynAIO" }],
    },
  };
}

function BrandMark({ size = 44 }: { size?: number }) {
  return (
    <>
      <Image src="/zyn-icon.png" alt="" width={size} height={size} unoptimized />
      <span>Zyn<span className="aio-mark">AIO</span></span>
    </>
  );
}

export function GuideShell({
  current,
  kicker,
  title,
  lede,
  children,
}: {
  current: GuideHref;
  kicker: string;
  title: string;
  lede: string;
  children: ReactNode;
}) {
  const index = GUIDE_NAV.findIndex((item) => item.href === current);
  const previous = index > 0 ? GUIDE_NAV[index - 1] : null;
  const next = index >= 0 && index < GUIDE_NAV.length - 1 ? GUIDE_NAV[index + 1] : null;

  return (
    <main className="guide-page">
      <header className="site-header">
        <Link className="brand" href="/" aria-label="Zyn home">
          <BrandMark />
        </Link>
        <nav aria-label="Main navigation">
          <Link href="/guide">Guide</Link>
          <Link className="nav-cta" href="/buy">Buy Zyn</Link>
        </nav>
      </header>

      <div className="guide-body">
        <aside className="guide-sidebar">
          <p className="guide-sidebar-kicker">User guide</p>
          <nav aria-label="Guide sections">
            {GUIDE_NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={item.href === current ? "active" : undefined}
                aria-current={item.href === current ? "page" : undefined}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </aside>

        <article className="guide-article">
          <p className="kicker">{kicker}</p>
          <h1>{title}</h1>
          <p className="guide-lede">{lede}</p>
          <div className="guide-prose">{children}</div>
          <nav className="guide-pager" aria-label="Adjacent guide pages">
            {previous ? <Link href={previous.href} className="guide-pager-link">← {previous.label}</Link> : <span />}
            {next ? <Link href={next.href} className="guide-pager-link">{next.label} →</Link> : <span />}
          </nav>
        </article>
      </div>

      <footer className="home-footer">
        <Link className="brand" href="/"><BrandMark size={38} /></Link>
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

export function Callout({
  tone = "note",
  title,
  children,
}: {
  tone?: "note" | "warn" | "tip";
  title?: string;
  children: ReactNode;
}) {
  return (
    <aside className={`guide-callout guide-callout-${tone}`} role={tone === "warn" ? "note" : undefined}>
      {title ? <strong className="guide-callout-title">{title}</strong> : null}
      <div>{children}</div>
    </aside>
  );
}

export function Steps({ children }: { children: ReactNode }) {
  return <ol className="guide-steps">{children}</ol>;
}

export function Fields({ rows }: { rows: { label: string; detail: ReactNode }[] }) {
  return (
    <dl className="guide-fields">
      {rows.map((row) => (
        <div key={row.label}>
          <dt>{row.label}</dt>
          <dd>{row.detail}</dd>
        </div>
      ))}
    </dl>
  );
}
