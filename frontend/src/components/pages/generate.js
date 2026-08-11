import React, { Component } from 'react';
import { connect } from 'react-redux';
import { proxyCount, proxyLabel, proxyRef } from '../proxy-options';
import { timestampLogLine } from '../log-timestamp';

const { ipcRenderer, clipboard, shell } = window.require('electron');

// This app has no window-open handler anywhere (checked) — a plain <a target="_blank"> would
// either silently no-op or hijack the app's own BrowserWindow instead of opening the OS browser.
const openExternal = (e, url) => { e.preventDefault(); shell.openExternal(url); };

// Sub-tabs WITHIN the Generate page (not separate sidebar entries) — one module per target site.
// bandai/target/walmart share the same "create N accounts from an email list" shape and bot-script
// calling convention; icloud is fundamentally different (see MODULE_META / the iCloud panel below)
// so it's excluded from ACCOUNT_MODULES and rendered separately.
// devOnly modules stay hidden from beta pushes until they're actually ready to ship.
// hidden modules are hidden on EVERY build including dev, the same flag the sidebar uses. The code
// and the routes stay — set hidden:false to bring one back.
const GENERATE_MODULES = [
  { value: 'bandai', emoji: '🃏', label: 'Bandai' },
  { value: 'riotgames', emoji: '🎮', label: 'Riot Games', hidden: true },
  // No longer devOnly (2026-07-28) — shipped with the Target module in v1.6.41.
  { value: 'target', emoji: '🎯', label: 'Target' },
  { value: 'walmart', emoji: '🛒', label: 'Walmart', devOnly: true, hidden: true },
  // No longer devOnly (2026-07-24) — iCloud generation is working end-to-end and shipping to beta.
  { value: 'icloud', emoji: '🍎', label: 'iCloud' },
];
const ACCOUNT_MODULES = new Set(['bandai', 'riotgames', 'target', 'walmart']);

// Which bot script each account-creation module invokes, and its default SMS-catalog service slug.
const MODULE_META = {
  bandai: { script: 'pbandai-register.mjs', defaultSmsService: 'bandai', siteName: 'Bandai' },
  riotgames: { script: 'riotgames-register.mjs', defaultSmsService: 'riotgames', siteName: 'Riot Games' },
  target: { script: 'target-register.mjs', defaultSmsService: 'target', siteName: 'Target' },
  walmart: { script: 'walmart-register.mjs', defaultSmsService: 'walmart', siteName: 'Walmart' },
};

// For the Catchall email-list generator — just needs to look like a plausible local part
// (TraceyMorgan23@...), not be a real identity.
const CATCHALL_FIRST_NAMES = ['Tracey', 'James', 'Mary', 'Robert', 'Patricia', 'John', 'Jennifer', 'Michael', 'Linda', 'David', 'Elizabeth', 'William', 'Barbara', 'Richard', 'Susan', 'Joseph', 'Jessica', 'Thomas', 'Sarah', 'Charles', 'Karen', 'Daniel', 'Nancy', 'Matthew', 'Lisa'];
const CATCHALL_LAST_NAMES = ['Morgan', 'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez', 'Hernandez', 'Lopez', 'Wilson', 'Anderson', 'Taylor', 'Moore', 'Jackson', 'Martin', 'Lee'];

const SMS_PROVIDERS = [
  { value: 'getatext', label: 'GetAText' },
  { value: 'textverified', label: 'TextVerified' },
  { value: 'grizzlysms', label: 'GrizzlySMS' },
  { value: '5sim', label: '5Sim' },
  { value: 'smshub', label: 'SMSHub' },
  { value: 'smspool', label: 'SMSPool' },
];

// No IMAP host presets exist anywhere in Fable-Techniques (checked) — just the standard well-known
// IMAPS hosts. All of these use port 993, so the port field is fixed rather than user-editable.
const IMAP_PROVIDERS = [
  { value: 'imap.gmail.com', label: 'Gmail' },
  { value: 'outlook.office365.com', label: 'Outlook / Hotmail' },
  { value: 'imap.mail.yahoo.com', label: 'Yahoo' },
  { value: 'imap.mail.me.com', label: 'iCloud' },
  { value: 'custom', label: 'Custom...' },
];
const IMAP_PORT = 993;

const US_STATES = [
  'Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado', 'Connecticut',
  'Delaware', 'Florida', 'Georgia', 'Hawaii', 'Idaho', 'Illinois', 'Indiana', 'Iowa',
  'Kansas', 'Kentucky', 'Louisiana', 'Maine', 'Maryland', 'Massachusetts', 'Michigan',
  'Minnesota', 'Mississippi', 'Missouri', 'Montana', 'Nebraska', 'Nevada', 'New Hampshire',
  'New Jersey', 'New Mexico', 'New York', 'North Carolina', 'North Dakota', 'Ohio',
  'Oklahoma', 'Oregon', 'Pennsylvania', 'Rhode Island', 'South Carolina', 'South Dakota',
  'Tennessee', 'Texas', 'Utah', 'Vermont', 'Virginia', 'Washington', 'West Virginia',
  'Wisconsin', 'Wyoming',
];

// Fields persisted to settings.generate across restarts. Deliberately excluded: emailListByModule
// (a batch of addresses shouldn't reappear after a relaunch), logs/isRunning/progress (transient),
// show-password toggles (reset to hidden), icloudCount/icloudLabel (per-run, not identity).
const PERSISTED_FIELDS = [
  'activeModule',
  'password', 'state', 'firstName', 'lastName', 'randomizeName',
  'smsProvider', 'smsApiKeys', 'smsApiUsername', 'smsServiceByModule',
  'imapHost', 'imapHostCustom', 'imapUser', 'imapPass', 'aycdApiKey',
  'hcaptchaApiKey', 'hcaptchaSolver',
  'proxyListName',
  'appleEmail', 'applePassword',
  'concurrency',
];

// Type any number. The old dropdown offered 1-5 and there was no way past it, which made a fixed
// guess about someone else's machine — 5 is right for a laptop and low for a box built for this.
//
// The reasoning behind that 5 still holds and is worth knowing rather than enforcing: every account
// is a real headed Chromium window, a rented SMS number and a live IMAP connection, so the ceiling
// is RAM and your mail provider's connection limit (Gmail allows about 15 per account), not this
// app. Past roughly 10 the failures are usually IMAP refusing connections, which looks like the bot
// hanging on the code step.
//
// 50 is a backstop against a typo — a stray zero spawning 500 browsers is not a choice anyone made.
const MAX_CONCURRENCY = 50;
// Above this the warning appears; it does not block.
const CONCURRENCY_ADVISED = 5;

class Generate extends Component {
  // Self-corrects a persisted activeModule that isn't visible on this build (e.g. a beta tester's
  // saved settings pointed at Target before Target became devOnly) — every other read of
  // state.activeModule stays untouched instead of threading a "safe" variant through the render.
  static getDerivedStateFromProps(props, state) {
    const meta = GENERATE_MODULES.find(m => m.value === state.activeModule);
    if (!meta) return null;
    // Without this, a saved activeModule of a now-hidden module leaves its panel on screen with no
    // tab to click away from — the button is gone but the state still points at it.
    if (meta.hidden) return { activeModule: 'bandai' };
    if (props.channel !== 'dev' && meta.devOnly) return { activeModule: 'bandai' };
    return null;
  }

  constructor(props) {
    super(props);
    this.state = {
      activeModule: 'bandai', // which sub-tab is showing

      // Account generation — one email list PER module (a Bandai batch and a Target batch are
      // different addresses on different days), everything else shared across bandai/riotgames/target/walmart.
      emailListByModule: { bandai: '', riotgames: '', target: '', walmart: '' },
      // Not "Password123!" — Bandai's site rejects any password containing a 3-char run like "123";
      // kept as the shared default since it's a safe pattern for the other sites too.
      password: 'Bx9!Lq4tRz',
      state: 'Texas',
      // Blank = the bot picks a random name + adult birthdate per account. Real identity doesn't
      // matter for a tournament/bulk sign-up — every registrant just needs a working account.
      firstName: '',
      lastName: '',
      randomizeName: true,

      // SMS provider — one API key SAVED PER PROVIDER (keyed by provider value), so switching the
      // dropdown doesn't clobber whatever key was typed in for a different provider. Service slug is
      // PER MODULE since each site's catalog uses a different slug.
      smsProvider: 'getatext',
      smsApiKeys: {},
      smsApiUsername: '', // TextVerified only — its v2 API needs the account username alongside the key
      smsServiceByModule: { bandai: 'bandai', riotgames: 'riotgames', target: 'target', walmart: 'walmart' },

      // Email auth code — AYCD Inbox API key and/or IMAP login can both be filled in; the bot
      // scripts try AYCD first and fall back to IMAP (see startGeneration's own comment).
      aycdApiKey: '',

      // IMAP (for email auth codes) — port is fixed at 993, every provider here uses it
      imapHost: 'imap.gmail.com',
      imapHostCustom: '',
      imapUser: '',
      imapPass: '',

      // hCaptcha solver (for Riot Games)
      hcaptchaApiKey: '',
      hcaptchaSolver: '2captcha',

      // Show/hide toggles for masked fields — not persisted, resets to hidden on relaunch
      showPassword: false,
      showSmsApiKey: false,
      showImapPass: false,
      showApplePassword: false,
      showAycdApiKey: false,
      showHcaptchaApiKey: false,

      // Proxy — a saved list from the Proxies page, rotated one line per account. No raw
      // host/user/pass fields here; manage those on the Proxies page like every other bot does.
      proxyListName: '',
      // How many accounts to generate in parallel (separate headed browser windows). Each account
      // run is already an isolated OS process (own Chromium, own rented SMS number, own IMAP
      // connection verifying its own To: header before accepting a code) — see startGeneration's
      // own comment for why concurrent runs don't cross-contaminate SMS/email auth.
      concurrency: '1',

      // iCloud Hide My Email — NOT account creation. Needs an Apple ID you already own (with
      // active iCloud+), and generates disposable email ALIASES under it. Apple rate-limits this to
      // 5 generates/hour per Apple ID.
      appleEmail: '',
      applePassword: '',
      icloudCount: '5',
      icloudLabel: '',
      icloudAction: null, // 'generate' | 'scrape' | null — which iCloud button is currently running, for button labels

      // Catchall email-list generator modal
      catchallModalOpen: false,
      catchallDomain: '',
      catchallCount: '20',

      // Execution
      isRunning: false,
      progress: 0,
      logs: [],
    };
  }

  componentDidMount() {
    // Hydrate persisted fields from settings.generate — previously nothing was saved at all, so a
    // relaunch silently dropped every field the user had filled in.
    const saved = (this.props.settings || {}).generate;
    if (saved) this.setState(Object.fromEntries(PERSISTED_FIELDS.filter(k => saved[k] !== undefined).map(k => [k, saved[k]])));

    // runLabels maps a runId -> the account email it's generating, so concurrent runs' interleaved
    // stdout stays attributable in the shared log view instead of reading as one jumbled stream.
    this.runLabels = {};
    // generatedAliases maps a runId -> the list of iCloud aliases icloud-register.mjs reported
    // (parsed off its own [DEBUG] {"type":"alias_created"|"alias_found",...} log lines — the same
    // JSON debug lines createBotContext's logDebug() already writes for every bot script, just
    // never consumed on this side before). alias_created comes from Generate Aliases; alias_found
    // comes from Scrape Emails (--mode=list, for aliases made before this app tracked them at all).
    // Both callers read this after their run to save each alias onto the Accounts tab — BUG FIX
    // (reported live 2026-07-23): generation succeeded and logged fine, but never called
    // addGeneratedAccount at all, so nothing ever reached accounts.json/the Accounts tab for
    // iCloud, unlike every other module's generation loop.
    this.generatedAliases = {};
    this.onBotLog = (e, { runId, line }) => {
      const label = this.runLabels[runId];
      this.addLog(label ? `[${label}] ${line}` : line);
      if (this.generatedAliases[runId]) {
        const m = line.match(/^\[DEBUG\]\s*(\{.*\})$/);
        if (m) {
          try {
            const data = JSON.parse(m[1]);
            if ((data.type === 'alias_created' || data.type === 'alias_found') && data.alias) {
              this.generatedAliases[runId].push(data.alias);
            }
          } catch {}
        }
      }
    };
    ipcRenderer.on('botScriptLog', this.onBotLog);
  }

  componentWillUnmount() {
    ipcRenderer.removeListener('botScriptLog', this.onBotLog);
  }

  // Debounced so a burst of keystrokes (typing an API key) doesn't hit disk on every character.
  persistConfig = () => {
    clearTimeout(this._persistTimer);
    this._persistTimer = setTimeout(() => {
      const generate = Object.fromEntries(PERSISTED_FIELDS.map(k => [k, this.state[k]]));
      const settings = { ...(this.props.settings || {}), generate };
      ipcRenderer.sendSync('saveSettings', settings);
      this.props.dispatch({ type: 'update', obj: { settings } });
    }, 400);
  };

  handleInputChange = (e) => {
    const { name, value } = e.target;
    this.setState({ [name]: value }, this.persistConfig);
  };

  handleApiKeyChange = (e) => {
    const key = e.target.value;
    this.setState(prev => ({ smsApiKeys: { ...prev.smsApiKeys, [prev.smsProvider]: key } }), this.persistConfig);
  };

  currentApiKey = () => this.state.smsApiKeys[this.state.smsProvider] || '';

  // Per-module email list / SMS service slug getters+setters.
  currentEmailList = () => this.state.emailListByModule[this.state.activeModule] || '';
  setEmailList = (value) => this.setState(prev => ({ emailListByModule: { ...prev.emailListByModule, [prev.activeModule]: value } }));
  currentSmsService = () => this.state.smsServiceByModule[this.state.activeModule] || '';
  setSmsService = (value) => this.setState(prev => ({ smsServiceByModule: { ...prev.smsServiceByModule, [prev.activeModule]: value } }), this.persistConfig);

  addLog = (msg) => {
    this.setState(prev => ({
      logs: [...prev.logs, timestampLogLine(msg)],
    }));
  };

  clearLogs = () => this.setState({ logs: [] });

  // BUG FIX: window.prompt() hung with no visible dialog in this app's frameless (frame: false)
  // Electron window — native prompt/alert/confirm are unreliable there. Uses the app's own modal
  // system (.modal-overlay/.modal, same convention as profiles/tasks create-modal.js) instead.
  openCatchallModal = () => this.setState({ catchallModalOpen: true, catchallDomain: '', catchallCount: '20' });
  closeCatchallModal = () => this.setState({ catchallModalOpen: false });

  // Normalizes "heldmedown.com" -> "@heldmedown.com" (either form works) and appends that many
  // random FirstLastNN@domain addresses to the ACTIVE module's email list — for a domain where
  // every address routes to your own inbox.
  submitCatchallModal = () => {
    let domain = this.state.catchallDomain.trim();
    if (!domain) return;
    if (!domain.startsWith('@')) domain = '@' + domain;
    const count = parseInt(this.state.catchallCount, 10);
    if (!count || count <= 0) return;

    const used = new Set();
    const emails = [];
    let guard = 0;
    while (emails.length < count && guard < count * 20) {
      guard++;
      const first = CATCHALL_FIRST_NAMES[Math.floor(Math.random() * CATCHALL_FIRST_NAMES.length)];
      const last = CATCHALL_LAST_NAMES[Math.floor(Math.random() * CATCHALL_LAST_NAMES.length)];
      const num = Math.floor(Math.random() * 90) + 10; // 2-digit suffix, e.g. "23"
      const local = `${first}${last}${num}`;
      if (used.has(local)) continue;
      used.add(local);
      emails.push(`${local}${domain}`);
    }

    const current = this.currentEmailList();
    this.setEmailList(current.trim() ? `${current.trim()}\n${emails.join('\n')}` : emails.join('\n'));
    this.setState({ catchallModalOpen: false });
    this.addLog(`Added ${emails.length} catchall email(s) for ${domain}`);
  };

  copyLogs = () => {
    try { clipboard.writeText(this.state.logs.join('\n')); } catch {}
  };

  // The selected list's lines, in host:port[:user:pass] form — same format every other bot in
  // this app expects (see pbandai-buyer.mjs's parseProxy).
  selectedProxyList = () => {
    const { proxyListName } = this.state;
    return ((this.props.proxies || {}).lists || []).find(l => proxyRef(l) === proxyListName);
  };

  proxyLines = () => {
    const list = this.selectedProxyList();
    if (!list || list.managed) return [];
    return (list.raw || '').split('\n').map(l => l.trim()).filter(Boolean);
  };

  effectiveImapHost = () => {
    const { imapHost, imapHostCustom } = this.state;
    return imapHost === 'custom' ? imapHostCustom.trim() : imapHost;
  };

  // Shared by bandai/target/walmart — they all take the same CONFIG shape and only differ in
  // which script runs and which SMS-catalog service slug they default to (see MODULE_META).
  //
  // Runs up to `concurrency` (1-5) accounts in parallel, each its own headed-Chromium OS process
  // (spawned via runBotScript/task-handler.js) — NOT threads in this process, so there is no
  // shared JS state between concurrent runs to worry about. The two things that matter for
  // correctness at concurrency:
  //   - SMS: each process calls createSmsClient() and rents its OWN number, tracked by its OWN
  //     purchaseId — provider-side, not app-side, so two concurrent runs can never poll each
  //     other's number.
  //   - Email auth: imap-client.mjs's fetchAuthCode() opens its OWN IMAP connection per process and
  //     explicitly re-checks the parsed To: header against ITS target email before ever accepting a
  //     code — even when N processes share one catchall inbox and a coarse FROM+SINCE search
  //     returns overlapping results, each process only accepts a code addressed to itself. This was
  //     already true before concurrency existed (see imap-client.mjs's own 2026-07-18 bug-fix
  //     comment on the To: verification) — running several at once just exercises it in parallel.
  startGeneration = async () => {
    const { activeModule, password, state, firstName, lastName, randomizeName, smsProvider, smsApiUsername, imapUser, imapPass, aycdApiKey, hcaptchaApiKey, hcaptchaSolver, concurrency } = this.state;
    const discordWebhook = (this.props.settings || {}).discordWebhook || '';
    const meta = MODULE_META[activeModule];
    const emailList = this.currentEmailList();
    const smsService = this.currentSmsService();
    const imapHost = this.effectiveImapHost();
    const smsApiKey = this.currentApiKey();

    const rawEmails = emailList.split('\n').map(e => e.trim()).filter(Boolean);
    if (rawEmails.length === 0) {
      this.addLog('Error: No emails provided');
      return;
    }

    // Skip emails that already have an account on THIS site — avoids burning an SMS rental and a
    // full signup run just to hit P-Bandai's (or Target's/Walmart's) own "you already have an
    // account with this email" rejection. Only matches accounts tagged for the SAME site
    // (account.site === activeModule): an email with a Target account shouldn't block a Bandai
    // generation for that same address, they're genuinely different site accounts. Accounts from
    // before this tagging existed (or added via the manual Accounts-page paste, which has no site
    // concept) have no `site` at all — treated as Bandai-only here since this app's accounts.json
    // predates the multi-site Generate tab and was exclusively P-Bandai data until now.
    const existingEmails = new Set(
      (this.props.accounts || [])
        .filter(a => (a.site || 'bandai') === activeModule)
        .map(a => (a.email || '').toLowerCase())
    );
    const emails = rawEmails.filter(e => !existingEmails.has(e.toLowerCase()));
    const skippedCount = rawEmails.length - emails.length;
    if (emails.length === 0) {
      this.addLog(`Error: All ${rawEmails.length} email(s) already have a ${meta.siteName} account — nothing to generate.`);
      return;
    }

    const selectedProxyList = this.selectedProxyList();
    const proxyLines = this.proxyLines();
    const managedProxyRef = selectedProxyList?.managed ? proxyRef(selectedProxyList) : '';
    const maxConcurrent = Math.max(1, Math.min(MAX_CONCURRENCY, parseInt(concurrency, 10) || 1));

    this.stopRequested = false;
    this.activeRunIds = new Set();
    this.setState({ isRunning: true, logs: [], progress: 0 });
    if (skippedCount) this.addLog(`Skipped ${skippedCount} email(s) that already have a ${meta.siteName} account.`);
    this.addLog(`Starting ${meta.siteName} account generation for ${emails.length} accounts${maxConcurrent > 1 ? ` (${maxConcurrent} concurrent)` : ''}...`);
    if (selectedProxyList) this.addLog(`Rotating ${proxyCount(selectedProxyList)} proxy line(s) from "${proxyLabel(selectedProxyList)}"`);

    let completed = 0;
    let nextIndex = 0;

    const runOne = async (i) => {
      const email = emails[i];
      this.addLog(`[${i + 1}/${emails.length}] Generating account for ${email}...`);

      const args = [
        `--email=${email}`,
        `--password=${password}`,
        `--state=${state}`,
        // randomizeName forces the bot to pick its own random name even if the fields have text —
        // a batch of tournament sign-ups shouldn't all share one fixed identity.
        ...(!randomizeName && firstName ? [`--firstName=${firstName}`] : []),
        ...(!randomizeName && lastName ? [`--lastName=${lastName}`] : []),
        `--smsProvider=${smsProvider}`,
        `--smsApiKey=${smsApiKey}`,
        `--smsService=${smsService}`,
        ...(smsProvider === 'textverified' && smsApiUsername ? [`--smsApiUsername=${smsApiUsername}`] : []),
        // Both can be set at once — the bot scripts try AYCD first, then fall back to IMAP.
        ...(aycdApiKey ? [`--aycdApiKey=${aycdApiKey}`] : []),
        ...(imapUser && imapPass ? [`--imapHost=${imapHost}`, `--imapPort=${IMAP_PORT}`, `--imapUser=${imapUser}`, `--imapPass=${imapPass}`] : []),
        // hCaptcha solver (for Riot Games)
        ...(hcaptchaApiKey ? [`--hcaptchaApiKey=${hcaptchaApiKey}`, `--hcaptchaSolver=${hcaptchaSolver}`] : []),
        `--id=${email.split('@')[0]}`,
        ...(discordWebhook ? [`--webhook=${discordWebhook}`] : []),
      ];

      if (proxyLines.length) {
        // Random, not proxyLines[i]. Sequential meant account 0 always got proxy 0, account 1 got
        // proxy 1, and so on — so every user sharing this pool marched through the same first
        // entries together and burned them, while the rest of the list went untouched.
        const pick = proxyLines[Math.floor(Math.random() * proxyLines.length)];
        const [host, port, user, pass] = pick.split(':');
        if (host && port) {
          args.push(`--proxyServer=${host}:${port}`);
          if (user && pass) {
            args.push(`--proxyUser=${user}`);
            args.push(`--proxyPass=${pass}`);
          }
        }
      }

      // Suffixed with the loop index (not just email) so a duplicate email pasted twice into the
      // list still gets a distinct runId/data-dir instead of colliding.
      const runId = `gen-${activeModule}-${i}-${email}`;
      this.activeRunIds.add(runId);
      this.runLabels[runId] = email;

      try {
        // Managed credentials never cross into this renderer. Main resolves the stable ref and
        // injects one randomly-selected line immediately before the child process is launched.
        const result = await ipcRenderer.invoke('runBotScript', meta.script, args, runId, managedProxyRef);
        if (result.success) {
          this.addLog(`✓ Account created: ${email}`);
          // Register it on the Accounts tab, tagged "generated" so it shows "Genned at" there.
          try {
            ipcRenderer.sendSync('addGeneratedAccount', { email, password, site: activeModule });
            // Reload accounts from disk to ensure UI stays in sync
            const accounts = ipcRenderer.sendSync('getAccounts');
            this.props.dispatch({ type: 'update', obj: { accounts } });
          } catch (e) {
            this.addLog(`⚠ Account saved but UI update failed: ${e.message}`);
          }
        } else {
          this.addLog(`✗ Failed: ${email} - ${result.error}`);
        }
      } catch (e) {
        this.addLog(`✗ Error: ${email} - ${e.message}`);
      }

      this.activeRunIds.delete(runId);
      delete this.runLabels[runId];
      completed++;
      this.setState({ progress: (completed / emails.length) * 100 });
    };

    // Concurrency pool: each worker pulls the next unstarted email as soon as it's free, so a fast
    // account (or one that fails immediately) doesn't leave a slot idle waiting for the others —
    // simpler than pbandai-buyer's per-account-thread model since these runs don't need to share
    // any rotating resource beyond the proxy list (already assigned by index above, not by worker).
    const workerCount = Math.min(maxConcurrent, emails.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (nextIndex < emails.length) {
        if (this.stopRequested) return;
        const i = nextIndex++;
        await runOne(i);
      }
    });
    await Promise.all(workers);

    this.activeRunIds = new Set();
    this.setState({ isRunning: false });
    if (this.stopRequested) {
      this.addLog(`Stopped by user (${emails.length - completed} account(s) not completed).`);
    } else {
      this.addLog('Account generation complete!');
    }
  };

  // iCloud is NOT a loop-over-emails flow — one script invocation logs into ONE Apple ID and
  // generates CONFIG.count aliases under it (Apple rate-limits to 5/hour per Apple ID).
  startIcloudGeneration = async () => {
    const { appleEmail, applePassword, icloudCount, icloudLabel } = this.state;
    if (!appleEmail.trim() || !applePassword) {
      this.addLog('Error: Apple ID email and password are required');
      return;
    }
    const count = parseInt(icloudCount, 10) || 1;

    this.stopRequested = false;
    this.setState({ isRunning: true, logs: [], progress: 0, icloudAction: 'generate' });
    this.addLog(`Starting iCloud Hide My Email generation (${count} alias(es)) for ${appleEmail}...`);
    if (count > 5) this.addLog('⚠ Apple rate-limits Hide My Email to 5 generates/hour per Apple ID — some may fail or need to wait.');

    const args = [
      `--appleEmail=${appleEmail}`,
      `--applePassword=${applePassword}`,
      `--count=${count}`,
      ...(icloudLabel ? [`--label=${icloudLabel}`] : []),
      `--id=${appleEmail.split('@')[0]}`,
    ];

    const runId = `gen-icloud-${appleEmail}`;
    this.currentRunId = runId;
    this.runLabels[runId] = appleEmail;
    this.generatedAliases[runId] = [];
    try {
      const result = await ipcRenderer.invoke('runBotScript', 'icloud-register.mjs', args, runId);
      this.addLog(result.success ? `✓ Alias generation complete for ${appleEmail}` : `✗ Failed: ${result.error}`);
    } catch (e) {
      this.addLog(`✗ Error: ${e.message}`);
    }

    this.saveIcloudAliases(this.generatedAliases[runId] || []);
    delete this.generatedAliases[runId];

    delete this.runLabels[runId];
    this.currentRunId = null;
    this.setState({ isRunning: false, progress: 100, icloudAction: null });
    this.addLog(this.stopRequested ? 'Stopped by user.' : 'Done.');
  };

  // Registers every alias found — whether just created or scraped off an existing account — onto
  // the Accounts tab, tagged site 'icloud'. No independent password: an alias isn't its own login,
  // just an inbox address forwarding to the Apple ID it belongs to, so hasPassword correctly reads
  // false for these entries (see addGeneratedAccount + encryptSecret('') in data-manager.js).
  // Shared by startIcloudGeneration (even a partial/failed run can have created some) and
  // startIcloudScrape (may return hundreds at once for a long-lived Apple ID).
  saveIcloudAliases = (aliases) => {
    if (!aliases.length) return;
    try {
      for (const alias of aliases) ipcRenderer.sendSync('addGeneratedAccount', { email: alias, password: '', site: 'icloud' });
      const accounts = ipcRenderer.sendSync('getAccounts');
      this.props.dispatch({ type: 'update', obj: { accounts } });
      this.addLog(`  Saved ${aliases.length} alias(es) to the Accounts tab.`);
    } catch (e) {
      this.addLog(`⚠ Alias(es) found but saving to Accounts tab failed: ${e.message}`);
    }
  };

  // Fetches every alias ALREADY reserved under this Apple ID (icloud-register.mjs --mode=list) —
  // for a long-lived account where most of the ~750-alias cap was created before this app existed
  // or before generation started saving to the Accounts tab at all. No count/label needed: this
  // isn't creating anything new, just reading what's already there.
  startIcloudScrape = async () => {
    const { appleEmail, applePassword } = this.state;
    if (!appleEmail.trim() || !applePassword) {
      this.addLog('Error: Apple ID email and password are required');
      return;
    }

    this.stopRequested = false;
    this.setState({ isRunning: true, logs: [], progress: 0, icloudAction: 'scrape' });
    this.addLog(`Scraping existing iCloud aliases for ${appleEmail}...`);

    const args = [
      `--appleEmail=${appleEmail}`,
      `--applePassword=${applePassword}`,
      '--mode=list',
      `--id=${appleEmail.split('@')[0]}`,
    ];

    const runId = `scrape-icloud-${appleEmail}`;
    this.currentRunId = runId;
    this.runLabels[runId] = appleEmail;
    this.generatedAliases[runId] = [];
    try {
      const result = await ipcRenderer.invoke('runBotScript', 'icloud-register.mjs', args, runId);
      this.addLog(result.success ? `✓ Scrape complete for ${appleEmail}` : `✗ Failed: ${result.error}`);
    } catch (e) {
      this.addLog(`✗ Error: ${e.message}`);
    }

    this.saveIcloudAliases(this.generatedAliases[runId] || []);
    delete this.generatedAliases[runId];

    delete this.runLabels[runId];
    this.currentRunId = null;
    this.setState({ isRunning: false, progress: 100, icloudAction: null });
    this.addLog(this.stopRequested ? 'Stopped by user.' : 'Done.');
  };

  // Kills the CURRENTLY running account's browser/process immediately (not just "finish this one
  // then stop") and stops the loop from starting the next email — each rented SMS number costs
  // real money, so a stuck or unwanted run shouldn't be left going.
  stopGeneration = () => {
    this.stopRequested = true;
    // Kills every CURRENTLY running account's browser immediately (not just "let these finish then
    // stop the queue") — with concurrency this can be several at once, so iterate the whole set
    // instead of the old single currentRunId.
    if (this.activeRunIds) {
      for (const runId of this.activeRunIds) {
        try { ipcRenderer.send('stopBotScript', runId); } catch {}
      }
    }
    if (this.currentRunId) {
      try { ipcRenderer.send('stopBotScript', this.currentRunId); } catch {}
    }
    this.addLog('Stopping…');
  };

  render() {
    const {
      activeModule,
      password, state, firstName, lastName, randomizeName,
      smsProvider, smsApiUsername,
      imapHost, imapHostCustom, imapUser, imapPass, aycdApiKey,
      hcaptchaApiKey, hcaptchaSolver,
      showPassword, showSmsApiKey, showImapPass, showApplePassword, showAycdApiKey, showHcaptchaApiKey,
      proxyListName, concurrency,
      appleEmail, applePassword, icloudCount, icloudLabel, icloudAction,
      catchallModalOpen, catchallDomain, catchallCount,
      isRunning, progress, logs,
    } = this.state;
    const smsApiKey = this.currentApiKey();
    const emailList = this.currentEmailList();
    const smsService = this.currentSmsService();
    const proxyLists = (this.props.proxies || {}).lists || [];
    const isAccountModule = ACCOUNT_MODULES.has(activeModule);
    const toggleShow = (field) => this.setState(s => ({ [field]: !s[field] }));
    const eyeBtn = (field, shown) => (
      <button
        type="button"
        onClick={() => toggleShow(field)}
        title={shown ? 'Hide' : 'Show'}
        style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: 14, padding: 4, lineHeight: 1 }}
      >
        {shown ? '🙈' : '👁️'}
      </button>
    );

    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div className="page-header">
          <div className="page-title"><span className="page-title-dot" /> Generate</div>
          <div className="page-actions">
            {isRunning && <span className="badge badge-running">Generating… {Math.round(progress)}%</span>}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, padding: '12px 20px 0' }}>
          {GENERATE_MODULES.filter(m => !m.hidden && (!m.devOnly || this.props.channel === 'dev')).map(m => (
            <button
              key={m.value}
              className="btn btn-sm"
              onClick={() => this.setState({ activeModule: m.value }, this.persistConfig)}
              style={activeModule === m.value
                ? { background: 'var(--accent-fill)', color: 'var(--accent-on)', border: 'none' }
                : { background: 'var(--btn)', color: 'var(--text2)' }}
            >
              {m.emoji} {m.label}
            </button>
          ))}
        </div>

        <div className="page-content" style={{ display: 'grid', gridTemplateColumns: '1fr 380px', gap: 14, alignItems: 'start' }}>
          {isAccountModule && (
          <div className="settings-section">
            <div className="settings-section-title">{MODULE_META[activeModule].siteName} Account Settings</div>

            <div className="form-group">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <label className="form-label" style={{ marginBottom: 0 }}>Email List <span style={{ color: 'var(--dim)', fontWeight: 400 }}>(one per line)</span></label>
                <div style={{ display: 'flex', gap: 6 }}>
                  {!isRunning && emailList.trim() && (
                    <button type="button" className="btn btn-primary btn-sm" onClick={this.startGeneration}>
                      Generate
                    </button>
                  )}
                  <button type="button" className="btn btn-secondary btn-sm" onClick={this.openCatchallModal} title="Generate random emails on a domain that routes everything to your inbox">
                    Catchall
                  </button>
                </div>
              </div>
              <textarea
                className="form-textarea"
                value={emailList}
                onChange={e => this.setEmailList(e.target.value)}
                placeholder={'email1@gmail.com\nemail2@gmail.com\nemail3@gmail.com'}
              />
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', marginBottom: 10 }}>
              <input
                type="checkbox"
                checked={randomizeName}
                onChange={e => this.setState({ randomizeName: e.target.checked }, this.persistConfig)}
                style={{ accentColor: 'var(--accent)', width: 14, height: 14 }}
              />
              <span style={{ fontSize: 12, color: 'var(--text2)' }}>Randomize name</span>
            </label>

            <div className="form-row">
              <div className="form-group">
                <label className="form-label">First Name</label>
                <input className="form-input" type="text" name="firstName" value={firstName} onChange={this.handleInputChange} placeholder="Random" disabled={randomizeName} />
              </div>
              <div className="form-group">
                <label className="form-label">Last Name</label>
                <input className="form-input" type="text" name="lastName" value={lastName} onChange={this.handleInputChange} placeholder="Random" disabled={randomizeName} />
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Password</label>
                <div style={{ position: 'relative' }}>
                  <input className="form-input" style={{ paddingRight: 30 }} type={showPassword ? 'text' : 'password'} name="password" value={password} onChange={this.handleInputChange} />
                  {eyeBtn('showPassword', showPassword)}
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">State</label>
                <select className="form-select" name="state" value={state} onChange={this.handleInputChange}>
                  {US_STATES.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
            </div>

            <hr className="form-divider" />
            <div className="settings-section-title" style={{ marginBottom: 12 }}>SMS Provider</div>

            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Provider</label>
                <select className="form-select" name="smsProvider" value={smsProvider} onChange={this.handleInputChange}>
                  {SMS_PROVIDERS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">API Key</label>
                <div style={{ position: 'relative' }}>
                  <input className="form-input" style={{ paddingRight: 30 }} type={showSmsApiKey ? 'text' : 'password'} value={smsApiKey} onChange={this.handleApiKeyChange} placeholder="Your API key" />
                  {eyeBtn('showSmsApiKey', showSmsApiKey)}
                </div>
              </div>
            </div>

            {smsProvider === 'textverified' && (
              <div className="form-group">
                <label className="form-label">API Username</label>
                <input className="form-input" type="text" name="smsApiUsername" value={smsApiUsername} onChange={this.handleInputChange} placeholder="Your TextVerified account email/username" />
                <div className="form-hint">TextVerified's API requires this alongside the key.</div>
              </div>
            )}

            <div className="form-group">
              <label className="form-label">Service Slug</label>
              <input className="form-input" type="text" value={smsService} onChange={e => this.setSmsService(e.target.value)} placeholder={MODULE_META[activeModule].defaultSmsService} />
              <div className="form-hint">Must match a service your provider's catalog actually lists — these providers sell numbers per target site, and most don't list {MODULE_META[activeModule].siteName} by default. Check your provider's dashboard for a matching or "any site" slug.</div>
            </div>

            <hr className="form-divider" />
            <div className="settings-section-title" style={{ marginBottom: 12 }}>Email Auth Code</div>

            <div className="form-group">
              <label className="form-label">AYCD API Key <span style={{ color: 'var(--dim)', fontWeight: 400 }}>(optional)</span></label>
              <div style={{ position: 'relative' }}>
                <input className="form-input" style={{ paddingRight: 30 }} type={showAycdApiKey ? 'text' : 'password'} name="aycdApiKey" value={aycdApiKey} onChange={this.handleInputChange} placeholder="AYCD Inbox API key" />
                {eyeBtn('showAycdApiKey', showAycdApiKey)}
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">IMAP Host <span style={{ color: 'var(--dim)', fontWeight: 400 }}>(optional)</span></label>
              <select className="form-select" name="imapHost" value={imapHost} onChange={this.handleInputChange}>
                {IMAP_PROVIDERS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </div>

            {imapHost === 'custom' && (
              <div className="form-group">
                <label className="form-label">Custom IMAP Host</label>
                <input className="form-input" type="text" name="imapHostCustom" value={imapHostCustom} onChange={this.handleInputChange} placeholder="imap.example.com" />
              </div>
            )}

            <div className="form-row">
              <div className="form-group">
                <label className="form-label">IMAP User</label>
                <input className="form-input" type="email" name="imapUser" value={imapUser} onChange={this.handleInputChange} placeholder="your-email@gmail.com" />
              </div>
              <div className="form-group">
                <label className="form-label">IMAP Password</label>
                <div style={{ position: 'relative' }}>
                  <input className="form-input" style={{ paddingRight: 30 }} type={showImapPass ? 'text' : 'password'} name="imapPass" value={imapPass} onChange={this.handleInputChange} placeholder="App password" />
                  {eyeBtn('showImapPass', showImapPass)}
                </div>
              </div>
            </div>

            {imapHost === 'imap.gmail.com' && (
              <div className="form-hint" style={{ display: 'flex', gap: 12, marginTop: -6 }}>
                <a href="https://myaccount.google.com/apppasswords" onClick={e => openExternal(e, 'https://myaccount.google.com/apppasswords')} className="text-purple">Get IMAP Password</a>
                <a href="https://www.youtube.com/watch?v=lJI0uvwH3_0" onClick={e => openExternal(e, 'https://www.youtube.com/watch?v=lJI0uvwH3_0')} className="text-purple">Learn How To Get Emails</a>
              </div>
            )}

            <hr className="form-divider" />
            <div className="settings-section-title" style={{ marginBottom: 12 }}>hCaptcha Solver <span style={{ color: 'var(--dim)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(for Riot Games)</span></div>

            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Solver Service</label>
                <select className="form-select" name="hcaptchaSolver" value={hcaptchaSolver} onChange={this.handleInputChange}>
                  <option value="2captcha">2Captcha ($1-2 per 1000)</option>
                  <option value="anticaptcha">Anticaptcha (similar pricing)</option>
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">API Key</label>
                <div style={{ position: 'relative' }}>
                  <input className="form-input" style={{ paddingRight: 30 }} type={showHcaptchaApiKey ? 'text' : 'password'} name="hcaptchaApiKey" value={hcaptchaApiKey} onChange={this.handleInputChange} placeholder="Your solver API key" />
                  {eyeBtn('showHcaptchaApiKey', showHcaptchaApiKey)}
                </div>
              </div>
            </div>
            <div className="form-hint">Get your API key from <a href="https://2captcha.com" onClick={e => openExternal(e, 'https://2captcha.com')} className="text-purple">2captcha.com</a> or <a href="https://anti-captcha.com" onClick={e => openExternal(e, 'https://anti-captcha.com')} className="text-purple">anti-captcha.com</a>. Fund your account with $1+ to enable hCaptcha solving.</div>

            <hr className="form-divider" />
            <div className="settings-section-title" style={{ marginBottom: 12 }}>Proxy <span style={{ color: 'var(--dim)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(optional)</span></div>

            <div className="form-group">
              <label className="form-label">Proxy List</label>
              <select className="form-select" name="proxyListName" value={proxyListName} onChange={this.handleInputChange}>
                <option value="">None (home IP)</option>
                {proxyLists.map(l => <option key={proxyRef(l)} value={proxyRef(l)}>{proxyLabel(l)}</option>)}
              </select>
            </div>

            <hr className="form-divider" />
            <div className="settings-section-title" style={{ marginBottom: 12 }}>Concurrency</div>

            <div className="form-group">
              <label className="form-label">Accounts running at once</label>
              <input
                className="form-input"
                type="number"
                name="concurrency"
                min={1}
                max={MAX_CONCURRENCY}
                value={concurrency}
                onChange={this.handleInputChange}
                style={{ width: 110 }}
              />
              {parseInt(concurrency, 10) > CONCURRENCY_ADVISED && (
                <div className="form-hint" style={{ marginTop: 4, lineHeight: 1.4 }}>
                  Each account is a real Chromium window, an SMS number and an IMAP connection.
                  Past about {CONCURRENCY_ADVISED} the limit is usually your mail provider — Gmail
                  allows roughly 15 connections per account — and it shows up as tasks hanging on the
                  email code.
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
              <button
                className="btn btn-primary"
                onClick={this.startGeneration}
                disabled={isRunning || !emailList.trim()}
                style={{ flex: 1 }}
              >
                {isRunning ? `⚙️ Generating… ${Math.round(progress)}%` : `🪄 Generate Accounts`}
              </button>
              {isRunning && (
                <button className="btn btn-danger" onClick={this.stopGeneration} title="Kills the current account's browser immediately and skips the rest">
                  ⛔ Stop All
                </button>
              )}
            </div>

            {isRunning && (
              <div style={{ width: '100%', height: 4, background: 'var(--field)', borderRadius: 3, overflow: 'hidden', marginTop: 10 }}>
                <div style={{ height: '100%', width: `${progress}%`, background: 'var(--accent-fill)', transition: 'width 0.3s' }} />
              </div>
            )}
          </div>
          )}

          {activeModule === 'icloud' && (
            <div className="settings-section">
              <div className="settings-section-title">iCloud Hide My Email</div>
              <div className="form-hint" style={{ marginBottom: 14 }}>
                This is NOT account creation — it generates disposable email ALIASES under an Apple ID you
                already own (with active iCloud+). Apple rate-limits this to 5 generates/hour per Apple ID.
              </div>

              <div className="form-group">
                <label className="form-label">Apple ID Email</label>
                <input className="form-input" type="email" name="appleEmail" value={appleEmail} onChange={this.handleInputChange} placeholder="you@icloud.com" />
              </div>

              <div className="form-group">
                <label className="form-label">Apple ID Password</label>
                <div style={{ position: 'relative' }}>
                  <input className="form-input" style={{ paddingRight: 30 }} type={showApplePassword ? 'text' : 'password'} name="applePassword" value={applePassword} onChange={this.handleInputChange} />
                  {eyeBtn('showApplePassword', showApplePassword)}
                </div>
                <div className="form-hint">If your Apple ID needs 2FA, the browser window will pause and ask for the code — enter it there.</div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">How many aliases?</label>
                  <input className="form-input" type="number" min="1" name="icloudCount" value={icloudCount} onChange={this.handleInputChange} />
                </div>
                <div className="form-group">
                  <label className="form-label">Label <span style={{ color: 'var(--dim)', fontWeight: 400 }}>(optional)</span></label>
                  <input className="form-input" type="text" name="icloudLabel" value={icloudLabel} onChange={this.handleInputChange} placeholder="e.g. Tournament signups" />
                </div>
              </div>

              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <button
                  className="btn btn-primary"
                  onClick={this.startIcloudGeneration}
                  disabled={isRunning || !appleEmail.trim() || !applePassword}
                  style={{ flex: 1 }}
                >
                  {isRunning && icloudAction === 'generate' ? `⚙️ Generating…` : `🪄 Generate Aliases`}
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={this.startIcloudScrape}
                  disabled={isRunning || !appleEmail.trim() || !applePassword}
                  title="Fetch every alias already reserved under this Apple ID and add them to the Accounts tab — for aliases made before this app tracked them"
                  style={{ flex: 1 }}
                >
                  {isRunning && icloudAction === 'scrape' ? `⚙️ Scraping…` : `🔎 Scrape Emails`}
                </button>
                {isRunning && (
                  <button className="btn btn-danger" onClick={this.stopGeneration} title="Kills the current run immediately">
                    ⛔ Stop
                  </button>
                )}
              </div>
            </div>
          )}

          <div className="settings-section" style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <span className="settings-section-title" style={{ margin: 0, padding: 0, border: 'none' }}>Logs <span style={{ color: 'var(--dim)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(HAR capture enabled)</span></span>
              {logs.length > 0 && (
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="btn btn-secondary btn-sm" onClick={this.copyLogs}>Copy</button>
                  <button className="btn btn-secondary btn-sm" onClick={this.clearLogs}>Clear</button>
                </div>
              )}
            </div>
            <div style={{ overflowY: 'auto', background: 'var(--field)', border: '1px solid var(--field-border)', borderRadius: 8, padding: 10, minHeight: 400, maxHeight: 'calc(100vh - 220px)' }}>
              {logs.length === 0
                ? <div style={{ color: 'var(--muted)', fontSize: 11, fontStyle: 'italic' }}>No output yet.</div>
                : logs.map((l, i) => <div key={i} className="log-line">{l}</div>)}
            </div>
          </div>
        </div>

        {catchallModalOpen && (
          <div className="modal-overlay" onMouseDown={e => e.target === e.currentTarget && this.closeCatchallModal()}>
            <div className="modal modal-sm">
              <div className="modal-header">
                <span className="modal-title">Catchall Email Generator</span>
                <button className="modal-close" onClick={this.closeCatchallModal}>✕</button>
              </div>
              <div className="modal-body">
                <div className="form-group">
                  <label className="form-label">Domain</label>
                  <input
                    className="form-input"
                    type="text"
                    value={catchallDomain}
                    onChange={e => this.setState({ catchallDomain: e.target.value })}
                    placeholder="heldmedown.com or @heldmedown.com"
                    autoFocus
                  />
                  <div className="form-hint">Either form works — the @ is added automatically if missing.</div>
                </div>
                <div className="form-group">
                  <label className="form-label">How many emails?</label>
                  <input
                    className="form-input"
                    type="number"
                    min="1"
                    value={catchallCount}
                    onChange={e => this.setState({ catchallCount: e.target.value })}
                    onKeyDown={e => e.key === 'Enter' && this.submitCatchallModal()}
                  />
                </div>
              </div>
              <div className="modal-footer">
                <button className="btn btn-secondary" onClick={this.closeCatchallModal}>Cancel</button>
                <button className="btn btn-primary" onClick={this.submitCatchallModal} disabled={!catchallDomain.trim()}>Generate</button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }
}

export default connect(s => ({ proxies: s.proxies, settings: s.settings, accounts: s.accounts, channel: s.channel }))(Generate);
