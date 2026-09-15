import { Callout, Fields, GuideShell, Steps, guideMetadata } from "../guide";

export const metadata = guideMetadata(
  "Walmart",
  "Set up Walmart accounts and profiles, log in on placeholder, then apply SKUs and start the drop.",
);

export default function GuideWalmartPage() {
  return (
    <GuideShell
      current="/guide/walmart"
      kicker="Drops"
      title="Walmart."
      lede="One task per account. Log in on placeholder, then apply SKUs when they land and Start All."
    >
      <h2>Setup</h2>
      <Steps>
        <li>Create <strong>Walmart</strong> profiles (shipping, payment, mailbox for login codes).</li>
        <li>On Accounts, set Site to Walmart and paste <code>email:password</code>. Same email as the profile.</li>
        <li>Open <strong>Walmart</strong> → Show setup. Select unused accounts, pick a proxy, Create Tasks.</li>
        <li>Leave products on <code>placeholder</code> and Start All so accounts sign in before the drop.</li>
      </Steps>

      <h2>When SKUs land</h2>
      <Steps>
        <li>Paste item IDs or walmart.com URLs (up to 10). Set Qty and optional Max $.</li>
        <li>Choose <strong>Checkout</strong> or <strong>Raffle Entry</strong>.</li>
        <li>Click <strong>Apply to all tasks</strong>, then let them run (or Start All if you stopped them).</li>
      </Steps>
      <Fields
        rows={[
          { label: "Checkout", detail: "Normal checkout. Placeholder first, then real SKUs." },
          { label: "Raffle Entry", detail: "Qty is how many drawing entries to request. Use the item ID from the product page, not an offer ID." },
          { label: "Loop after a successful order", detail: "Keep running after a hit." },
        ]}
      />
      <Callout tone="tip" title="Login codes">
        <p>If Walmart asks for a code, the task shows an OTP field. Zyn fills it from the profile mailbox (or AYCD Inbox). Otherwise type the code from the email.</p>
      </Callout>
    </GuideShell>
  );
}
