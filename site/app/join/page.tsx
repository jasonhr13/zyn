import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Join the Zyn waiting list",
  description: "Join the Zyn waiting list for Target and Pokémon Center US checkout automation.",
};

type SearchParams = Promise<{ joined?: string | string[]; error?: string | string[] }>;

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function JoinPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const joined = first(params.joined) === "1";
  const error = first(params.error);

  return (
    <main className="join-page">
      <header className="site-header">
        <Link className="brand" href="/" aria-label="Zyn home">
          <Image src="/zyn-icon.png" alt="" width="44" height="44" unoptimized />
          <span>Zyn</span>
        </Link>
        <nav aria-label="Waiting-list navigation"><Link href="/">Back to Zyn</Link></nav>
      </header>

      <section className="join-shell" aria-labelledby="join-title">
        <div className="join-orbit join-orbit-one" aria-hidden="true" />
        <div className="join-orbit join-orbit-two" aria-hidden="true" />
        <div className="join-card">
          <div className="status-pill"><span /> Waiting list</div>
          {joined ? (
            <>
              <p className="kicker">Request received</p>
              <h1 id="join-title">You’re on the list.</h1>
              <p className="join-lede">We’ll email if a seat opens. You can also buy Zyn now for Target and Pokémon Center US.</p>
              <Link className="button button-primary" href="/buy">Buy Zyn</Link>
            </>
          ) : (
            <>
              <p className="kicker">Target and Pokémon Center US</p>
              <h1 id="join-title">Join the waiting list.</h1>
              <p className="join-lede">Prefer an invite instead of buying now? Leave your email. Zyn supports Target and Pokémon Center US.</p>
              <form className="join-form" action="/api/waitlist" method="post">
                <label htmlFor="waitlist-email">Email address</label>
                <div className="join-form-row">
                  <input id="waitlist-email" name="email" type="email" maxLength={254} autoComplete="email" placeholder="you@example.com" required />
                  <button className="button button-primary" type="submit">Join waiting list <span aria-hidden="true">→</span></button>
                </div>
                <div className="form-trap" aria-hidden="true">
                  <label htmlFor="waitlist-company">Company</label>
                  <input id="waitlist-company" name="company" type="text" tabIndex={-1} autoComplete="off" />
                </div>
              </form>
              {error === "email" && <p className="join-error" role="alert">Enter a valid email address.</p>}
              {error === "service" && <p className="join-error" role="alert">The waiting list is temporarily unavailable. Please try again.</p>}
              <p className="join-note">No payment required to join the list. To start immediately, <Link href="/buy">buy Zyn</Link> for $100.</p>
            </>
          )}
        </div>
      </section>

      <footer className="download-footer">
        <Link className="brand" href="/"><Image src="/zyn-icon.png" alt="" width="38" height="38" unoptimized /><span>Zyn</span></Link>
        <p>Target and Pokémon Center US checkout automation.</p>
        <div><a href="mailto:hello@zynbot.app">Contact</a><span>© {new Date().getFullYear()} Zyn</span></div>
      </footer>
    </main>
  );
}
