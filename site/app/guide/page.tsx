import Link from "next/link";
import { GuideShell, Steps, guideMetadata } from "./guide";

export const metadata = guideMetadata(
  "How to use Zyn",
  "Set up profiles, accounts, and proxies, then run Target, Walmart, Pokémon Center US, and Costco drops in Zyn.",
);

export default function GuideHomePage() {
  return (
    <GuideShell
      current="/guide"
      kicker="Zyn guide"
      title="Run drops with Zyn."
      lede="Set up your workspace once, then use the same flow for every drop: products, tasks, proxies, Start All."
    >
      <h2>Before the first drop</h2>
      <Steps>
        <li><Link href="/guide/install">Install Zyn</Link> and sign in on the machine that will run checkout.</li>
        <li>Wait for <strong>Finishing Zyn setup</strong> at the top of the window. You can add profiles while it downloads.</li>
        <li>Create <Link href="/guide/profiles">profiles</Link> — shipping, payment, and a mailbox for Target/Walmart login codes.</li>
        <li>Paste <Link href="/guide/accounts">accounts</Link> as <code>email:password</code>. Use the same email as the profile.</li>
        <li>Add <Link href="/guide/proxies">proxy lists</Link> and assign them to tasks. Target’s monitor should not use Local IP.</li>
      </Steps>

      <h2>Then run the site</h2>
      <div className="guide-card-grid">
        <Link href="/guide/target">
          <span>Target</span>
          <strong>Task groups</strong>
          <p>Watch list, accounts, harvest cookies, Start All.</p>
        </Link>
        <Link href="/guide/walmart">
          <span>Walmart</span>
          <strong>Login, then SKUs</strong>
          <p>One task per account. Placeholder first, apply products when they land.</p>
        </Link>
        <Link href="/guide/pokemon-center">
          <span>Pokémon Center US</span>
          <strong>Guest checkout</strong>
          <p>Profiles only. Queue wait, captcha, Apply to all tasks.</p>
        </Link>
        <Link href="/guide/costco">
          <span>Costco</span>
          <strong>Queue farm</strong>
          <p>Waiting-room URL + proxies. A browser opens on pass so you can check out.</p>
        </Link>
      </div>
    </GuideShell>
  );
}
