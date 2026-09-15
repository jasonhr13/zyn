import { Callout, Fields, GuideShell, Steps, guideMetadata } from "../guide";

export const metadata = guideMetadata(
  "Pokémon Center",
  "Set up Pokémon Center US guest checkout: profiles, SKUs, queue wait, captcha, Start All.",
);

export default function GuidePokemonCenterPage() {
  return (
    <GuideShell
      current="/guide/pokemon-center"
      kicker="Drops"
      title="Pokémon Center US."
      lede="Guest checkout from Pokémon Center profiles. No site logins. Start on placeholder, then apply SKUs — including tasks already in queue."
    >
      <h2>Setup</h2>
      <Steps>
        <li>Create profiles with type <strong>Pokémon Center</strong>. Phone is required. No mailbox.</li>
        <li>Open <strong>Pokémon Center</strong> → Show setup.</li>
        <li>Add up to three products: SKU, product URL, or <code>placeholder</code>. Each row has its own Qty.</li>
        <li>Select profiles, set <strong>Tasks per profile</strong> (2–6 is typical), pick a proxy, Create Tasks.</li>
        <li>Start All.</li>
      </Steps>

      <h2>When SKUs land</h2>
      <p>
        Paste them in setup and click <strong>Apply to all tasks</strong>. That updates tasks already waiting in queue.
        A single row can keep its own SKUs from the pencil editor, or switch back with <strong>Use shared products</strong>.
      </p>

      <h2>Queue and captcha</h2>
      <Fields
        rows={[
          { label: "Wait for queue (24/7)", detail: "Park until a queue or site protection appears, then enter." },
          { label: "Require all in stock", detail: "With multiple products, wait until every one is in stock before carting." },
          { label: "Loop checkout", detail: "After a hit or decline, rotate to another profile in that profile’s first group." },
        ]}
      />
      <Callout tone="tip" title="Captcha">
        <p>
          Captcha windows open on their own. Leave <strong>AutoSolve hCaptcha</strong> on in Settings unless you want to solve every challenge by hand.
        </p>
      </Callout>
    </GuideShell>
  );
}
