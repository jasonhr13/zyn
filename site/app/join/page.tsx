import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Join the Zyn private beta",
  description: "Request a free private beta seat for Target, Pokémon Center US, Walmart, and Costco. When Zyn goes live, testers skip the $200 start and pay $40 a month.",
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
        <nav aria-label="Private beta navigation"><Link href="/">Back to Zyn</Link></nav>
      </header>

      <section className="join-shell" aria-labelledby="join-title">
        <div className="join-orbit join-orbit-one" aria-hidden="true" />
        <div className="join-orbit join-orbit-two" aria-hidden="true" />
        <div className="join-card">
          <div className="status-pill"><span /> Private beta</div>
          {joined ? (
            <>
              <p className="kicker">Request received</p>
              <h1 id="join-title">You’re on the list.</h1>
              <p className="join-lede">
                We’ll email when a free seat opens. When Zyn goes live, testers skip the $200 start and pay $40 a month.
              </p>
            </>
          ) : (
            <>
              <p className="kicker">ZynAIO</p>
              <h1 id="join-title">Join the private beta.</h1>
              <p className="join-lede">
                The beta is free. Leave your email for a seat. When Zyn goes live, you skip the $200 start and go straight to $40 a month.
              </p>
              <form className="join-form" action="/api/waitlist" method="post">
                <label htmlFor="waitlist-email">Email address</label>
                <div className="join-form-row">
                  <input id="waitlist-email" name="email" type="email" maxLength={254} autoComplete="email" placeholder="you@example.com" required />
                  <button className="button button-primary" type="submit">Request a seat <span aria-hidden="true">→</span></button>
                </div>
                <div className="form-trap" aria-hidden="true">
                  <label htmlFor="waitlist-company">Company</label>
                  <input id="waitlist-company" name="company" type="text" tabIndex={-1} autoComplete="off" />
                </div>
              </form>
              {error === "email" && <p className="join-error" role="alert">Enter a valid email address.</p>}
              {error === "service" && <p className="join-error" role="alert">The private beta list is temporarily unavailable. Please try again.</p>}
            </>
          )}
        </div>
      </section>

      <footer className="download-footer">
        <Link className="brand" href="/"><Image src="/zyn-icon.png" alt="" width="38" height="38" unoptimized /><span>Zyn</span></Link>
        <p>ZynAIO — Target, Pokémon Center US, Walmart, and Costco.</p>
        <div><a href="mailto:hello@zynbot.app">Contact</a><span>© {new Date().getFullYear()} Zyn</span></div>
      </footer>
    </main>
  );
}
