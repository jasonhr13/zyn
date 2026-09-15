import Link from "next/link";
import { Callout, Fields, GuideShell, Steps, guideMetadata } from "../guide";

export const metadata = guideMetadata(
  "Install & sign in",
  "Download Zyn for Mac or Windows and sign in so you can set up drops.",
);

export default function GuideInstallPage() {
  return (
    <GuideShell
      current="/guide/install"
      kicker="Setup"
      title="Install and sign in."
      lede="After you buy, you get a download link and a one-time password. Sign in, then add profiles while Zyn finishes setup."
    >
      <Steps>
        <li>Buy at <Link href="/buy">zynbot.app/buy</Link> if you do not have an account yet. New accounts get a one-time password on the success page.</li>
        <li>Open the private download link and unlock it once in that browser.</li>
        <li>Download the build that matches the machine:</li>
      </Steps>
      <Fields
        rows={[
          { label: "Apple silicon Mac", detail: "M-series, macOS 12 or newer." },
          { label: "Intel Mac", detail: "Separate Intel download. Apple menu → About This Mac if you are unsure." },
          { label: "Windows", detail: "64-bit Windows 10 or 11. SmartScreen may ask you to confirm the first run." },
        ]}
      />

      <h2>Sign in</h2>
      <Steps>
        <li>Open Zyn. Choose <strong>Full Engine</strong> on the machine that will run checkout, then <strong>Sign in</strong>.</li>
        <li>If this is the first login, set a new password (10+ characters) and <strong>Save password &amp; continue</strong>.</li>
        <li>Leave the <strong>Finishing Zyn setup</strong> banner running. Add profiles, accounts, and proxies while it downloads.</li>
      </Steps>
      <p>
        Extra PCs can sign in as <strong>Harvester only</strong> (<strong>Sign in as harvester</strong>) to farm Target cookies for the checkout machine. See <Link href="/guide/harvesters">Cookie harvest</Link>.
      </p>
      <Callout tone="tip" title="Updates">
        <p>When a new app is ready, the sidebar shows <strong>Update to v…</strong>. Restart to apply it before a drop, not during one.</p>
      </Callout>
    </GuideShell>
  );
}
