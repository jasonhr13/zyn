import Link from "next/link";
import { Fields, GuideShell, guideMetadata } from "../guide";

export const metadata = guideMetadata(
  "Before a drop",
  "Discord pings, login-code mailboxes, and Pokémon Center captcha — the Settings that matter before you Start All.",
);

export default function GuideSettingsPage() {
  return (
    <GuideShell
      current="/guide/settings"
      kicker="Setup"
      title="Before a drop."
      lede="A few Settings items to fill in once. Everything else for a drop lives on Profiles, Accounts, Proxies, and the site page."
    >
      <h2>Discord</h2>
      <p>Settings → Discord. Paste webhook URLs and Save Settings.</p>
      <Fields
        rows={[
          { label: "Success Webhook URL", detail: "Confirmed orders." },
          { label: "Declined Webhook URL", detail: "Payment declines. Leave blank to skip." },
        ]}
      />

      <h2>Login codes (Target and Walmart)</h2>
      <p>
        Put IMAP on each profile under <strong>Email OTP Mailbox</strong>, or set an <strong>AYCD Inbox API Key</strong> here as a global inbox.
        When a task needs a code, Zyn tries those first; you can still type it into the OTP box on the task.
      </p>

      <h2>Pokémon Center captcha</h2>
      <p>
        Leave <strong>AutoSolve hCaptcha</strong> on unless you want every challenge by hand. Windows still open when you need to tap one.
      </p>

      <h2>Target cookies</h2>
      <p>
        Browser extension IDs and phone pairing are under Settings, and the full harvest flow is in{" "}
        <Link href="/guide/harvesters">Cookie harvest</Link>. Start harvesters before the Target drop, not after SKUs go live.
      </p>
    </GuideShell>
  );
}
