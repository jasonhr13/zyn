import Link from "next/link";
import { Callout, Fields, GuideShell, Steps, guideMetadata } from "../guide";

export const metadata = guideMetadata(
  "Profiles",
  "Create Target, Pokémon Center, and Walmart checkout profiles, including shipping, payment, and email OTP mailboxes.",
);

export default function GuideProfilesPage() {
  return (
    <GuideShell
      current="/guide/profiles"
      kicker="Workspace"
      title="Profiles."
      lede="A profile is shipping, payment, and (for Target and Walmart) the mailbox Zyn uses to pull login codes. Create a group first — new profiles are saved into the selected group."
    >
      <h2>Create a group, then a profile</h2>
      <Steps>
        <li>Open <strong>Profiles</strong>.</li>
        <li>Create a group from the sidebar (folder +). Name it for the drop or card, not for the site.</li>
        <li>With that group selected, click the new-profile button. If you are on All Profiles or Ungrouped, Zyn asks you to choose a group first.</li>
      </Steps>

      <h2>Profile type</h2>
      <Fields
        rows={[
          { label: "Target", detail: "Account checkout. Optional Email OTP Mailbox. Phone is optional." },
          { label: "Pokémon Center", detail: "Guest checkout. Phone is required. No mailbox section. Optional separate billing address." },
          { label: "Walmart", detail: "Checkout profile with shipping, payment, and optional Email OTP Mailbox. Tasks only pick Walmart-type profiles." },
        ]}
      />

      <h2>Required fields</h2>
      <p>Every type needs Profile Name, Email, First / Last Name, Address, City, State, Zip, Card Number, Exp Month, Exp Year, and CVV. Name on Card defaults to the shipping name if you leave it blank.</p>
      <p>Pokémon Center also requires Phone. If billing is not the same as shipping, complete every billing field.</p>
      <Callout tone="warn" title="Complete every required field">
        <p>Save is blocked until required profile, shipping, and payment fields are filled. Country defaults to United States.</p>
      </Callout>

      <h2>Email OTP Mailbox</h2>
      <p>
        Target and Walmart use this profile’s mailbox when the matching account requests a login code.
        Pokémon Center does not show this section.
      </p>
      <Fields
        rows={[
          { label: "Mailbox Provider", detail: "No automatic mailbox, Gmail, Outlook / Hotmail, Yahoo, iCloud, or Custom…" },
          { label: "Port", detail: "Always 993." },
          { label: "Mailbox User / App Password", detail: "IMAP login. Spaces in app passwords are kept; hidden paste characters are stripped." },
          { label: "Reuse Saved Mailbox Credentials", detail: "Copies provider, user, and the saved app password from another profile. Change the mailbox user afterward for an alias on the same app password." },
          { label: "Test IMAP Connection", detail: "Verifies host, user, and password before you save." },
        ]}
      />
      <p>
        You can also set a global <strong>AYCD Inbox API Key</strong> in Settings. AYCD is the first-choice source;
        profile IMAP is the per-account mailbox. See <Link href="/guide/settings">Settings → Email / OTP</Link>.
      </p>

      <h2>Duplicate, edit, import</h2>
      <ul>
        <li><strong>Duplicate</strong> opens New Profile with a “copy” name into the currently selected group.</li>
        <li><strong>Create one profile per account email</strong> (Target and Walmart rows) copies card and address onto a new profile for each account email. Accounts that already have a profile are skipped. Hidden for Pokémon Center.</li>
        <li><strong>Import</strong> / <strong>Export</strong> use AYCD JSON, not CSV. Import skips existing names. Export of multi-group profiles keeps only the first group.</li>
      </ul>
      <p>The AYCD file is plain-text cards, CVVs, and addresses — treat it as a secret. Mailbox IMAP is not included in AYCD import or export; re-add Email OTP Mailbox after import.</p>
    </GuideShell>
  );
}
