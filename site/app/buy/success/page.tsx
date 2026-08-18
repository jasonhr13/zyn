import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { headers } from "next/headers";
import { serviceOriginForHostname } from "../../domain";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Zyn purchase complete",
  description: "Your Zyn license is ready.",
  robots: { index: false, follow: false },
};

type SearchParams = Promise<{ session_id?: string | string[] }>;

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

async function loadClaim(licenseOrigin: string, sessionId: string) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const response = await fetch(`${licenseOrigin}/api/billing/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId }),
        cache: "no-store",
      });
      if (response.ok) return await response.json() as {
        ok?: boolean;
        email?: string;
        createdNewUser?: boolean;
        temporaryPassword?: string;
        downloadUrl?: string;
        claimed?: boolean;
      };
      if (response.status !== 404) return null;
    } catch {
      // Stripe can finish the redirect before the webhook writes the claim.
    }
    await new Promise(resolve => setTimeout(resolve, 400 * (attempt + 1)));
  }
  return null;
}

export default async function BuySuccessPage({ searchParams }: { searchParams: SearchParams }) {
  const sessionId = first((await searchParams).session_id) || "";
  const hostname = (await headers()).get("x-forwarded-host") || (await headers()).get("host") || "zynbot.app";
  const licenseOrigin = process.env.ZYN_LICENSE_ORIGIN
    || process.env.RCART_LICENSE_ORIGIN
    || serviceOriginForHostname(hostname.split(":")[0], "license");
  const claim = sessionId.startsWith("cs_") ? await loadClaim(licenseOrigin, sessionId) : null;

  return (
    <main className="buy-page">
      <header className="site-header">
        <Link className="brand" href="/" aria-label="Zyn home">
          <Image src="/zyn-icon.png" alt="" width="44" height="44" unoptimized />
          <span>Zyn</span>
        </Link>
        <nav aria-label="Purchase navigation"><Link href="/">Back to Zyn</Link></nav>
      </header>

      <section className="join-shell" aria-labelledby="success-title">
        <div className="join-card">
          <div className="status-pill"><span /> Payment received</div>
          <p className="kicker">You are in</p>
          <h1 id="success-title">Zyn is ready.</h1>
          {claim?.ok ? (
            <>
              <p className="join-lede">
                {claim.createdNewUser
                  ? `We created ${claim.email}. Sign in on the desktop app, then set a new password.`
                  : `This purchase is on ${claim.email}. Sign in with your existing Zyn password.`}
              </p>
              {claim.temporaryPassword ? (
                <p className="buy-secret" tabIndex={0}>
                  <span>One-time password</span>
                  <strong>{claim.temporaryPassword}</strong>
                </p>
              ) : null}
              {claim.downloadUrl ? (
                <a className="button button-primary" href={claim.downloadUrl}>
                  Open your download link <span aria-hidden="true">→</span>
                </a>
              ) : (
                <p className="join-note">Your download invitation is also available from the license admin if this page does not show one.</p>
              )}
            </>
          ) : (
            <p className="join-lede">
              Stripe collected the payment. If this page does not show an account yet, wait a moment
              and refresh, or email hello@zynbot.app with the receipt.
            </p>
          )}
        </div>
      </section>
    </main>
  );
}
