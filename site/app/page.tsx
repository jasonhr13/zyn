import Image from "next/image";
import Link from "next/link";

const features = [
  {
    eyebrow: "Signal",
    title: "Know when it matters.",
    body: "Keep product targets, store activity, and task readiness visible in one focused workspace.",
  },
  {
    eyebrow: "Structure",
    title: "Every run, organized.",
    body: "Group profiles, accounts, proxies, and checkout tasks so launch-day preparation stays calm and repeatable.",
  },
  {
    eyebrow: "Control",
    title: "Move with confidence.",
    body: "Launch, pause, and inspect activity from a live operations view built for speed without sacrificing clarity.",
  },
];

const steps = [
  ["01", "Prepare", "Set up profiles, accounts, and routing once."],
  ["02", "Target", "Define the product and store workflow you want to run."],
  ["03", "Launch", "Start task groups and follow every state in real time."],
];

export default function Home() {
  return (
    <main>
      <header className="site-header">
        <a className="brand" href="#top" aria-label="Zyn home">
          <Image src="/zyn-icon.png" alt="" width={44} height={44} unoptimized />
          <span>Zyn</span>
        </a>
        <nav aria-label="Main navigation">
          <a href="#product">Product</a>
          <a href="#workflow">Workflow</a>
          <Link className="nav-cta" href="/join">Join waiting list</Link>
        </nav>
      </header>

      <section className="hero" id="top">
        <div className="hero-copy">
          <div className="status-pill"><span /> Built for high-velocity retail</div>
          <h1>The checkout command center built for the drop.</h1>
          <p className="hero-lede">
            Monitor products, organize every task, and run checkout operations from one precise desktop workspace.
          </p>
          <div className="hero-actions">
            <Link className="button button-primary" href="/join">
              Join waiting list <span aria-hidden="true">↗</span>
            </Link>
            <a className="button button-secondary" href="#product">Explore Zyn</a>
          </div>
          <div className="hero-note">
            <span>Desktop native</span><span>Live task control</span><span>Focused by design</span>
          </div>
        </div>

        <div className="product-stage" aria-label="Stylized preview of the Zyn desktop workspace">
          <div className="stage-orbit stage-orbit-one" aria-hidden="true" />
          <div className="stage-orbit stage-orbit-two" aria-hidden="true" />
          <div className="app-window">
            <div className="app-topbar">
              <div className="app-brand"><Image src="/zyn-icon.png" alt="" width={24} height={24} unoptimized /> Zyn</div>
              <div className="window-state"><span /> Operations live</div>
              <div className="window-dots"><i /><i /><i /></div>
            </div>
            <div className="app-body">
              <aside className="app-sidebar" aria-hidden="true">
                <div className="sidebar-label">Workspace</div>
                <div className="sidebar-item active"><b>⌁</b> Tasks</div>
                <div className="sidebar-item"><b>◎</b> Profiles</div>
                <div className="sidebar-item"><b>◇</b> Accounts</div>
                <div className="sidebar-label">System</div>
                <div className="sidebar-item"><b>↯</b> Proxies</div>
                <div className="sidebar-item"><b>≡</b> Settings</div>
                <div className="sidebar-version">Zyn / online</div>
              </aside>
              <div className="app-content">
                <div className="content-heading">
                  <div><span>Operations</span><strong>Task groups</strong></div>
                  <button type="button" tabIndex={-1}>+ New group</button>
                </div>
                <div className="metric-row">
                  <div><span>Ready</span><strong>18</strong><small>tasks configured</small></div>
                  <div><span>Running</span><strong className="warm">06</strong><small>active now</small></div>
                  <div><span>Success</span><strong>94%</strong><small>session health</small></div>
                </div>
                <div className="task-panel">
                  <div className="panel-heading"><strong>Launch group</strong><span>6 tasks</span></div>
                  <div className="task-row">
                    <div className="task-mark">T</div><div><strong>Primary monitor</strong><span>Waiting for product</span></div>
                    <em className="state watching"><i /> Watching</em>
                  </div>
                  <div className="task-row">
                    <div className="task-mark blue">R</div><div><strong>Checkout group 01</strong><span>Profile set / US</span></div>
                    <em className="state ready"><i /> Ready</em>
                  </div>
                  <div className="task-row">
                    <div className="task-mark gold">A</div><div><strong>Checkout group 02</strong><span>Profile set / US</span></div>
                    <em className="state live"><i /> Running</em>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div className="stage-tag tag-signal"><span>Signal</span><strong>Locked</strong></div>
          <div className="stage-tag tag-latency"><span>Response</span><strong>142 ms</strong></div>
        </div>
      </section>

      <section className="manifesto" aria-label="Zyn principles">
        <p>Monitor.</p><span /> <p>Prepare.</p><span /> <p>Launch.</p><span /> <p>Observe.</p>
      </section>

      <section className="product-section" id="product">
        <div className="section-intro">
          <p className="kicker">One operational view</p>
          <h2>Less noise.<br />More control.</h2>
          <p>Zyn brings the moving parts of a checkout run into a single interface that stays readable under pressure.</p>
        </div>
        <div className="feature-grid">
          {features.map((feature, index) => (
            <article className="feature-card" key={feature.title}>
              <div className={`feature-glyph glyph-${index + 1}`} aria-hidden="true"><i /><i /><i /></div>
              <p>{feature.eyebrow}</p>
              <h3>{feature.title}</h3>
              <span>{feature.body}</span>
            </article>
          ))}
        </div>
      </section>

      <section className="workflow-section" id="workflow">
        <div className="workflow-heading">
          <p className="kicker">A repeatable rhythm</p>
          <h2>From setup to signal in three moves.</h2>
        </div>
        <ol className="workflow-list">
          {steps.map(([number, title, body]) => (
            <li key={number}>
              <span>{number}</span>
              <h3>{title}</h3>
              <p>{body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="closing" id="access">
        <Image src="/zyn-icon.png" alt="" width={160} height={160} unoptimized />
        <p className="kicker">Zyn for desktop</p>
        <h2>Be ready before the moment arrives.</h2>
        <p>Built for operators who value speed, structure, and a workspace that gets out of the way.</p>
        <Link className="button button-primary" href="/join">
          Join waiting list <span aria-hidden="true">↗</span>
        </Link>
      </section>

      <footer>
        <a className="brand" href="#top"><Image src="/zyn-icon.png" alt="" width={38} height={38} unoptimized /><span>Zyn</span></a>
        <p>Precision retail operations.</p>
        <div><a href="mailto:hello@rcart.app">Contact</a><span>© {new Date().getFullYear()} Zyn</span></div>
      </footer>
    </main>
  );
}
