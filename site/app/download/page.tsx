import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { cookies, headers } from "next/headers";
import { serviceOriginForHostname } from "../domain";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Download Zyn",
  description: "Choose the Zyn desktop build for your Mac or Windows PC.",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

const DOWNLOAD_COOKIE = "rcart_download";

type SearchParams = Promise<{ key?: string | string[]; error?: string | string[] }>;

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

async function hasDownloadSession(licenseOrigin: string) {
  const sessionToken = (await cookies()).get(DOWNLOAD_COOKIE)?.value;
  if (!sessionToken) return false;
  try {
    const response = await fetch(`${licenseOrigin}/api/download/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionToken }),
      cache: "no-store",
    });
    return response.ok && Boolean((await response.json() as { ok?: boolean }).ok);
  } catch {
    return false;
  }
}

function DownloadHeader() {
  return (
    <header className="site-header download-header">
      <Link className="brand" href="/download" aria-label="Zyn downloads">
        <Image src="/zyn-icon.png" alt="" width="44" height="44" unoptimized />
        <span>Zyn</span>
      </Link>
      <nav aria-label="Download navigation"><a href="mailto:hello@rcart.app?subject=Zyn%20install%20help">Install help</a></nav>
    </header>
  );
}

function DownloadFooter() {
  return (
    <footer className="download-footer">
      <Link className="brand" href="/download"><Image src="/zyn-icon.png" alt="" width="38" height="38" unoptimized /><span>Zyn</span></Link>
      <p>Private desktop distribution.</p>
      <div><a href="mailto:hello@rcart.app?subject=Zyn%20support">Need help?</a><span>© {new Date().getFullYear()} Zyn</span></div>
    </footer>
  );
}

function LockedDownload({ accessKey, error }: { accessKey?: string; error?: string }) {
  const invalid = error === "invalid";
  const rateLimited = error === "rate-limited";
  const serviceError = error === "service";
  const hasKey = Boolean(accessKey) && !invalid;
  const title = invalid ? "That link is no longer available."
    : hasKey ? "Your private download is ready."
      : "A private link is required.";
  const body = invalid
    ? "Download links can be unlocked once and expire after seven days. Ask your Zyn administrator for a new link."
    : rateLimited
      ? "Too many attempts were made from this connection. Wait a few minutes, then unlock again."
      : serviceError
        ? "The download service could not be reached. Return to your original link and try again in a moment."
        : hasKey
          ? "Unlock this link once in this browser to choose your operating system. Automated link previews cannot consume it."
          : "Zyn downloads are issued to active accounts. Use the single-use link sent by your administrator.";

  return (
    <section className="download-gate" aria-labelledby="download-title">
      <div className="download-halo" aria-hidden="true" />
      <div className="download-gate-card">
        <div className="status-pill"><span /> Private distribution</div>
        <p className="kicker">Zyn for desktop</p>
        <h1 id="download-title">{title}</h1>
        <p className="download-lede">{body}</p>
        {hasKey ? (
          <form action="/api/download/redeem" method="post" className="download-unlock-form">
            <input type="hidden" name="key" value={accessKey} />
            <button className="button button-primary download-submit" type="submit">
              Unlock downloads <span aria-hidden="true">→</span>
            </button>
          </form>
        ) : (
          <a className="button button-secondary" href="mailto:hello@rcart.app?subject=Zyn%20download%20access">
            Request a new link
          </a>
        )}
        <div className="download-trust-row">
          <span>One-time key</span><span>24-hour browser access</span><span>No account password in the link</span>
        </div>
      </div>
    </section>
  );
}

function DownloadChooser({ updateOrigin }: { updateOrigin: string }) {
  return (
    <section className="download-chooser" aria-labelledby="download-title">
      <div className="download-intro">
        <div>
          <p className="kicker">Access confirmed</p>
          <h1 id="download-title">Choose your operating system.</h1>
        </div>
        <p>Apple silicon and Intel Macs use separate Zyn update feeds, so each Mac always receives the correct native build.</p>
      </div>

      <div className="os-grid">
        <article className="os-card">
          <div className="os-card-top">
            <div className="os-mark" aria-hidden="true">arm</div>
            <span className="os-availability"><i /> Available</span>
          </div>
          <p className="os-label">Apple silicon</p>
          <h2>macOS</h2>
          <p>For M-series Apple silicon Macs running macOS 12 or newer.</p>
          <ul>
            <li>Dedicated ARM64 Zyn updates</li>
            <li>Verified runtime downloads securely after sign-in</li>
            <li>DMG installer</li>
          </ul>
          <a className="button button-primary os-download" href={`${updateOrigin}/download/mac/arm64`}>
            Download for Apple silicon <span aria-hidden="true">↓</span>
          </a>
        </article>

        <article className="os-card">
          <div className="os-card-top">
            <div className="os-mark intel-mark" aria-hidden="true">x64</div>
            <span className="os-availability"><i /> Available</span>
          </div>
          <p className="os-label">Intel processor</p>
          <h2>macOS</h2>
          <p>For Intel-based Macs running macOS 12 or newer, with native Intel Electron and Chromium binaries.</p>
          <ul>
            <li>Dedicated Intel Zyn updates</li>
            <li>Verified runtime downloads securely after sign-in</li>
            <li>DMG installer</li>
          </ul>
          <a className="button button-primary os-download" href={`${updateOrigin}/download/mac/x64`}>
            Download for Intel Mac <span aria-hidden="true">↓</span>
          </a>
        </article>

        <article className="os-card">
          <div className="os-card-top">
            <div className="os-mark windows-mark" aria-hidden="true">win</div>
            <span className="os-availability preview"><i /> Preview</span>
          </div>
          <p className="os-label">64-bit</p>
          <h2>Windows</h2>
          <p>For 64-bit PCs running Windows 10 or 11. The current preview is unsigned while publisher verification is completed.</p>
          <ul>
            <li>Automatic Zyn updates</li>
            <li>Managed Chromium and native checkout runtime</li>
            <li>NSIS setup installer</li>
          </ul>
          <a className="button button-secondary os-download" href={`${updateOrigin}/download/windows`}>
            Download for Windows <span aria-hidden="true">↓</span>
          </a>
          <p className="os-caution">Windows SmartScreen may ask you to confirm the first install.</p>
        </article>
      </div>

      <div className="download-support">
        <span>Not sure which Mac you have? Open Apple menu → About This Mac.</span>
        <a href="mailto:hello@rcart.app?subject=Zyn%20install%20help">Installation help →</a>
      </div>
    </section>
  );
}

export default async function DownloadPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const requestHeaders = await headers();
  const hostname = requestHeaders.get("x-forwarded-host") || requestHeaders.get("host") || "rcart.app";
  const licenseOrigin = process.env.ZYN_LICENSE_ORIGIN
    || process.env.RCART_LICENSE_ORIGIN
    || serviceOriginForHostname(hostname, "license");
  const updateOrigin = serviceOriginForHostname(hostname, "updates");
  const authorized = await hasDownloadSession(licenseOrigin);
  const accessKey = first(params.key);
  const error = first(params.error);

  return (
    <main className="download-page">
      <DownloadHeader />
      {authorized ? <DownloadChooser updateOrigin={updateOrigin} /> : <LockedDownload accessKey={accessKey} error={error} />}
      <DownloadFooter />
    </main>
  );
}
