import Link from "next/link";
import { Callout, Fields, GuideShell, Steps, guideMetadata } from "../guide";

export const metadata = guideMetadata(
  "Accounts",
  "Add Target and Walmart logins, generate Target accounts, and keep saved sessions without exposing passwords.",
);

export default function GuideAccountsPage() {
  return (
    <GuideShell
      current="/guide/accounts"
      kicker="Workspace"
      title="Accounts."
      lede="Accounts are site logins. Profiles are shipping and payment. Target and Walmart tasks need both, matched by email. Passwords are encrypted on disk and never shown again."
    >
      <h2>Add logins</h2>
      <Steps>
        <li>Open <strong>Accounts</strong>. Create an account group if you want the new logins filed immediately.</li>
        <li>Click <strong>Add Accounts</strong>.</li>
        <li>Set <strong>Site</strong> to Target or Walmart.</li>
        <li>Paste one <code>email:password</code> per line. Re-pasting an email updates the password without showing the saved value.</li>
      </Steps>
      <p>Pokémon Center is guest checkout — it does not use this page.</p>

      <h2>What the table shows</h2>
      <Fields
        rows={[
          { label: "Account", detail: "Email, site, and groups." },
          { label: "Password", detail: "Encrypted, or Manual login if none is saved." },
          { label: "Profile", detail: "Matching checkout profile, linked by email (or an explicit link). Tasks refuse to start without one." },
          { label: "Session", detail: "Signed in means a saved login cookie. No session means Zyn will sign in on the next Start." },
          { label: "Added", detail: "Added (pasted) or Generated." },
        ]}
      />

      <Callout tone="warn" title="Editing email or password signs the account out">
        <p>
          Save Changes on an email or password update clears the saved login cookie. The next Start signs in again
          (and may need OTP). Resetting a finished Target task back to Idle does not clear that cookie.
        </p>
      </Callout>

      <h2>Match profiles</h2>
      <p>
        Use the same email on the Target or Walmart profile and the account. Target tasks show{" "}
        <strong>Matching profile ready</strong> or <strong>Missing matching profile</strong>. Walmart requires a Walmart-type profile with that email.
      </p>

      <h2>Generate Target Accounts</h2>
      <p>
        <strong>Generate</strong> opens a headed browser on this machine and creates Target accounts. Each account uses one stable proxy from a list you choose. Target signup does not use SMS or an address.
      </p>
      <Fields
        rows={[
          { label: "Emails", detail: "One per line, or Add Catchall with a domain and count." },
          { label: "Account password", detail: "Used for this batch only. Saved encrypted afterward." },
          { label: "Create matching profiles from", detail: "Optional. Copies payment and billing from a complete Target profile; each new account gets its own email. Jig shipping line 1 and 2 if you want unique addresses." },
          { label: "Proxy", detail: "Required. One proxy stays on each browser session." },
          { label: "IMAP / AYCD", detail: "For email verification. Catchall addresses receive mail; IMAP logs into the mailbox user you enter, not the random catchall." },
          { label: "Browser", detail: "Automatic — random installed browser, or pick Chrome, Edge, Brave, and others." },
        ]}
      />
      <p>
        Successful credentials can also post to <strong>Account Generation Webhook URL</strong> in Settings — that webhook is never used for checkout notifications.
      </p>

      <h2>Groups</h2>
      <p>
        Deleting an account group moves those logins to Ungrouped; credentials stay. Deleting selected accounts cannot be undone — tasks that used them need another account.
      </p>
      <p>
        Next: <Link href="/guide/proxies">Proxies</Link>, then a <Link href="/guide/target">Target group</Link>.
      </p>
    </GuideShell>
  );
}
