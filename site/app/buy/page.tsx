import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Buy Zyn",
  description: "Get ZynAIO for Target, Pokémon Center US, and Walmart. $100 for the first two months, then $40 every month.",
};

type SearchParams = Promise<{ error?: string | string[] }>;

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function BuyPage({ searchParams }: { searchParams: SearchParams }) {
  const error = first(await searchParams);

  return (
    <main className="buy-page">
      <header className="site-header">
        <Link className="brand" href="/" aria-label="Zyn home">
          <Image src="/zyn-icon.png" alt="" width="44" height="44" unoptimized />
          <span>Zyn</span>
        </Link>
        <nav aria-label="Purchase navigation"><Link href="/">Back to Zyn</Link></nav>
      </header>

      <section className="buy-shell" aria-labelledby="buy-title">
        <div className="join-orbit join-orbit-one" aria-hidden="true" />
        <div className="join-orbit join-orbit-two" aria-hidden="true" />
        <div className="buy-layout">
          <article className="buy-card">
            <div className="status-pill"><span /> Self-serve license</div>
            <p className="kicker">ZynAIO</p>
            <h1 id="buy-title">Buy Zyn.</h1>
            <p className="join-lede">
              $100 covers the first two months. After that Stripe renews the license at $40 every month.
              Target and Pokémon Center US are included.
            </p>
            <form className="join-form" action="/api/checkout" method="post">
              <label htmlFor="checkout-email">Email address</label>
              <div className="join-form-row">
                <input
                  id="checkout-email"
                  name="email"
                  type="email"
                  maxLength={254}
                  autoComplete="email"
                  placeholder="you@example.com"
                  required
                />
                <button className="button button-primary" type="submit">
                  Continue to Stripe <span aria-hidden="true">→</span>
                </button>
              </div>
              <div className="form-trap" aria-hidden="true">
                <label htmlFor="checkout-company">Company</label>
                <input id="checkout-company" name="company" type="text" tabIndex={-1} autoComplete="off" />
              </div>
            </form>
            {error === "email" && <p className="join-error" role="alert">Enter a valid email address.</p>}
            {error === "service" && <p className="join-error" role="alert">Checkout is temporarily unavailable. Please try again.</p>}
            <p className="join-note">
              Stripe collects the card. If this email is new, Zyn creates the account after payment
              and shows a one-time password on the next page.
            </p>
          </article>

          <aside className="buy-summary" aria-label="What you get">
            <div className="offer-topline"><span>Zyn license</span><em>$40 / month after</em></div>
            <div className="offer-price"><strong>$100</strong><span>first two months</span></div>
            <ul>
              <li><i aria-hidden="true">01</i><span><strong>Target checkout</strong>Watch lists, accounts, proxies, and live drop counts.</span></li>
              <li><i aria-hidden="true">02</i><span><strong>Pokémon Center US</strong>Included on the same license. No extra module fee.</span></li>
              <li><i aria-hidden="true">03</i><span><strong>Walmart in the same app</strong>Log in on placeholder, then apply drop SKUs when they land.</span></li>
            </ul>
          </aside>
        </div>
      </section>

      <footer className="download-footer">
        <Link className="brand" href="/"><Image src="/zyn-icon.png" alt="" width="38" height="38" unoptimized /><span>Zyn</span></Link>
        <p>ZynAIO — Target, Pokémon Center US, and Walmart checkout.</p>
        <div><a href="mailto:hello@zynbot.app">Contact</a><span>© {new Date().getFullYear()} Zyn</span></div>
      </footer>
    </main>
  );
}
