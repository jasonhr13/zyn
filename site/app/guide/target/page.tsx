import Link from "next/link";
import { Callout, Fields, GuideShell, Steps, guideMetadata } from "../guide";

export const metadata = guideMetadata(
  "Target",
  "Create Target task groups, add accounts, schedule Start All, and read the drop overview cards.",
);

export default function GuideTargetPage() {
  return (
    <GuideShell
      current="/guide/target"
      kicker="Tasks"
      title="Target."
      lede="Target is organized as task groups: one shared watch list, one checkout task per account. Start All from the drop overview. Click a card to see only those tasks."
    >
      <h2>Create a group</h2>
      <Steps>
        <li>Open <strong>Target</strong> → <strong>Create Task Group</strong>.</li>
        <li>Name it (placeholder: Friday drop).</li>
        <li>Build the <strong>Watch list</strong>: paste TCINs or Target product URLs, then Add. You can paste several lines at once.</li>
        <li>Set quantity, default task proxy, monitor proxy, and monitor delay.</li>
        <li>Save, then <strong>Add Account Tasks</strong> for every Target account that has a matching profile.</li>
      </Steps>

      <h2>Watch list</h2>
      <Fields
        rows={[
          { label: "TCIN or URL", detail: "Eight-digit TCIN or a target.com product link. Duplicate SKUs are rejected." },
          { label: "Priority", detail: "Star a SKU so running tasks prefer it." },
          { label: "Max price", detail: "Optional per SKU. Leave empty for no maximum. Prices lock while tasks are running; add/remove/priority still save." },
          { label: "Quantity per SKU", detail: "1–99, shared across the watch list." },
        ]}
      />
      <p>Removing a SKU drops it from running tasks before payment. A running group must keep at least one valid SKU.</p>

      <h2>Monitor and checkout options</h2>
      <Fields
        rows={[
          { label: "Default task proxy", detail: "Applied to new tasks. Each task can change it later." },
          { label: "Monitor proxy", detail: "Separate list for stock polling. Local IP typically 403s." },
          { label: "Monitor delay (ms)", detail: "How often the monitor polls." },
          { label: "Stock confidence", detail: "Any in-stock signal, or Confirmed 10+ units (ignores low or unknown quantities)." },
          { label: "Loop checkout by default", detail: "After checkout or decline, keep trying eligible SKUs. Stops at two orders per account, per SKU, within four hours. You can override per task." },
          { label: "Pre-cart filler item", detail: "Adds Target SKU 84704409 before waiting for a watched product. Zyn tries to remove the filler after checkout." },
        ]}
      />

      <h2>Add account tasks</h2>
      <p>
        One task per account in the group. Select accounts that show <strong>Matching profile ready</strong>.
        Already-used accounts are disabled. Set proxy and loop checkout for the batch, then Add Tasks.
      </p>
      <p>
        <strong>Signed in</strong> means the account already has a login cookie. Those tasks skip a fresh login on Start.
      </p>

      <h2>Run the drop</h2>
      <p>
        Idle groups show the full account list so you can prep. When the group is running (or after Start All), Zyn opens the drop overview instead of mounting every row. Six cards:
      </p>
      <Fields
        rows={[
          { label: "Running", detail: "Every live task." },
          { label: "Waiting for restock", detail: "Parked until stock." },
          { label: "Adding to cart", detail: "In the ATC loop." },
          { label: "Submitting order", detail: "Carted, finishing checkout." },
          { label: "Need attention", detail: "OTP, Shape soft block, or decline." },
          { label: "Checked out", detail: "Waiting on Target." },
        ]}
      />
      <p>
        Click a card to see only those tasks. Use <strong>Drop overview</strong> / <strong>Manage tasks</strong> to switch views.
        <strong>Start All</strong> / <strong>Stop Tasks</strong> run the group.
      </p>
      <p>
        Start the <strong>Monitor</strong> on its own strip (stock check). It is separate from checkout tasks. Assign it a proxy list — Local IP usually fails.
      </p>

      <Callout tone="tip" title="OTP on a task">
        <p>
          When Target wants a login code, the task shows an OTP field. If the profile mailbox or AYCD Inbox is set up, Zyn fills it.
          Otherwise enter the code from the Target email. That is Need attention until it clears.
        </p>
      </Callout>

      <h2>Schedule</h2>
      <p>Schedule “Group name” — start and/or stop at a local clock time or after a delay. Zyn must stay open for timers to fire. Keep the machine awake during the window.</p>
      <p>Start group / Stop group: Off, At time, or In… minutes/hours. Stop must be later than Start. Clear schedule removes it.</p>

      <h2>Cookie bank</h2>
      <p>
        Full Engine Target shows login and ATC cookie counts for the shared bank. In-app harvesters, the browser extension, and paired phones all feed it.
        See <Link href="/guide/harvesters">Cookie harvest</Link>.
      </p>
    </GuideShell>
  );
}
