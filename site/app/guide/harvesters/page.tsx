import { Callout, Fields, GuideShell, Steps, guideMetadata } from "../guide";

export const metadata = guideMetadata(
  "Cookie harvest",
  "Bank Target Shape cookies from in-app harvesters, the Zyn Harvester extension, or a paired phone.",
);

export default function GuideHarvestersPage() {
  return (
    <GuideShell
      current="/guide/harvesters"
      kicker="Target"
      title="Cookie harvest."
      lede="Target checkout spends banked Shape cookies. Fill the bank before the drop with in-app harvesters, a Chromium extension, a phone, or a Harvester-only Zyn on another machine."
    >
      <h2>What the bank is</h2>
      <p>
        Full Engine Target shows <strong>Login</strong> and <strong>ATC</strong> counts. Checkout tasks pull from this pool.
        Harvest-only machines do not keep a local bank for tasks — they send cookies to Full Engine.
      </p>

      <h2>In-app harvesters</h2>
      <p>
        On Full Engine, open the harvester drawer on Target. On Harvester only, the Target item is <strong>Harvesters</strong>.
        <strong>New Harvester</strong> / <strong>Create Cookie Harvester</strong>. Set <strong>ATC mode</strong> to <strong>ATC+</strong>.
      </p>
      <Callout tone="tip" title="ATC+ is the default you want">
        <p>
          ATC+ uses less data than Standard and harvests at or above that mode. Leave Standard only if you have a reason to load the live Target product page.
        </p>
      </Callout>
      <Fields
        rows={[
          { label: "Type", detail: "Target ATC, or Automatic (Login + ATC). ATC uses the product rotation. Login starts automatically when a task needs to sign in." },
          { label: "Browser", detail: "Automatic pool, or Chrome, Edge, Brave, Vivaldi, Yandex, Opera, Bundled Chromium." },
          { label: "Mode", detail: "Default, or Experimental (Zyn opens the browser and assigns the proxy — you do not set up Chrome profiles or an extension)." },
          { label: "ATC mode", detail: "Use ATC+. It uses less proxy data and performs at or above Standard (live Target product page)." },
          { label: "Harvest products", detail: "Leave blank for the built-in rotation, or paste TCINs / product links. Use cheap, always-in-stock items if you customize this." },
          { label: "Proxy / Workers", detail: "Local is capped at 2 workers. A proxy list allows up to 100 (login harvesters up to 20)." },
          { label: "Cookie TTL / Interval / Refresh every", detail: "Lifetime in seconds, pause between attempts, and successful harvests before a fresh browser (default 3)." },
          { label: "Start / Stop Schedule", detail: "Optional. Saving never starts a harvester. Click Start to arm it; a future schedule waits after that." },
        ]}
      />
      <p>
        The harvester drawer shows <strong>Proxy bandwidth</strong> for the current runs: total proxy data, average rate, bytes per cookie, download vs estimated upload, plus request counts and blocked heavy assets. It is the live data-usage view for harvest in one place — not a guess from your provider dashboard.
      </p>
      <p>
        <strong>Login harvester</strong> on Target starts automatically when a task needs to sign in and stops when Shape and OTP waits are finished. Set its proxy and workers there.
      </p>

      <h2>Harvester-only machines</h2>
      <p>
        Sign in as <strong>Harvester only</strong> on extra PCs. They farm cookies and show <strong>Sending cookies to Full Engine</strong> when the checkout machine is online.
        Use <strong>Reconnect</strong> if the room drops.
      </p>

      <h2>Browser extension</h2>
      <p>
        Download <a href="https://updates.zynbot.app/download/extension">updates.zynbot.app/download/extension</a>.
        It works in any Chromium browser. Load it in a dedicated profile — not the one you use for everyday browsing.
      </p>
      <Steps>
        <li>Extract the ZIP into a permanent folder named <code>Zyn-Harvester</code> so <code>manifest.json</code> is at the top of that folder.</li>
        <li>Open the extensions page → Developer mode → Load unpacked → that folder.</li>
        <li>Copy the 32-character ID under Zyn Harvester.</li>
        <li>Zyn <strong>Settings → Target — Browser Extension Harvesters</strong>: set harvesting to On, paste one ID per line, Save Settings.</li>
        <li>Extension popup → Connection should show <strong>Live</strong>. Start Harvesting.</li>
      </Steps>
      <p>
        Updates: extract the new ZIP over the same folder and click Reload. Do not move the folder — Chromium derives the ID from the path.
      </p>
      <p>
        To harvest from a browser that does not have Zyn installed, open the popup → <strong>Remote cookie bank</strong> and sign in with the same Zyn email and password. Connection is Live while Full Engine is signed in on the checkout machine.
      </p>
      <Callout tone="warn" title="Dedicated profile only">
        <p>
          The extension drives the browser, can change proxy settings, and should not run in a profile you use for normal Target shopping.
          Stop harvesting and close that profile before browsing Target yourself.
        </p>
      </Callout>

      <h2>Mobile harvesters</h2>
      <p>
        Settings → <strong>Target — Mobile Harvesters</strong>. Enable mobile harvesting, then <strong>Generate pairing code</strong>.
        Scan the QR in the phone app, or paste the pairing URL into the extension under Remote cookie bank.
      </p>
      <p>
        Android APK: <a href="https://updates.zynbot.app/download/android">updates.zynbot.app/download/android</a>.
        iOS is TestFlight / ad-hoc, not the App Store. Managed proxies stay on the desktop; the phone only uses user-owned lists you choose there.
      </p>
      <p>Devices reconnect whenever this Full Engine Zyn is open. Reset pairing invalidates the current code.</p>
    </GuideShell>
  );
}
