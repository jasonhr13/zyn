import { Callout, Fields, GuideShell, Steps, guideMetadata } from "../guide";

export const metadata = guideMetadata(
  "Costco",
  "Farm the Costco waiting room with proxies. On pass, a browser opens so you can check out.",
);

export default function GuideCostcoPage() {
  return (
    <GuideShell
      current="/guide/costco"
      kicker="Drops"
      title="Costco."
      lede="Zyn farms the Queue-it waiting room. It does not check out for you. On pass, a headed browser opens on that task’s proxy so you can finish on Costco’s site."
    >
      <Steps>
        <li>Open <strong>Costco</strong>.</li>
        <li>Paste the product URL or waiting-room URL (<code>costco.com</code>, <code>costco.ca</code>, or a Queue-it link).</li>
        <li>Set how many tasks to create and a proxy list. Give each task its own proxy when you can.</li>
        <li>Leave <strong>Open a headed browser on queue pass</strong> on.</li>
        <li>Create tasks, then Start All when the room opens.</li>
      </Steps>
      <Fields
        rows={[
          { label: "Poll delay ms", detail: "How often each session checks the room." },
          { label: "Queue Pass", detail: "That session got through. A browser should open on the same proxy and cookies — check out there." },
        ]}
      />
      <Callout tone="note" title="No Costco profiles">
        <p>This module does not use profiles, accounts, or cards. It is only the waiting room plus the browser on pass.</p>
      </Callout>
    </GuideShell>
  );
}
