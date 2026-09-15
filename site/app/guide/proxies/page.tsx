import { Callout, Fields, GuideShell, Steps, guideMetadata } from "../guide";

export const metadata = guideMetadata(
  "Proxies",
  "Create proxy lists, test them, assign them to tasks, and connect ResiFactory, Evomi, or IPFist from Zyn.",
);

export default function GuideProxiesPage() {
  return (
    <GuideShell
      current="/guide/proxies"
      kicker="Workspace"
      title="Proxies."
      lede="Lists live in the Proxies workspace. Tasks pick a list (or Local). Target’s stock monitor needs its own list — local IP typically gets HTTP 403."
    >
      <h2>Create a list</h2>
      <Steps>
        <li>Open <strong>Proxies</strong>. Optionally create a group so new lists land there.</li>
        <li>Click <strong>New Proxy List</strong>.</li>
        <li>Name the list (placeholder: Residential) and paste one proxy per line.</li>
        <li>Save. Editing a list does not break existing task references. The list name is locked after create so tasks and harvesters keep the same reference.</li>
      </Steps>
      <p>Accepted lines:</p>
      <ul>
        <li><code>ip:port</code></li>
        <li><code>ip:port:user:pass</code> — extra colons stay in the password</li>
        <li><code>http://</code>, <code>https://</code>, <code>socks4://</code>, or <code>socks5://</code> URLs</li>
        <li>Bracketed IPv6, for example <code>[2001:db8::1]:8080:user:pass</code></li>
      </ul>
      <p>Local (no proxy) is always available on tasks. Use it only when you mean to leave this machine’s IP.</p>

      <h2>Test a list</h2>
      <p>
        Open a list and run <strong>Test sample</strong> or <strong>Test all</strong>. Health shows as Untested, a live Testing n/m, or a working percent with connect / round-trip times.
        A sample of 100 is usually enough; Test all asks to confirm on lists larger than 250 lines.
      </p>
      <p>Stop cancels an in-flight test. Filter the report by All / Working / Failed / Untested and search hosts.</p>

      <h2>Where lists are used</h2>
      <Fields
        rows={[
          { label: "Target group", detail: "Default task proxy for new tasks, plus a separate Monitor proxy. Checkout tasks keep their own list for session warmup." },
          { label: "Pokémon Center / Walmart / Costco", detail: "Proxy on create, then per-task. Bulk “Set proxy list” on selected Costco/Walmart rows." },
          { label: "Harvesters", detail: "Each cookie harvester picks a list. Local is capped at 2 workers; a list allows more." },
          { label: "Account generator", detail: "A list is required. One proxy stays attached to each headed browser." },
          { label: "Browser extension", detail: "Import copies your user-owned lists into the extension. Managed provider lists stay in Zyn." },
        ]}
      />

      <Callout tone="tip" title="Target monitor">
        <p>
          On a Target group, set <strong>Monitor proxy</strong> to a residential list. The monitor is a separate stock poller.
          Local IP typically 403s. Checkout tasks should use their own proxies, not the same identity as the monitor if you can avoid it.
        </p>
      </Callout>

      <h2>Provider lists</h2>
      <p>The sidebar includes ResiFactory, Evomi, and IPFist. Link an API key to generate lists inside Zyn:</p>
      <ul>
        <li><strong>ResiFactory</strong> — remaining GB, generate lists, and add data without leaving the app.</li>
        <li><strong>Evomi</strong> / <strong>IPFist</strong> — generate lists from remaining data; buy bandwidth on that provider’s dashboard.</li>
      </ul>
      <p>
        <strong>Managed proxies</strong> appear when your Zyn account includes them. Those lists are synchronized by Zyn;
        you cannot create a local list in that view. Settings shows how many managed lists you have.
      </p>
      <p>
        Provider credentials never go to the phone harvester or the browser extension import.
      </p>
    </GuideShell>
  );
}
