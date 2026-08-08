import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Join the Zyn waiting list",
  description: "Join the Zyn waiting list to hear when desktop access is available.",
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
          <Image src="/rcart-symbol.png" alt="" width="44" height="44" />
          <span>Zyn</span>
        </Link>
        <nav aria-label="Waiting-list navigation"><Link href="/">Back to Zyn</Link></nav>
      </header>

      <section className="join-shell" aria-labelledby="join-title">
        <div className="join-orbit join-orbit-one" aria-hidden="true" />
        <div className="join-orbit join-orbit-two" aria-hidden="true" />
        <div className="join-card">
          <div className="status-pill"><span /> Private desktop access</div>
          {joined ? (
            <>
              <p className="kicker">Request received</p>
              <h1 id="join-title">You’re on the list.</h1>
              <p className="join-lede">We’ll use the email you submitted to send your private Zyn invitation when access is available.</p>
              <Link className="button button-secondary" href="/">Back to Zyn</Link>
            </>
          ) : (
            <>
              <p className="kicker">Zyn for desktop</p>
              <h1 id="join-title">Join the waiting list.</h1>
              <p className="join-lede">Leave your email and we’ll send a private download invitation when your Zyn access is ready.</p>
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
              <p className="join-note">One email is all we need. Submitting again simply keeps your existing place on the list.</p>
            </>
          )}
        </div>
      </section>

      <footer className="download-footer">
        <Link className="brand" href="/"><Image src="/rcart-symbol.png" alt="" width="38" height="38" /><span>Zyn</span></Link>
        <p>Precision retail operations.</p>
        <div><a href="mailto:hello@rcart.app">Contact</a><span>© {new Date().getFullYear()} Zyn</span></div>
      </footer>
    </main>
  );
}
