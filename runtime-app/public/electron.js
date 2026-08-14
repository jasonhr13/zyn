const { app, BrowserWindow, ipcMain, Menu, clipboard, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const url = require('url');
const log = require('electron-log');
const { Client, Intents } = require('discord.js');

const dm = require('./helpers/data-manager');
const th = require('./helpers/task-handler');
const targetEngine = require('./helpers/target-engine');
const lic = require('./helpers/license');
const licClient = require('./helpers/license-client');
const reporter = require('./helpers/checkout-reporter');
const aycd = require('./helpers/aycd-profiles');
const nodeCrypto = require('crypto');
const discordMonitor = require('./helpers/discord-monitor');

// The deployed dashboard: single-instance lock, "reset closes the bot", and checkout analytics.
const DASHBOARD_URL = 'https://secret-lair-dashboard.vercel.app';
let licenseSession = null;   // the dashboard claim/heartbeat session for this run
// Set the moment the dashboard refuses a running session; cleared only by a successful activation.
// This outranks lic.cached(), because a periodic re-check can be in flight when the denial lands and
// would otherwise resolve afterwards with a stale ok:true and quietly unlock the app again — the key
// itself is still valid, it just is not ours to run. It also makes the gate survive a lost IPC push:
// the renderer asks for status on mount, and gets this.
let revokedStatus = null;
let activating = false;      // true while the gate is trying a key, so denials report inline, not as a modal
let buyerDiscord = '';       // the key owner's Discord (for the checkout webhook's Buyer field)
let buyerDiscordId = '';   // numeric Discord id, so the collector can post a real mention

log.transports.file.level = 'info';

// Repeated black-screen-on-app-switch reports where the renderer had died: the classic cause is GPU
// compositing losing the surface when the window is backgrounded/restored on Windows. This UI has no
// GPU-dependent content (no canvas/video/3D), so software compositing costs nothing and removes the
// whole failure class. Must be called before the app is ready.
app.disableHardwareAcceleration();

// ONE copy of the bot per machine.
//
// The Target/Walmart engine bridges are WebSocket servers hosted by THIS process (:8727 / :8728), so
// a second copy cannot bind them and dies with "listen EADDRINUSE ... 127.0.0.1:8727". That error is
// therefore never a stale child — a socket dies with the process holding it — it always means a
// second live instance. The lock is the whole fix for it.
//
// It is also correct on its own terms: the product already allows one instance per license key on
// the dashboard (see the 'in_use' denial below), so a second local copy was never supported. Two
// copies would also run two bots against the same accounts, cards, and the 2-per-4h order cap.
//
// Gated on an env var rather than app.isPackaged deliberately: the collision that prompted this was
// a dev `electron .` fighting an installed build, and exempting dev would leave that case broken.
if (!process.env.ZYN_ALLOW_MULTI && !app.requestSingleInstanceLock()) {
  app.quit();
  return;   // legal at module top level (CommonJS wrapper) — and load-bearing: the loser must skip
             // every registration below, or it would still spawn children and bind ports on its way out.
}
app.on('second-instance', (_e, argv) => {
  // Launching again should raise the copy that is already running, not fail silently.
  // On Windows a zyn:// click does NOT start a new app — the OS runs the exe again, that copy loses
  // the single-instance lock above, and its argv arrives here. So this is the ONLY place a deep link
  // reaches an app that is already open, which is the normal case during a drop.
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
  handleDeepLink(deepLinkFromArgv(argv));
});

// ── zyn:// deep links ────────────────────────────────────────────────────────────────────────
// A monitor post carries a LINK button, not a normal Discord button. A normal button's click is
// delivered to the bot that POSTED it — the operator's machine — so it could never reach a user's
// copy of Zyn. A link button opens a URL instead, and the OS routes zyn:// to whichever install is
// registered locally. That is what makes one shared monitor channel able to arm every user's own bot.
//
// setAsDefaultProtocolClient registers the running exe. In dev, `electron .` must also pass its own
// path and the project dir, or Windows would register electron.exe itself and every zyn:// click
// would open a bare Electron instead of Zyn.
const DEEP_LINK_SCHEME = 'zyn';
try {
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME, process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
  }
} catch {}

// Windows hands the URL as a plain argv entry, mixed in with Chromium's own switches.
function deepLinkFromArgv(argv) {
  const hit = (argv || []).find((a) => typeof a === 'string' && a.startsWith(`${DEEP_LINK_SCHEME}://`));
  return hit || '';
}

let pendingDeepLink = '';   // arrived before the window existed; flushed once the renderer is ready

// Parse and validate a zyn:// URL. Returns a plain object for the renderer, or null.
//
// Deliberately strict. Registering a protocol means ANY web page or chat message can hand this
// function a URL, so it is an untrusted input path into a bot that spends money. Only the one action
// is accepted, only the two sites that have engines, and the SKU has to look like that site's own
// identifier — the same shapes monitor-parse enforces, applied again because a deep link can arrive
// from somewhere that never went through the parser.
const QUICKTASK_SKU = { target: /^\d{6,12}$/, pbandai: /^[A-Z]{1,3}\d{6,12}$/i };

function parseDeepLink(raw) {
  if (!raw) return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== `${DEEP_LINK_SCHEME}:`) return null;
  // zyn://quicktask?... parses with host="quicktask" and an empty path.
  const action = (u.host || u.pathname.replace(/^\/+/, '')).toLowerCase();
  if (action !== 'quicktask') return { error: `unknown action "${action}"` };

  const site = String(u.searchParams.get('site') || '').toLowerCase();
  const sku = String(u.searchParams.get('sku') || '').trim();
  const qty = parseInt(u.searchParams.get('qty') || '1', 10);

  if (!QUICKTASK_SKU[site]) return { error: `unsupported site "${site}"` };
  if (!QUICKTASK_SKU[site].test(sku)) return { error: `"${sku}" is not a valid ${site} SKU` };

  return {
    action: 'quicktask',
    site,
    sku,
    // Cart limits on these monitors are 2-4; anything larger is a malformed or hostile link, and a
    // silently-clamped 1 is safer than carting 500.
    qty: Number.isFinite(qty) && qty > 0 && qty <= 10 ? qty : 1,
    name: String(u.searchParams.get('name') || '').slice(0, 160),
    price: String(u.searchParams.get('price') || '').slice(0, 40),
  };
}

// Hand it to the renderer to ARM — never to fire. The renderer shows the SKU, the retailer and which
// Quick Task profiles would run, and waits for a click. A deep link that bought something on arrival
// would mean any link anywhere could spend a user's money.
function handleDeepLink(raw) {
  const req = parseDeepLink(raw);
  if (!req) return;
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.webContents) {
    pendingDeepLink = raw;   // cold start: the window is not up yet
    return;
  }
  try { mainWindow.webContents.send('quickTaskArmed', req); } catch {}
}

// macOS delivers deep links as an event rather than argv.
app.on('open-url', (e, url) => { e.preventDefault(); handleDeepLink(url); });

let mainWindow;
let discordClient = null;
let updateTimer = null;    // hourly update check — cleared on teardown
let licenseTimer = null;   // 30-min license re-check — cleared on teardown
let discordStatusCache = { status: 'disconnected' };

function sendDiscordStatus(data) {
  discordStatusCache = data;
  mainWindow?.webContents?.send('discordStatus', data);
}

// ── Queue-pass parsing ──────────────────────────────────────────────────────────────
// A "successful queue pass" message (StellarAIO posts these, sometimes as an embed) carries a
// secretlair /us/cart?qitq=… bypass URL and optionally the paired proxy the token is bound to.
function parseQueuePass(message) {
  // Gather EVERY text-bearing part — StellarAIO posts these as an embed and the "Successful Queue
  // Pass" marker / URL / proxy can live in the title, description, author, footer, or any field.
  const parts = [message.content || ''];
  for (const emb of (message.embeds || [])) {
    parts.push(emb.title || '', emb.description || '', emb.url || '');
    if (emb.author) parts.push(emb.author.name || '');
    if (emb.footer) parts.push(emb.footer.text || '');
    for (const f of (emb.fields || [])) parts.push(`${f.name}: ${f.value}`);
  }
  const text = parts.join('\n');
  if (!/successful queue pass/i.test(text)) return null;
  const match = text.match(/https:\/\/secretlair\.wizards\.com\/us\/cart\?[^\s\n<>"]+/i);
  if (!match) return null;
  const cartUrl = match[0].replace(/[.,)>\]]+$/, '');
  // Paired proxy host:port[:user:pass] — the endpoint the queue was cleared through. Queue-It binds
  // the token to that IP, so losing this means the task replays from the wrong address and fails.
  //
  // Accepts HOSTNAMES, not just dotted IPs: gateway providers hand out entries like
  // "premium.resifactory.net:7777:user:pass", which the old IP-only pattern silently missed —
  // every such pass was pooled with "(no paired proxy)".
  // \W{0,8} (not [^\d]) for the gap after "Proxy": a non-digit run would eat into a hostname's
  // leading letters, while non-word stops cleanly at the first character of the host.
  // The credential run excludes | * and backtick because the proxy is posted inside Discord markup:
  // ||spoiler|| most often, sometimes **bold** or `code`. Those wrapper characters were being
  // captured as part of the password — "cuTdXlcTSMkQ||" instead of "cuTdXlcTSMkQ" — and a password
  // with two junk characters is refused by the proxy with a 407 that looks exactly like a dead
  // proxy. Underscore and ~ stay allowed: real usernames contain them
  // (e.g. ResiFactory_540bd662~us~30ee3541~60).
  const pm = text.match(/proxy\W{0,8}([A-Za-z0-9][A-Za-z0-9.\-]*:\d{2,5}(?::[^\s\n<>"`|*]+){0,2})/i);
  return { cartUrl, proxy: pm ? pm[1].trim() : null };
}

function emitQueuePass(pass, sim = false) {
  if (!pass) return;
  log.info(`${sim ? '[sim] ' : ''}Queue pass:`, pass.cartUrl, pass.proxy ? `(proxy ${pass.proxy.split(':')[0]})` : '(no paired proxy)');
  // The renderer dedups by qitq and freshness-filters by qitts, so replays/stale links are harmless.
  // sim bypasses the single-use guard so the same historical link can be replayed repeatedly.
  mainWindow?.webContents?.send('queuePass', { cartUrl: pass.cartUrl, proxy: pass.proxy, sim });
}

// Pull recent queue passes from the channel history so "Arm"/"Start" can grab a link posted before
// the app connected or between live events — this is the "use the newest bypass" path. Emits
// oldest→newest; the renderer sorts newest-first and drops anything too old to still bypass.
async function fetchRecentQueuePasses(client, channelId, limit = 25) {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.messages) return;
    const msgs = await channel.messages.fetch({ limit });
    const passes = [...msgs.values()]
      .sort((a, b) => (a.createdTimestamp || 0) - (b.createdTimestamp || 0))
      .map(parseQueuePass)
      .filter(Boolean);
    passes.forEach(emitQueuePass);
    log.info(`Fetched ${passes.length} recent queue pass(es) from channel history`);
  } catch (err) {
    log.warn('fetchRecentQueuePasses failed:', err.message);
  }
}

// Replays real queue passes out of this channel's history so a drop can be rehearsed on demand
// (`.sim` / `.sim 12` in the channel). Deliberately staggered rather than dumped all at once: real
// passes trickle in over seconds, and that timing is what exercises the claim path's re-entrancy —
// a burst delivered in one tick would not.
//
// Emitted with sim:true so the renderer's single-use guard lets an already-spent token back into
// the pool. Without that, `.sim` would work exactly once and then silently do nothing.
async function simulateDrop(client, channelId, count) {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.messages) return;
    const msgs = await channel.messages.fetch({ limit: 100 });
    const passes = [...msgs.values()]
      .sort((a, b) => (b.createdTimestamp || 0) - (a.createdTimestamp || 0))   // newest first
      .map(parseQueuePass)
      .filter(Boolean)
      .slice(0, Math.max(1, Math.min(50, count)));

    if (!passes.length) {
      log.warn(`[sim] no queue passes found in the last 100 messages of ${channelId}`);
      return;
    }
    // Strip the paired proxy on replay. It was valid at the time of the original drop — these are
    // session-bound gateway entries (…~60 = a 60-minute session) — so on a rehearsal it points at a
    // long-dead session and every task stalls before the browser loads. Dropping it lets the task
    // fall back to its own configured proxy group, which is what makes the rehearsal exercise the
    // real browser path. A LIVE pass always keeps its paired proxy; this only applies to .sim.
    const stripped = passes.filter((p) => p.proxy).length;
    log.info(`[sim] replaying ${passes.length} queue pass(es) over ~${(passes.length * 0.4).toFixed(1)}s` +
      (stripped ? ` — dropped ${stripped} expired paired prox${stripped === 1 ? 'y' : 'ies'}, tasks will use their own group` : ''));
    passes.forEach((p, i) => setTimeout(() => emitQueuePass({ ...p, proxy: null }, true), i * 400));
  } catch (err) {
    log.warn('[sim] failed:', err.message);
  }
}

// ── Discord listener ──────────────────────────────────────────────────────────────
function startDiscordListener(settings) {
  if (discordClient) {
    try { discordClient.destroy(); } catch {}
    discordClient = null;
  }

  const token = settings.discordBotToken;
  const channelId = settings.discordChannelId || '1352200333648068648';

  if (!token) {
    sendDiscordStatus({ status: 'no_token' });
    return;
  }

  sendDiscordStatus({ status: 'connecting' });

  try {
    const client = new Client({
      intents: [
        Intents.FLAGS.GUILDS,
        Intents.FLAGS.GUILD_MESSAGES,
        Intents.FLAGS.MESSAGE_CONTENT,
      ],
    });

    client.once('ready', () => {
      log.info('Discord ready:', client.user.tag);
      sendDiscordStatus({ status: 'connected', tag: client.user.tag });
      fetchRecentQueuePasses(client, channelId); // seed the pool with the latest posted passes
    });

    client.on('messageCreate', (message) => {
      // `.sim [n]` is handled BEFORE the channel filter and replays from whichever channel it was
      // typed in — so you can rehearse against an archive channel full of past passes without
      // repointing discordChannelId away from the live one. No message is posted back to Discord;
      // the trigger is only observed.
      const sim = /^\s*\.sim\b\s*(\d+)?/i.exec(message.content || '');
      if (sim && !message.author.bot) {
        simulateDrop(client, message.channelId, parseInt(sim[1], 10) || 5);
        return;
      }
      if (message.channelId !== channelId) return;
      emitQueuePass(parseQueuePass(message));
    });

    client.on('error', (err) => {
      log.error('Discord error:', err.message);
      sendDiscordStatus({ status: 'error', message: err.message });
    });

    client.on('invalidated', () => {
      sendDiscordStatus({ status: 'disconnected' });
      discordClient = null;
      // Auto-reconnect after 10 seconds
      setTimeout(() => startDiscordListener(dm.getSettings()), 10000);
    });

    client.login(token).catch((err) => {
      log.error('Discord login failed:', err.message);
      sendDiscordStatus({ status: 'error', message: err.message });
      discordClient = null;
    });

    discordClient = client;
  } catch (err) {
    log.error('Discord setup failed:', err.message);
    sendDiscordStatus({ status: 'error', message: err.message });
  }
}

// ── Auto-update ───────────────────────────────────────────────────────────────────
// Installers are published to the PUBLIC repo z04231992/secret-lair-releases so testers'
// clients can fetch them anonymously. The source repo stays private — pointing the updater
// there would 404 without an embedded token, and that token would be readable in app.asar.
// Only runs in a packaged build; electron-updater is a no-op (and throws) in dev.
let _autoUpdater = null;   // set once packaged; the Settings "Check for updates" button uses it

// BUG FIX (reported live 2026-07-20): electron-updater's own error messages frequently embed the
// full feed URL — e.g. a 404 quotes the exact GitHub download URL, including the repo path. That
// raw text used to be sent straight to the renderer and shown to the user, so anyone screen-
// sharing/screenshotting an update error leaked exactly where releases are hosted. Used at every
// spot an updater error reaches the UI; the untouched message still goes to the local log file
// (via log.warn below) for real debugging.
function redactUrls(text) {
  return String(text).replace(/https?:\/\/\S+/g, '[link removed]');
}

function initAutoUpdate() {
  if (!app.isPackaged) { log.info('auto-update: skipped (dev build)'); return; }
  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); }
  catch (e) { log.warn('auto-update: electron-updater unavailable —', e.message); return; }
  _autoUpdater = autoUpdater;

  const push = (data) => { try { mainWindow?.webContents?.send('updateStatus', data); } catch {} };
  autoUpdater.logger = log;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;   // silently applies on next quit if never restarted

  autoUpdater.on('checking-for-update', () => log.info('auto-update: checking…'));
  autoUpdater.on('update-not-available', () => push({ state: 'current' }));
  autoUpdater.on('update-available', (i) => { log.info('auto-update: found', i.version); push({ state: 'downloading', version: i.version, percent: 0 }); });
  autoUpdater.on('download-progress', (p) => push({ state: 'downloading', percent: Math.round(p.percent || 0) }));
  autoUpdater.on('update-downloaded', (i) => { log.info('auto-update: ready', i.version); push({ state: 'ready', version: i.version }); });
  autoUpdater.on('error', (e) => { log.warn('auto-update error:', e && e.message); push({ state: 'error', message: redactUrls(String((e && e.message) || e)).slice(0, 120) }); });

  // Tear EVERYTHING down before installing. A surviving child (a Secret Lair task and its Chromium
  // tree, the Go engines, the Shape farmer) keeps file handles open inside resources/, and NSIS
  // cannot replace a locked file — so the installer aborts, the app reopens on the old version, and
  // the update is still offered. That loop is what users hit: "it just closes and the update is
  // still available". The short delay lets the OS actually release those handles before we quit.
  ipcMain.on('installUpdate', () => {
    teardownAll();
    setTimeout(() => autoUpdater.quitAndInstall(), 1200);
  });
  // Report "you're up to date" explicitly on a manual check — silence reads as "it's broken".
  autoUpdater.on('update-not-available', () => push({ state: 'current', version: app.getVersion() }));

  autoUpdater.checkForUpdates().catch(() => {});
  updateTimer = setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 60 * 60 * 1000);
}

// ── Window ────────────────────────────────────────────────────────────────────────
// Claim this key's single-instance slot on the dashboard, and keep a heartbeat so a Reset (or a
// disable) from the dashboard closes the bot within ~15s. Fail-open: a dashboard outage never blocks
// a launch (the license.js gate still applies). Legacy gist keys are simply skipped (reason=invalid).
// Drop back to the key gate after the dashboard refuses a running session.
//
// This used to call app.quit(), which made the app impossible to recover: the rejected key is still
// in settings, so the next launch re-claims it, is denied again and closes again — a loop with no
// window alive long enough to type a different key into. The person holding the key may not be
// reachable to reset it, so quitting is the one response that helps nobody. Stop the bots, forget
// the key, and hand back the same gate they activated at, with the reason on screen.
//
// Clearing the key is what breaks the loop: with settings empty the next launch shows the gate
// directly rather than re-claiming a key it already knows is refused.
function revokeToGate(reason, message) {
  revokedStatus = { ok: false, reason: message || reason, key: '' };
  stopAllRunning();
  try { licenseSession && licenseSession.stop(); } catch {}
  licenseSession = null;              // lets initLicenseLock() claim again once a new key activates
  try { dm.saveSettings({ ...dm.getSettings(), licenseKey: '' }); } catch {}
  lic.invalidate(reason);             // refuse spawns now, not at the next re-check
  try { mainWindow?.webContents?.send('licenseStatus', revokedStatus); } catch {}
  try { if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); } } catch {}
  log.warn(`[license] returned to gate: ${reason}`);
}

// Non-blocking so the gate paints behind it; showErrorBox would freeze the main process until
// dismissed, and a dead-looking window is exactly what we are trying to stop shipping.
function notify(title, detail) {
  try {
    const opts = { type: 'warning', title, message: title, detail, buttons: ['OK'], noLink: true };
    const p = mainWindow && !mainWindow.isDestroyed()
      ? dialog.showMessageBox(mainWindow, opts)
      : dialog.showMessageBox(opts);
    Promise.resolve(p).catch(() => {});
  } catch (e) { log.warn('notify:', e && e.message); }
}

async function initLicenseLock() {
  const key = (dm.getSettings().licenseKey || '').trim();
  if (!key || licenseSession) return;
  licenseSession = licClient.startLicense({
    apiBase: DASHBOARD_URL,
    key,
    log: (m) => log.info(m),
    // What this copy is doing, read fresh on every heartbeat.
    getActivity: () => {
      let mod = '';
      let tasks = 0;
      try {
        const t = targetEngine.runningCount ? targetEngine.runningCount() : 0;
        if (t > 0) { mod = 'target'; tasks = t; }
      } catch {}
      try {
        if (!tasks && th.runningRound1Count) {
          const r = th.runningRound1Count();
          if (r > 0) { mod = 'round1'; tasks = r; }
        }
      } catch {}
      return { module: mod, tasks, version: app.getVersion() };
    },
    onFleetControl: ({ disabledModules, notice }) => {
      const before = fleetDisabled.join(',');
      fleetDisabled = disabledModules || [];
      fleetNotice = notice || '';
      if (before !== fleetDisabled.join(',')) {
        log.info(`[fleet] disabled modules: ${fleetDisabled.join(', ') || '(none)'}`);
        try { mainWindow?.webContents?.send('fleetControl', { disabledModules: fleetDisabled, notice: fleetNotice }); } catch {}
      }
    },
    onIdentity: (d) => {
      buyerDiscord = (d && d.username) || '';
      // The dashboard has always sent discord.id alongside the username; only the username was kept,
      // so the collector embed showed a plain string nobody could click or notify. Keeping the id is
      // what lets the embed render a real <@id> mention.
      buyerDiscordId = (d && d.id) ? String(d.id) : '';
      // Push it into the monitor, which may already be running: it starts on a fixed timer and
      // captured whatever this was at that moment — an empty string for anyone who was still at the
      // key gate. Without this, activating a key leaves Buy Now refusing every click until restart.
      try { discordMonitor.setOwnerDiscordId(buyerDiscordId); } catch {}
      // Hand the identity + session token to the central reporter so EVERY module's
      // checkouts are tagged with this Discord user and land on their dashboard.
      reporter.configure({
        key,
        token: licenseSession && licenseSession.token,
        discord: buyerDiscord,
        discordId: buyerDiscordId,
        log: (m) => log.info(m),
      });
    },
    onDenied: (reason, device) => {
      // Every branch ends at the gate, so each message names the fix that suits the key AND the one
      // that always works — enter a different key — because a reset needs whoever holds the key to
      // cooperate, and that is not always the person sitting here.
      let title, detail, short;
      if (reason === 'in_use') {
        short = `key in use on ${device || 'another device'}`;
        title = 'Key already in use';
        detail = `This license key is running on ${device || 'another device'}.\n\n`
          + 'Reset it from the dashboard (Devices → Reset), or enter a different key on the screen behind this dialog.';
      } else if (reason === 'hwid_mismatch') {
        // Hardware-locked to one machine. Resets are unlimited, so this is a one-click fix — for the
        // key's owner. Hence the second option.
        short = 'key is bound to a different computer';
        title = 'Key locked to another machine';
        detail = 'This key is bound to a different computer.\n\n'
          + 'Open the dashboard → Devices → Reset HWID (resets are unlimited), or enter a different key on the screen behind this dialog.';
      } else if (reason === 'disabled') {
        short = 'key disabled on the dashboard';
        title = 'Key disabled';
        detail = 'This license key was disabled on the dashboard.\n\nEnter a different key on the screen behind this dialog.';
      } else { return; }
      revokeToGate(reason, short);
      // While the user is typing keys at the gate the refusal comes back as the activation result and
      // lands in red under the input. A modal on top of that is just something else to dismiss on
      // every attempt, and they may well be working through several keys.
      if (!activating) notify(title, detail);
    },
    // SOFT KILL. Stops every running bot and leaves everything else alone: the session stays
    // claimed, the key stays stored, the gate never appears. The user presses Start when the
    // operator says so -- no re-activation, no support ticket.
    //
    // This is what "stop all bots" on the dashboard was always meant to do. It used to be wired to
    // the session-close path, which dumped the user at the key gate and wiped their stored key.
    onStopBots: () => {
      stopAllRunning();
      notify('Bots stopped',
        'The operator stopped the bots on this machine.\n\n'
        + 'Your license is unaffected — press Start again when you are told to.');
      log.warn('[license] stop-bots from dashboard — tasks halted, session kept');
    },
    onClose: () => {
      revokeToGate('instance_reset', 'this instance was reset from the dashboard');
      notify('Instance reset',
        'This instance was reset from the dashboard, so the bots here have stopped.\n\n' +
        'Enter your key again on the screen behind this dialog to take the session back.');
    },
  });
  try { await licenseSession.start(); } catch (e) { log.warn('license lock init failed:', e.message); }
}

function createWindow() {
  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 700,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    transparent: false,
    backgroundColor: '#1A1C20',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: false,
    },
    show: false,
  });


  // BUG FIX (reported live 2026-07-20): Electron shows NO native context menu on right-click by
  // default (unlike a regular browser tab) — the app has to build and pop one itself. Since nothing
  // here ever did, right-clicking ANY input/textarea did nothing at all app-wide, including paste.
  // Only shown for editable fields (params.isEditable), with each item's enabled state driven by
  // Chromium's own editFlags so e.g. "Copy" is greyed out with nothing selected.
  mainWindow.webContents.on('context-menu', (event, params) => {
    if (!params.isEditable) return;
    const { editFlags } = params;
    Menu.buildFromTemplate([
      { label: 'Cut', role: 'cut', enabled: editFlags.canCut },
      { label: 'Copy', role: 'copy', enabled: editFlags.canCopy },
      { label: 'Paste', role: 'paste', enabled: editFlags.canPaste },
      { type: 'separator' },
      { label: 'Select All', role: 'selectAll', enabled: editFlags.canSelectAll },
    ]).popup({ window: mainWindow });
  });

  const startUrl = process.env.ELECTRON_START_URL || url.format({
    pathname: path.join(__dirname, '../build/index.html'),
    protocol: 'file:',
    slashes: true,
  });

  // A service worker or HTTP cache registered against localhost:3000 by an earlier build can
  // persist across restarts and silently serve stale bundles forever, no matter what the current
  // dev server returns. Nuke the whole session before every dev load so what's on screen always
  // matches what's on disk.
  const loadStart = () => mainWindow.loadURL(startUrl);
  if (process.env.ELECTRON_START_URL) {
    mainWindow.webContents.session.clearStorageData()
      .then(() => mainWindow.webContents.session.clearCache())
      .then(loadStart)
      .catch((err) => { log.error('Failed to clear dev session, loading anyway:', err); loadStart(); });
  } else {
    loadStart();
  }

  mainWindow.webContents.on('did-fail-load', (e, code, desc, validatedUrl) => {
    log.error('Page failed to load:', code, desc, validatedUrl);
  });

  // A renderer crash used to leave a black window with NOTHING in the main log to explain it — the
  // UI was simply gone and the only symptom was "it froze". Record why, then reload so the window
  // recovers on its own instead of sitting black.
  mainWindow.webContents.on('render-process-gone', (e, details) => {
    log.error('Renderer gone:', details && details.reason, 'exitCode:', details && details.exitCode);
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (details && details.reason === 'clean-exit') return;
    setTimeout(() => {
      try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload(); } catch {}
    }, 500);
  });
  mainWindow.webContents.on('unresponsive', () => log.error('Renderer unresponsive'));

  // The renderer has died with reason 'oom'. Nothing recorded HOW memory got there, so sample every
  // process periodically: the growth curve identifies which one leaks and how fast. Logged only when
  // a process is above 400 MB so a healthy session stays quiet.
  const memTimer = setInterval(() => {
    try {
      const heavy = app.getAppMetrics()
        .map((m) => ({ type: m.type, pid: m.pid, mb: Math.round((m.memory && m.memory.workingSetSize ? m.memory.workingSetSize : 0) / 1024) }))
        .filter((m) => m.mb > 400)
        .sort((a, b) => b.mb - a.mb);
      if (!heavy.length) return;
      log.warn('memory:', heavy.map((m) => `${m.type}#${m.pid}=${m.mb}MB`).join(' '));
      // Ask the renderer what's actually big. Growth was ~140 MB/s, so working-set alone can't say
      // whether it's the store, the DOM, or plain JS garbage — this names it before the OOM kill.
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents
          .executeJavaScript('window.__hopeDebug && window.__hopeDebug.sizes()', true)
          .then((sizes) => { if (sizes) log.warn('renderer state:', JSON.stringify(sizes)); })
          .catch(() => {});
      }
    } catch {}
  }, 5000);
  mainWindow.once('closed', () => clearInterval(memTimer));
  mainWindow.webContents.on('responsive', () => log.warn('Renderer responsive again'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    // Delay 1.5s so React has time to mount and attach IPC listeners
    setTimeout(() => startDiscordListener(dm.getSettings()), 1500);
    // A zyn:// click on a CLOSED app starts the exe with the URL in argv, so the link is already
    // waiting before any window exists. Replay it once the renderer can receive it — same 1.5s reason
    // as above: sending earlier means nobody is listening and the click is lost.
    setTimeout(() => {
      const link = pendingDeepLink || deepLinkFromArgv(process.argv);
      pendingDeepLink = '';
      if (link) handleDeepLink(link);
    }, 1600);
    // Harvester mode: bring the cookie broker up with the app, not with a task. Pre-farming a bank
    // ahead of a drop means the browser extension needs somewhere to POST long before any checkout
    // task exists.
    try { targetEngine.ensureHarvesterBroker(); } catch (err) { log.warn('harvester broker:', err.message); }
    // Verify at startup, then re-check on a timer so a revoke takes effect without a restart —
    // and kill any running monitors the moment the key stops being valid.
    const recheck = async () => {
      const s = await lic.verifyLicense(dm.getSettings().licenseKey || '', { force: true });
      // A denial can land while this request is in flight — it read the key before the denial
      // cleared it, so it comes back ok for a key we are no longer allowed to run. Let the denial
      // stand and put the verdict back, since verifyLicense has just overwritten the cache with it.
      if (revokedStatus) { lic.invalidate(revokedStatus.reason); return; }
      try { mainWindow?.webContents?.send('licenseStatus', s); } catch {}
      if (!s.ok) { try { th.stopAllPbandai(); } catch {} try { th.stopAllRound1(); } catch {} try { th.stopAllPokemonCenter(); } catch {} try { targetEngine.stopPokemonCenter(); } catch {} }
    };
    recheck();
    initLicenseLock();
    licenseTimer = setInterval(recheck, 30 * 60 * 1000);
    initAutoUpdate();
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  if (process.env.ELECTRON_START_URL) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

// ── Teardown ──────────────────────────────────────────────────────────────────────
// ONE list, used by every exit path. before-quit used to stop 2 of 6 subsystems — P-Bandai and
// Pokémon Center — while the complete list already existed in installUpdate above. Everything else
// (Secret Lair tasks, Generate-tab scripts, both Go engines, the Shape farmer and their Chromium
// trees) simply survived the app. That is what leaves a node holding :4727 and makes the NEXT
// launch fail with EADDRINUSE.
//
// Deliberately synchronous. Doing this asynchronously via event.preventDefault() keeps the event
// loop alive long enough for target-engine's port-probe timer to fire and spawn a fresh farmer
// mid-teardown — manufacturing the exact orphan we are trying to prevent. Hiding the window makes
// the pause invisible instead.
let tornDown = false;
// Stop every running bot and engine. Recoverable on purpose — no hidden window, no cleared timers,
// no tornDown latch — so the license-denial path can reuse it and still hand the app back to the
// user instead of ending the process.
function stopAllRunning() {
  for (const stop of [
    () => th.stopAllTasks(),
    () => th.stopAllBotScripts(),
    () => th.stopAllPbandai(),
    () => th.stopAllRound1(),
    () => th.stopAllPokemonCenter(),
    () => targetEngine.shutdown(),
  ]) { try { stop(); } catch (e) { log.warn('teardown:', e && e.message); } }
}

function teardownAll() {
  if (tornDown) return;               // reachable from before-quit, will-quit AND the license paths
  tornDown = true;
  try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide(); } catch {}
  try { clearInterval(updateTimer); } catch {}
  try { clearInterval(licenseTimer); } catch {}
  stopAllRunning();
}

// A throw in createWindow would otherwise leave a windowless main process alive holding every port,
// with window-all-closed unable to fire because no window ever opened.
app.whenReady().then(createWindow).catch((e) => {
  log.error('createWindow failed:', (e && e.message) || e);
  app.quit();
});
app.on('before-quit', teardownAll);
app.on('will-quit', teardownAll);   // belt and braces: some quit paths skip before-quit
app.on('window-all-closed', () => {
  // Only tear down when this actually ends the app. On macOS the app stays resident, and tearing
  // down here would stop every subsystem and latch tornDown while 'activate' reopens the window.
  if (process.platform === 'darwin') return;
  teardownAll();
  app.quit();
});
app.on('activate', () => { if (!mainWindow) createWindow(); });

// ── Window controls ───────────────────────────────────────────────────────────────
ipcMain.on('close', () => app.quit());
ipcMain.on('minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize());
ipcMain.on('maximize', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win) win.isMaximized() ? win.unmaximize() : win.maximize();
});

// ── Tasks ─────────────────────────────────────────────────────────────────────────
ipcMain.on('getTasks', (e) => { e.returnValue = dm.getTasks(); });
ipcMain.on('createTask', (e, data) => { e.returnValue = dm.createTask(data); });
ipcMain.on('updateTask', (e, { id, data }) => { dm.updateTask(id, data); e.returnValue = true; });
ipcMain.on('deleteTask', (e, id) => { th.stopTask(id); dm.deleteTask(id); e.returnValue = true; });

ipcMain.on('startTask', async (e, { id, cartUrl, proxy }) => {
  // Refuse before anything spawns — that is the whole point of a module switch as opposed to a stop.
  if (moduleBlocked('secretlair')) { refuseModule('Secret Lair'); e.returnValue = false; return; }
  if (!licensed()) { refuseUnlicensed('startTask'); return; }
  const tasks = dm.getTasks();
  const task = tasks.find(t => t.id === id);
  if (!task) return;
  const profiles = dm.getProfiles();
  const settings = dm.getSettings();
  const proxyLines = task.proxyList ? dm.getProxyLines(task.proxyList) : [];
  mainWindow.webContents.send('taskStarted', { taskId: id });
  try {
    await th.startTask(id, task, cartUrl, profiles, proxyLines, settings, mainWindow, proxy);
  } catch (err) {
    log.error('startTask error:', err);
    mainWindow.webContents.send('taskLog', { taskId: id, threadId: 0, line: `FATAL: ${err.message}` });
    mainWindow.webContents.send('taskDone', { taskId: id });
  }
});

ipcMain.on('stopTask', (e, id) => {
  th.stopTask(id);
  mainWindow.webContents.send('taskStopped', { taskId: id });
  e.returnValue = true;
});

// ── P-Bandai engine ─────────────────────────────────────────────────────────────

// Record an order for a profile (persisted + pushed to the renderer for the "Last placed order" line).
function recordOrder(profileId) {
  if (!profileId) return;
  const ts = Date.now();
  try { dm.setLastOrder(profileId, ts); } catch {}
  try { mainWindow?.webContents?.send('pbandaiLastOrder', { profileId: String(profileId), ts }); } catch {}
}
function recordCarted(profileId) {
  if (!profileId) return;
  try { dm.setLastCarted(profileId, Date.now()); } catch {}
}
ipcMain.on('getLastOrders', (e) => { try { e.returnValue = dm.getLastOrders(); } catch { e.returnValue = {}; } });

// Resolve everything the engine needs for one profile: proxy pool, saved-account login, webhook.
// Shared by the normal launch and Rotate Mode so they can't drift. Login is decrypted here, in main,
// only at spawn time — never persisted in plaintext, never sent to the renderer.
// proxyListName picks a list from the Proxies page; otherwise the task uses the home IP. The former
// encrypted in-house pools are deliberately not part of the tracked runtime.
function resolveLaunch(profileId, useVpn, pool, proxyListName) {
  const profiles = dm.getProfiles();
  const profile = profileId ? profiles.find(p => p.id === profileId) : profiles[0];
  if (!profile) return null;
  let proxyPool = [];
  let proxyLabel = '';   // shown in the logs instead of the raw IPs — the chosen list's name
  if (proxyListName) { try { proxyPool = dm.getProxyLines(proxyListName); } catch {} proxyLabel = proxyListName; }
  let login = null;
  // 'bandai' explicitly: resolveLaunch only ever serves the P-Bandai engine, and without the site
  // a profile whose email also has a Target account could be launched with the Target password.
  try { const acct = dm.accountForProfile(profile.id, 'bandai'); if (acct) login = dm.getAccountCreds(acct.id); } catch {}
  return { id: String(profile.id), profile, proxyPool, login, proxyLabel,
    inHouse: false, webhook: dm.getSettings().discordWebhook || '' };
}

// ── BUY NOW (green button on the monitor embed) ──────────────────────────────────
//
// Settings -> Auto Buy Profiles decides WHO runs. Everything else comes off the embed: the SKU from
// the PID field and the quantity from Cart Limit, so a click buys exactly what the restock allows.
//
// The cap is not decoration. There are 2141 profiles on this machine; a group with 500 in it would
// otherwise open 500 browsers from one click and take the machine down before it bought anything.
function autoBuyConn(c) {
  const v = String(c || 'none');
  if (v.startsWith('list:')) return { useVpn: false, pool: '1', proxyListName: v.slice(5) };
  return { useVpn: false, pool: '1', proxyListName: '' };
}

function autoBuyProfiles() {
  const s = dm.getSettings() || {};
  const cfg = s.autoBuy || {};
  const group = String(cfg.group || '').trim();
  let list = [];
  try { list = dm.getProfiles() || []; } catch { return { chosen: [], group, cap: 0, total: 0 }; }
  const matching = group ? list.filter(p => (p.groups || []).includes(group)) : list;
  const cap = Math.max(1, Math.min(50, parseInt(cfg.max, 10) || 5));
  return { chosen: matching.slice(0, cap), group, cap, total: matching.length };
}

// The whole group. autoBuyProfiles() returns the capped slice for the "how many start now" count;
// rotation needs every candidate, because the ones past the cap are exactly the ones that rotate in.
function autoBuyGroupProfiles() {
  const s = dm.getSettings() || {};
  const group = String((s.autoBuy || {}).group || '').trim();
  let list = [];
  try { list = dm.getProfiles() || []; } catch { return []; }
  return group ? list.filter(p => (p.groups || []).includes(group)) : list;
}

async function handleBuyNow({ site, sku, qty }) {
  if (site !== 'pbandai') return `Auto buy is only wired for P-Bandai (got "${site}")`;
  if (moduleBlocked('pbandai')) { refuseModule('P-Bandai'); return 'P-Bandai is disabled right now'; }
  if (!licensed()) return 'This copy is not licensed';

  const { chosen, group, cap, total } = autoBuyProfiles();
  if (!chosen.length) {
    const why = group ? `no profiles in group "${group}"` : 'no profiles';
    log.info(`[buy-now] ${sku}: ${why} — set them in Settings → Auto Buy Profiles`);
    return `Nothing to run — ${why}. Set them in Settings → Auto Buy Profiles.`;
  }

  const s2 = dm.getSettings() || {};
  const { useVpn, pool, proxyListName } = autoBuyConn((s2.autoBuy || {}).connection);

  // ROTATE, don't just launch the first N.
  //
  // The cap is concurrency, not a total: with 10 profiles in the group and a cap of 5, the other 5
  // have to take a slot as each order lands. Launching `chosen` directly ran five accounts and left
  // the rest untouched for the whole drop.
  //
  // This is the SAME machinery as Rotate Mode — one profile per slot, and when one places an order
  // its browser closes and the next queued profile opens in its place — so slot accounting, retries,
  // soft-block handling and the carted-first tiering all come along rather than being reimplemented.
  const all = autoBuyGroupProfiles();          // the FULL group, not the capped slice
  endRotate();                                  // a Buy Now click replaces any prior rotate session
  let cartedIds = [];
  try { cartedIds = dm.recentlyCartedIds(); } catch {}
  rotate = {
    queue: all.map(p => String(p.id)),
    active: new Set(), done: new Set(), retries: new Map(), blocked: new Map(),
    movedOn: new Set(), userStopped: new Set(), stopped: false, cartedIds,
    cap,
    base: {
      productCode: sku, qty, useVpn, pool, proxyListName,
      headless: false, drop: false, interval: 15, codes: [],
    },
  };
  rotateFill();
  const started = rotate ? rotate.active.size : 0;

  const queued = Math.max(0, total - started);
  const more = queued ? ` · ${queued} more rotate in as orders land` : '';
  log.info(`[buy-now] ${sku} x${qty} — ${started} running${more}`);
  return `Buying ${sku} ×${qty} — ${started} running${more}`;
}

ipcMain.on('startPbandai', (e, { instanceId, mode, productCode, codes, interval, qty, profileId, useVpn, inHousePool, proxyListName, area, turbo, headless, dry, drop }) => {
  // Refuse before anything spawns — that is the whole point of a module switch as opposed to a stop.
  if (moduleBlocked('pbandai')) { refuseModule('P-Bandai'); e.returnValue = false; return; }
  if (!licensed()) { refuseUnlicensed('startPbandai'); return; }
  const pool = inHousePool || '1';
  const r = resolveLaunch(profileId, useVpn, pool, proxyListName);
  const id = String(instanceId || (r && r.id) || 'default');
  // If this id is a live Rotate slot (e.g. Test Checkout or Start Monitor on a rotating account), free
  // it here: the launch below replaces the rotate child, whose stale close won't fire onExit, so the
  // slot would otherwise stay occupied forever and stall rotation.
  if (rotate && rotate.active.has(id)) { rotate.active.delete(id); rotateFill(); }
  th.startPbandai({ instanceId: id, mode, productCode, codes, interval, qty, area,
    profile: r && r.profile, proxyPool: r ? r.proxyPool : [], proxyLabel: r ? r.proxyLabel : '', webhook: r ? r.webhook : '',
    turbo, headless, drop, login: r ? r.login : null, dry, inHouse: r ? r.inHouse : false, inHousePool: pool,
    buyerDiscord, dashboardKey: (dm.getSettings().licenseKey || '') }, mainWindow,
    { onStatus: (state) => { if (state === 'success') recordOrder(id); },
      onCarted: () => recordCarted(id) });
});

// ── Rotate Mode ──────────────────────────────────────────────────────────────────
// Runs up to ROTATE_CAP profiles concurrently. When one PLACES AN ORDER, its browser closes and the
// next not-yet-run profile opens in its place (true close-then-open, never exceeding the cap), until
// every selected profile has had a turn or the user stops. Lives in main so a tab switch can't break
// it and the child processes are managed where they're spawned.
const ROTATE_CAP = 5;
let rotate = null; // { queue:[profileId], active:Set, done:Set, retries:Map, base:{...}, stopped }

// Rotate-session messages into the Live Log, so the user can see WHY a slot changed.
const rlog = (line) => { try { mainWindow?.webContents?.send('pbandaiLog', { tag: 'rotate', line }); } catch {} };

function endRotate() { if (rotate) rotate.stopped = true; rotate = null; }

function rotateFill() {
  const s = rotate;
  if (!s || s.stopped) return;
  // Per-session cap. Rotate Mode uses ROTATE_CAP; a Buy Now session uses the operator's
  // Auto Buy "max at once", so the same machinery serves both without a second implementation.
  const cap = s.cap || ROTATE_CAP;
  while (s.active.size < cap && s.queue.length) {
    // TIERED pick. Accounts that already had the item in their cart (within 24h) go first — after a
    // mid-drop restart they're the closest to a completed order. Within each tier the choice is still
    // RANDOM, so prioritising them doesn't reintroduce a predictable fixed account order.
    const carted = new Set(s.cartedIds || []);
    const tier = s.queue.filter(id => carted.has(String(id)));
    const pool = tier.length ? tier : s.queue;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    s.queue.splice(s.queue.indexOf(pick), 1);
    if (s.active.has(pick) || s.done.has(pick)) continue;
    if (tier.length) rlog(`↑ ${String(pick).slice(0, 8)} carted earlier — running it first.`);
    s.active.add(pick);
    rotateLaunch(pick);
  }
  // `rotate === s` guards against a re-entrant call (rotateLaunch → rotateFill for a vanished profile)
  // firing completion twice.
  if (rotate === s && !s.active.size && !s.queue.length) {   // every profile has had its turn
    try { mainWindow?.webContents?.send('pbandaiRotateDone'); } catch {}
    rotate = null;
  }
}

function rotateLaunch(pid) {
  const s = rotate; if (!s) return;
  const r = resolveLaunch(pid, s.base.useVpn, s.base.pool, s.base.proxyListName);
  if (!r) { s.active.delete(pid); rotateFill(); return; }   // profile vanished — skip, keep the cap full
  // A Buy Now session already knows the SKU, so its slots run 'single' (straight at the product,
  // guest pre-cart then login) rather than starting yet another monitor behind a restock we have
  // already been told about.
  const job = s.base.productCode
    ? { mode: 'single', productCode: s.base.productCode }
    : { mode: 'monitor', codes: s.base.codes, interval: s.base.interval };
  th.startPbandai({ instanceId: r.id, ...job,
    qty: s.base.qty, area: 'us', profile: r.profile, proxyPool: r.proxyPool, proxyLabel: r.proxyLabel, webhook: r.webhook,
    turbo: false, headless: s.base.headless, drop: s.base.drop, login: r.login, dry: false, inHouse: r.inHouse, inHousePool: s.base.pool,
    buyerDiscord, dashboardKey: (dm.getSettings().licenseKey || ''), rotate: true }, mainWindow, {
    onStatus: (state) => {
      // 'login_blocked' = auto-login soft-blocked on every IP (headless can't pop a window in a fleet).
      // Don't relaunch THIS account headless in a loop — hand the slot to a DIFFERENT account. Re-queue it
      // at the tail (soft-blocks are usually temporary) up to 3× before dropping it for the session.
      if (state === 'login_blocked') {
        const cur = rotate; if (!cur || cur.stopped) return;
        const n = (cur.blocked.get(pid) || 0) + 1;
        cur.blocked.set(pid, n);
        cur.movedOn.add(pid);   // onExit: open a different (random) account, don't relaunch this one
        if (n <= 3) { cur.queue.push(pid); rlog(`🚧 ${pid.slice(0, 8)} can't log in on any IP — moving on; will retry it later (${n}/3).`); }
        else rlog(`⚠ ${pid.slice(0, 8)} still blocked after ${n} tries — dropping it for this session.`);
        try { th.stopPbandai(pid); } catch {}
        return;
      }
      // 'maxqty' = this ACCOUNT hit the per-customer cap. It can never buy this SKU, so its turn is
      // over — free the slot for the next profile. NOT recorded as an order: nothing was bought.
      if (state === 'maxqty') {
        const cur = rotate; if (!cur || cur.stopped) return;
        rlog(`⛔ ${pid.slice(0, 8)} hit Max Quantity — moving to the next account.`);
        cur.done.add(pid);
        try { th.stopPbandai(pid); } catch {}
        return;
      }
      if (state !== 'success') return;
      recordOrder(pid);
      const cur = rotate; if (!cur) return;
      cur.done.add(pid);
      try { th.stopPbandai(pid); } catch {}   // close this browser; onExit opens the next
    },
    onCarted: () => recordCarted(pid),
    onExit: () => {
      const cur = rotate; if (!cur || cur.stopped) return;   // Stop All ended the session — don't refill
      cur.active.delete(pid);
      // Login soft-blocked on every IP (login_blocked). Don't relaunch THIS account — open a different
      // one. onStatus already re-queued it (or dropped it after 3 tries) and logged why.
      if (cur.movedOn.has(pid)) { cur.movedOn.delete(pid); rotateFill(); return; }
      // Rotation advances ONLY on a placed order. If this account ordered, free its slot for the next
      // queued profile. If it exited WITHOUT ordering (the browser died — the engine exits 0 when its
      // context closes), it never got its turn: relaunch the SAME profile (which also re-rolls its
      // proxy) instead of burning a fresh one off the queue. Capped so a profile that keeps dying
      // can't loop forever.
      if (cur.done.has(pid)) { rotateFill(); return; }
      // YOU pressed Stop on this account. That is not a crash, so don't relaunch the same profile —
      // its turn is over. Free the slot and let rotateFill() open a different (random) account.
      if (cur.userStopped.has(pid)) {
        cur.userStopped.delete(pid);
        cur.retries.delete(pid);
        rlog(`⏹ ${pid.slice(0, 8)} stopped by you — its turn is over, opening a different account.`);
        rotateFill();
        return;
      }
      const tries = (cur.retries.get(pid) || 0) + 1;
      cur.retries.set(pid, tries);
      if (tries > 3) {
        rlog(`⚠ ${pid.slice(0, 8)} died ${tries}× without ordering — skipping it and moving to the next account.`);
        rotateFill();
        return;
      }
      rlog(`↻ browser closed without an order — relaunching the same account on a fresh proxy (try ${tries}/3). Rotation only advances on a real order.`);
      setTimeout(() => {
        if (rotate !== cur || cur.stopped || cur.active.has(pid) || cur.done.has(pid)) return;
        cur.active.add(pid);
        rotateLaunch(pid);
      }, 3000);   // breathe, so a crash-on-launch can't tight-loop
    },
  });
}

// ── Coupon Mode ──────────────────────────────────────────────────────────────
// Log into each account, read /mypage/coupon, and tag accounts that hold the free-shipping coupon
// into a "Coupon" group. A few at a time — login is slow and IP-sensitive.
let couponRun = null;
const clog = (line) => { try { mainWindow?.webContents?.send('pbandaiLog', { tag: 'coupon', line }); } catch {} };
function couponProgress(running = true) {
  const s = couponRun;
  try { mainWindow?.webContents?.send('couponProgress', s ? { done: s.done, total: s.total, has: s.has, running } : { done: 0, total: 0, has: 0, running: false }); } catch {}
}
function couponDone() {
  if (!couponRun) return;
  clog(`✓ Coupon check done — ${couponRun.has} of ${couponRun.done} account(s) hold the free-shipping coupon → tagged "Coupon".`);
  couponProgress(false);
  couponRun = null;
}
// Hard stop: no more spawns (stopped + empty queue) AND kill the in-flight checks.
function endCoupon() {
  if (!couponRun) return;
  couponRun.stopped = true;
  couponRun.queue = [];
  for (const iid of [...couponRun.activeIds]) { try { th.stopPbandai(iid); } catch {} }
}
function couponFill() {
  const s = couponRun; if (!s || s.stopped) return;
  while (s.active < s.cap && s.queue.length) {
    const pid = String(s.queue.shift());
    const r = resolveLaunch(pid, s.base.useVpn, s.base.pool, s.base.proxyListName);
    if (!r || !(r.login && r.login.email && r.login.password)) { s.done++; couponProgress(); continue; }  // no login → skip
    s.active++;
    const iid = `coupon-${r.id}`;
    s.activeIds.add(iid);
    let settled = false;
    th.startPbandai({ instanceId: iid, mode: 'coupon', profile: r.profile, proxyPool: r.proxyPool, proxyLabel: r.proxyLabel,
      login: r.login, headless: false, inHouse: r.inHouse, inHousePool: s.base.pool, webhook: '' }, mainWindow, {
      onStatus: (state, detail) => {
        if (state !== 'coupon' || settled) return;
        settled = true;
        // Record a definitive result so a stop/restart skips this account. 'error' (soft-block) is not
        // recorded, so it retries next run.
        if (detail === 'has' || detail === 'none') { try { dm.setCouponChecked(pid, detail); } catch {} }
        if (detail === 'has') { try { dm.addProfilesToGroup([pid], 'Coupon'); } catch {} s.has++; }
      },
      onExit: () => {
        s.activeIds.delete(iid);
        s.active--; s.done++; couponProgress();
        if (s.stopped) { if (s.active === 0) couponDone(); return; }
        couponFill();
        if (s.done >= s.total && s.active === 0) couponDone();
      },
    });
  }
  if (!s.queue.length && s.active === 0) couponDone();
}
ipcMain.on('startCouponCheck', (e, { profileIds, useVpn, inHousePool, proxyListName, headless } = {}) => {
  if (!licensed()) { refuseUnlicensed('startCouponCheck'); e.returnValue = false; return; }
  if (couponRun) { e.returnValue = false; return; }   // one run at a time
  const selected = (Array.isArray(profileIds) && profileIds.length ? profileIds.map(String) : dm.getProfiles().map(p => String(p.id)));
  const checked = dm.getCouponChecked();
  const ids = selected.filter(id => !checked[id]);   // skip accounts already checked; soft-blocked ones retry
  const skipped = selected.length - ids.length;
  if (!ids.length) {
    clog(`🎟 Coupon check — all ${selected.length} selected account(s) already checked; nothing new to scan.`);
    couponProgress(false);
    e.returnValue = true; return;
  }
  couponRun = { stopped: false, queue: [...ids], active: 0, done: 0, has: 0, total: ids.length, cap: 5, activeIds: new Set(),
    base: { useVpn: !!useVpn, pool: inHousePool || '1', proxyListName: proxyListName || '', headless: false } };
  clog(`🎟 Coupon check — ${ids.length} account(s)${skipped ? ` (skipping ${skipped} already checked)` : ''}, a few at a time…`);
  couponProgress();
  couponFill();
  e.returnValue = true;
});
ipcMain.on('stopCouponCheck', () => { if (couponRun) { clog('⏹ Coupon check stopped.'); endCoupon(); } });
ipcMain.on('getGroups', (e) => { e.returnValue = dm.getGroups(); });
// only:'none' forgets the confirmed no-coupon accounts so the next run re-checks them; omitted wipes all.
ipcMain.on('clearCouponChecks', (e, { only } = {}) => {
  let n = 0;
  try { n = dm.clearCouponChecked(only) || 0; } catch {}
  clog(only === 'none'
    ? `↺ Forgot ${n} “no coupon” result(s) — the next Coupon run will re-check them.`
    : `↺ Cleared all ${n} coupon check result(s) — the next run starts from scratch.`);
  e.returnValue = n;
});
ipcMain.on('getCouponStats', (e) => { try { e.returnValue = dm.couponCheckedStats(); } catch { e.returnValue = { has: 0, none: 0 }; } });
// Group membership writes for the Profiles → Groups tab (batch, so tagging hundreds is one round-trip).
ipcMain.on('addProfilesToGroup', (e, { ids, group } = {}) => { try { dm.addProfilesToGroup(ids || [], group); } catch {} e.returnValue = true; });
ipcMain.on('removeProfilesFromGroup', (e, { ids, group } = {}) => { try { dm.removeProfilesFromGroup(ids || [], group); } catch {} e.returnValue = true; });
ipcMain.on('setProfileGroups', (e, { id, groups } = {}) => { try { dm.setProfileGroups(id, groups || []); } catch {} e.returnValue = true; });

ipcMain.on('startPbandaiRotate', (e, { profileIds, codes, interval, qty, useVpn, inHousePool, proxyListName, headless, drop }) => {
  if (!licensed()) { refuseUnlicensed('startPbandaiRotate'); e.returnValue = false; return; }
  const ids = (Array.isArray(profileIds) ? profileIds : []).map(String).filter(Boolean);
  if (!ids.length || !Array.isArray(codes) || !codes.length) { e.returnValue = false; return; }
  endRotate();   // replace any prior session
  // Snapshot ONCE at session start, not per fill: accounts cart as the session runs, and re-reading
  // would keep re-prioritising whoever just carted instead of honouring the pre-restart state.
  let cartedIds = [];
  try { cartedIds = dm.recentlyCartedIds(); } catch {}
  if (cartedIds.length) rlog(`↑ ${cartedIds.filter(id => ids.includes(String(id))).length} account(s) carted in the last 24h — they go first.`);
  rotate = { queue: [...ids], active: new Set(), done: new Set(), retries: new Map(), blocked: new Map(), movedOn: new Set(), userStopped: new Set(), stopped: false, cartedIds,
    base: { codes, interval: interval || 15, qty: qty || 1, useVpn: !!useVpn, pool: inHousePool || '1', proxyListName: proxyListName || '', headless: !!headless, drop: !!drop } };
  rotateFill();
  e.returnValue = true;
});

// Single source of truth for the version shown in the UI: the packaged app's own version.
ipcMain.on('getAppVersion', (e) => { e.returnValue = app.getVersion(); });
// 'dev' = running unpacked from source (npm run dev/start) — everything visible, including
// in-progress modules. 'beta' = a packaged build (what gets pushed to beta testers) — new/unfinished
// modules stay hidden until they're actually ready to ship. No config toggle needed: packaging IS
// the beta build, running from source IS the dev build.
ipcMain.on('getChannel', (e) => { e.returnValue = app.isPackaged ? 'beta' : 'dev'; });

// Manual "Check for updates" (Settings). Always answers with SOMETHING — a silent button that
// does nothing is exactly why people think updating is broken.
ipcMain.on('checkForUpdates', () => {
  const push = (d) => { try { mainWindow?.webContents?.send('updateStatus', d); } catch {} };
  if (!_autoUpdater) {
    push({ state: 'error', message: app.isPackaged
      ? 'Updater unavailable in this build.'
      : 'Dev build — updates only work in the installed app.' });
    return;
  }
  push({ state: 'checking' });
  _autoUpdater.checkForUpdates().catch((e) => {
    log.warn('checkForUpdates error:', e && e.message);
    push({ state: 'error', message: redactUrls(String((e && e.message) || e)).slice(0, 140) });
  });
});

ipcMain.on('forcePbandai', (e, instanceId) => { th.forcePbandai(instanceId); e.returnValue = true; });
ipcMain.on('rotatePbandaiProxy', (e, instanceId) => { th.rotatePbandaiProxy(instanceId); e.returnValue = true; });
// Copy the account's email:password to the clipboard. The plaintext is decrypted HERE, in main, and
// written to the clipboard from main — it never enters the renderer (which only gets {ok, email}).
ipcMain.on('copyAccountCreds', (e, instanceId) => {
  try {
    const profile = dm.getProfiles().find(p => String(p.id) === String(instanceId));
    const acct = profile ? dm.accountForProfile(profile.id) : null;
    if (!acct) { e.returnValue = { ok: false, msg: 'No linked account for this profile (add it on the Accounts page).' }; return; }
    const creds = dm.getAccountCreds(acct.id);
    if (!creds || !creds.email) { e.returnValue = { ok: false, msg: 'No stored password for this account.' }; return; }
    clipboard.writeText(`${creds.email}:${creds.password}`);
    e.returnValue = { ok: true, email: creds.email };
  } catch (err) { e.returnValue = { ok: false, msg: String((err && err.message) || err).slice(0, 80) }; }
});
ipcMain.on('resumePbandai', (e, instanceId) => { try { th.resumePbandai(instanceId); } catch {} e.returnValue = true; });
ipcMain.on('resetPbandaiSession', (e, instanceId) => { th.resetPbandaiSession(instanceId, mainWindow); e.returnValue = true; });
ipcMain.on('stopPbandai', (e, instanceId) => {
  // Flag it BEFORE killing the child: rotate's onExit can't otherwise distinguish a deliberate Stop
  // from a dead browser, and would relaunch this very same profile instead of rotating onward.
  const id = String(instanceId || 'default');
  if (rotate && !rotate.stopped && rotate.active.has(id)) rotate.userStopped.add(id);
  th.stopPbandai(instanceId);
  e.returnValue = true;
});
ipcMain.on('stopAllPbandai', (e) => { endRotate(); endCoupon(); th.stopAllPbandai(); e.returnValue = true; });

// ── Round1 / ShortStack registration ───────────────────────────────────────────
// N profiles race the same form, one browser each, each on its own proxy line. Unlike a checkout
// task there is nothing to buy — it is a free signup against a fixed cap — so the only thing that
// matters is getting distinct identities onto distinct IPs before the cap fills.
// Round1 auto-rotation. round1-register.mjs exits with 75 when Cloudflare hands it the interactive
// Turnstile checkbox — a per-session risk decision it cannot answer, and will not try to. Rather than
// burn the profile, respawn it on a different exit IP: measured 2026-07-29, the same address drew the
// checkbox once and then passed 8 times in a row, so a re-roll is usually all it takes.
const R1_ROTATE_EXIT = 75;
const R1_MAX_TRIES = 3;   // a site-wide clampdown must not spin every task forever
let r1RunToken = 0;

ipcMain.on('startRound1', (e, { profileIds, url, useVpn, inHousePool, proxyListName, offscreen, giveUpHours, stagger, maxConcurrent, requestMode, solverProvider, solverKey, dryRun } = {}) => {
  // Refuse before anything spawns — that is the whole point of a module switch as opposed to a stop.
  if (moduleBlocked('round1')) { refuseModule('Round1'); e.returnValue = false; return; }
  if (!licensed()) { refuseUnlicensed('startRound1'); e.returnValue = false; return; }
  const ids = Array.isArray(profileIds) && profileIds.length ? profileIds.map(String) : [];
  if (!ids.length) { e.returnValue = false; return; }
  if (!url) { e.returnValue = false; return; }

  // Round1 signups live in their own list — a checkout profile has no pickup store, and this
  // campaign has no use for its card or address.
  const signups = dm.getRound1Profiles();
  // Same vocabulary the engine parses: "test" runs the real campaign for the Cloudflare verdict but
  // submits against a local mock, and "mock" never leaves the machine. Neither creates a Round1 entry.
  const isTestRun = /^(test|mock(:\w+)?)$/i.test(String(url).trim());
  // One decrypted pool for the whole batch rather than per profile: resolveLaunch would decrypt it
  // once per task, and each signup only needs a single line out of it.
  let pool = [];
  try {
    if (proxyListName) pool = dm.getProxyLines(proxyListName);
  } catch {}
  // Measured 2026-07-29 on pool 12, and the second measurement overturned the first reading:
  //
  //     7 tasks, no stagger    Cloudflare cleared in 3.7-4.7s
  //    20 tasks, no stagger    31.2-31.5s
  //    20 tasks, 400ms apart   31.2-31.5s   <- identical, stagger bought nothing
  //
  // The starts were spread over 9s and every task still measured ~31.3s FROM ITS OWN START, so this is
  // not a queue draining at one moment — it is a fixed cost each session pays once enough of them are
  // open at the same time. The page itself always arrived in ~1.1s; it is Turnstile's own subresource
  // fetches to *.challenges.cloudflare.com that stall, and probing earlier caught those exact requests
  // failing through a proxy (ERR_TUNNEL_CONNECTION_FAILED on brunhild.challenges.cloudflare.com). Each
  // task opens several tunnels, not one, so 20 tasks is well over a hundred concurrent tunnels on one
  // provider account: they get dropped, and ~30s is the retry.
  //
  // So the lever is how many run AT ONCE, not how far apart they start. Stagger is kept because it
  // still smooths the opening burst, but maxConcurrent is the one that moves this number.
  const staggerMs = Math.max(0, Math.min(5000, parseInt(stagger, 10) || 0));
  const cap = Math.max(0, Math.min(200, parseInt(maxConcurrent, 10) || 0));
  const spreadNote = staggerMs && ids.length > 1 ? ` · starts ${staggerMs}ms apart` : '';
  const capNote = cap && ids.length > cap ? ` · ${cap} at a time` : '';
  try { mainWindow.webContents.send('round1Log', { instanceId: 'r1', tag: 'round1', line: `${ids.length} signup(s) · ${pool.length} proxy line(s)${capNote}${spreadNote}` }); } catch {}

  // Bumped on every start and every stop, so a rotation scheduled by a run the operator has since
  // cancelled cannot resurrect itself after the Stop button.
  r1RunToken += 1;
  const myToken = r1RunToken;

  // Build the jobs first, then feed them through a slot pool, rather than launching all of them.
  const jobs = [];
  ids.forEach((pid, i) => {
    const sp = signups.find((p) => String(p.id) === String(pid));
    if (!sp) return;
    const rid = String(sp.id);
    const label = sp.profileName || sp.email || rid;
    const say = (line) => { try { mainWindow.webContents.send('round1Log', { instanceId: `r1-${rid}`, tag: label, line }); } catch {} };

    // Lines already burned on this profile. Turnstile's interactive challenge is a per-session risk
    // decision, so a retry is worth making — but not on the same exit IP, which is the one variable
    // we can actually change.
    const tried = new Set();
    const pickProxy = () => {
      if (!pool.length) return '';
      // One proxy line per profile rather than the whole pool: the child takes a single --proxy, and
      // two signups sharing an exit IP is the pattern Cloudflare scores hardest. Picked at random with
      // an index offset so simultaneous launches do not all land on the same line.
      const fresh = pool.filter((p) => !tried.has(p));
      const from = fresh.length ? fresh : pool;   // exhausted is better than refusing to run
      const line = from[(Math.floor(Math.random() * from.length) + i) % from.length];
      tried.add(line);
      return line;
    };

    const launch = (attempt) => th.startRound1({
      instanceId: `r1-${rid}`,
      profile: sp,
      proxy: pickProxy(), url, offscreen: offscreen !== false, giveUpHours: giveUpHours || 16,
      requestMode, solverProvider, solverKey, dryRun,
    }, mainWindow, {
      onExit: (code) => {
        if (myToken !== r1RunToken) return;          // superseded by a Stop or a newer run
        // A rotation is the SAME job continuing on another line, so it keeps its slot. Releasing it
        // here would let a replacement start alongside the retry and quietly exceed the cap.
        if (code === R1_ROTATE_EXIT && pool.length && attempt < R1_MAX_TRIES) {
          say(`rotating to a different proxy line (attempt ${attempt + 1} of ${R1_MAX_TRIES})…`);
          // A beat, so the child's process/window teardown finishes before the next one starts.
          setTimeout(() => { if (myToken === r1RunToken) launch(attempt + 1); }, 500);
          return;
        }
        if (code === R1_ROTATE_EXIT) {
          if (!pool.length) say('interactive Turnstile, but no proxy pool to rotate into — stopping.');
          else say(`interactive Turnstile on ${attempt} lines — giving up on this profile.`);
        }
        release();   // this job is finished, however it ended — let the next one in
      },
      onStatus: (state) => {
        // A completed signup is recorded on the profile itself. The cap is global, so re-running one
        // that already registered spends a browser and an IP producing a duplicate Round1 rejects.
        //
        // But NOT for a test run. "test" submits against the local mock, so its success says the fill
        // code works and nothing about Round1 — recording it marks a profile as registered when no
        // entry exists, which is the exact failure this ledger is meant to prevent, inverted: the
        // profile then gets skipped on the day it actually matters.
        if (state === 'success' && !isTestRun) {
          try {
            const all = dm.getRound1Profiles();
            const hit = all.find((p) => String(p.id) === String(pid));
            if (hit && !hit.registeredAt) { hit.registeredAt = Date.now(); dm.saveRound1Profiles(all); }
          } catch {}
        }
      },
    });

    jobs.push({ start: () => launch(1), label });
  });

  // ── slot pool ────────────────────────────────────────────────────────────────────────────────
  // Only `cap` signups are in flight at once; the rest wait their turn and start as slots free up.
  // 0 means no cap, which is the old all-at-once behaviour.
  let active = 0;
  let next = 0;
  let lastStartAt = 0;
  const release = () => { active -= 1; pump(); };
  function pump() {
    if (myToken !== r1RunToken) return;             // Stop cancels everything still queued
    while (next < jobs.length && (!cap || active < cap)) {
      const job = jobs[next++];
      active += 1;
      // Space consecutive starts even when a slot frees early, so a burst of finishers cannot
      // reproduce the opening stampede this is meant to avoid.
      const wait = staggerMs ? Math.max(0, lastStartAt + staggerMs - Date.now()) : 0;
      lastStartAt = Date.now() + wait;
      if (wait) setTimeout(() => { if (myToken === r1RunToken) job.start(); }, wait);
      else job.start();
    }
  }
  pump();
  e.returnValue = true;
});
ipcMain.on('getRound1Profiles', (e) => { try { e.returnValue = dm.getRound1Profiles(); } catch { e.returnValue = []; } });
ipcMain.on('saveRound1Profiles', (e, list) => { try { e.returnValue = dm.saveRound1Profiles(list); } catch { e.returnValue = []; } });

// Export/import in the browser extension's own shape, so a file moves between the two without
// translation. The extension keeps { id, first, last, email, store, marketing } in
// chrome.storage.local under "profiles"; both forms are accepted on import.
ipcMain.handle('exportRound1Profiles', async () => {
  const list = dm.getRound1Profiles();
  const r = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Round1 profiles',
    defaultPath: `round1-profiles-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (r.canceled || !r.filePath) return { canceled: true };
  try {
    // A bare array is what the extension's importer expects; the wrapper object is for humans.
    fs.writeFileSync(r.filePath, JSON.stringify(list, null, 2), 'utf8');
    return { ok: true, filePath: r.filePath, count: list.length };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('importRound1Profiles', async (_e, { replace } = {}) => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Import Round1 profiles',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths || !r.filePaths[0]) return { canceled: true };
  try {
    const raw = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
    // Accept a bare array, the extension's storage dump, or our own wrapper — a user exporting from
    // chrome://extensions gets the whole storage object, and rejecting that would be needless.
    const list = Array.isArray(raw) ? raw
      : Array.isArray(raw.profiles) ? raw.profiles
      : Array.isArray(raw.round1Profiles) ? raw.round1Profiles : null;
    if (!list) return { ok: false, error: 'no profile array found in that file' };
    const res = dm.importRound1Profiles(list, !!replace);
    return { ok: true, ...res };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.on('stopRound1', (e, instanceId) => { th.stopRound1(instanceId); e.returnValue = true; });
// Bump the token BEFORE killing: a child dying with code 75 must not schedule a rotation the operator
// just cancelled.
ipcMain.on('stopAllRound1', (e) => { r1RunToken += 1; th.stopAllRound1(); e.returnValue = true; });

// ── Pokemon Center US: compiled Go guest-checkout tasks on the shared native bridge ──
ipcMain.on('startPokemonCenter', (e, config) => {
  if (moduleBlocked('pokemoncenter')) { refuseModule('Pokémon Center'); e.returnValue = false; return; }
  if (!licensed()) { refuseUnlicensed('startPokemonCenter'); e.returnValue = false; return; }
  try { e.returnValue = targetEngine.startPokemonCenter(config || {}, mainWindow) === true; }
  catch (err) { log.warn('startPokemonCenter:', err.message); e.returnValue = false; }
});
ipcMain.on('editPokemonCenter', (e, config) => {
  if (moduleBlocked('pokemoncenter')) { refuseModule('Pokémon Center'); e.returnValue = { ok: false, error: 'Pokémon Center is unavailable.' }; return; }
  if (!licensed()) { refuseUnlicensed('editPokemonCenter'); e.returnValue = { ok: false, error: 'Zyn is not licensed.' }; return; }
  try { e.returnValue = targetEngine.editPokemonCenter(config || {}); }
  catch (err) { log.warn('editPokemonCenter:', err.message); e.returnValue = { ok: false, error: err.message }; }
});
ipcMain.on('setPokemonCenterTaskProxy', (e, taskId, proxyListName) => {
  try { e.returnValue = targetEngine.setPokemonCenterTaskProxy(taskId, proxyListName); }
  catch (err) { log.warn('setPokemonCenterTaskProxy:', err.message); e.returnValue = false; }
});
ipcMain.on('stopPokemonCenter', (e, taskId) => {
  try { e.returnValue = targetEngine.stopPokemonCenter(taskId); }
  catch (err) { log.warn('stopPokemonCenter:', err.message); e.returnValue = false; }
});
ipcMain.on('getPokemonCenterTasks', (e) => { e.returnValue = dm.getPokemonCenterTasks(); });
ipcMain.on('savePokemonCenterTasks', (e, data) => { e.returnValue = dm.savePokemonCenterTasks(data || {}); });

// ── Target: compiled Go checkout engine (backend/backend.exe) over a loopback WS ──
// The engine dials our WebSocket server; target-engine.js hosts it, forwards the
// task, and relays engine status back to the renderer as targetStatus/targetLog.
ipcMain.on('startTarget', (e, config) => {
  // Refuse before anything spawns — that is the whole point of a module switch as opposed to a stop.
  if (moduleBlocked('target')) { refuseModule('Target'); e.returnValue = false; return; }
  if (!licensed()) { refuseUnlicensed('startTarget'); return; }
  targetEngine.startTarget(config || {}, mainWindow);
});
ipcMain.on('stopTarget', (e, taskId) => { targetEngine.stopTarget(taskId); e.returnValue = true; });
// Watch-list product names. getTargetSkuTitles is the cached read (instant, no network);
// resolveTargetSkuTitles fetches whatever is missing and returns the merged map.
ipcMain.on('getTargetSkuTitles', (e) => {
  try { e.returnValue = targetEngine.getSkuTitles(); } catch { e.returnValue = {}; }
});
ipcMain.handle('resolveTargetSkuTitles', async (e, tcins) => {
  try { return await targetEngine.resolveSkuTitles(tcins || []); } catch { return {}; }
});

// Live proxy switch. Synchronous so the renderer can show whether it actually reached a running task.
ipcMain.on('setTargetTaskProxy', (e, taskId, proxyListName) => {
  let ok = false;
  try { ok = targetEngine.setTaskProxy(taskId, proxyListName); } catch (err) { log.warn('setTargetTaskProxy:', err.message); }
  e.returnValue = ok;
});

// Target task list + shared SKU watch list, persisted in main so they survive a restart the same
// way Secret Lair's tasks do. Synchronous on purpose: the renderer reads these during its initial
// render, and an async round-trip there would flash an empty task list on every page mount.
ipcMain.handle('targetCookieBank', () => targetEngine.getCookieBank());

// The renderer persists the complete harvester list through saveSettings, then asks the bridge to
// reconcile producer processes immediately. Only an explicit Start/Stop click includes a run
// command; ordinary settings/proxy syncs can never grant session start authorization.
ipcMain.on('syncTargetHarvesters', (e, runCommand) => {
  if (moduleBlocked('target')) { refuseModule('Target'); e.returnValue = false; return; }
  if (!licensed()) { refuseUnlicensed('syncTargetHarvesters'); e.returnValue = false; return; }
  try { e.returnValue = targetEngine.syncTargetHarvesters(mainWindow, runCommand || null); }
  catch (err) { log.warn('syncTargetHarvesters:', err.message); e.returnValue = false; }
});

// Runtime watch-list edits are synchronous so the group editor can distinguish an applied update
// from one that was merely saved to disk and needs a task restart.
ipcMain.on('editTargetTasks', (e, config) => {
  if (moduleBlocked('target')) { refuseModule('Target'); e.returnValue = { ok: false, error: 'Target is unavailable.' }; return; }
  if (!licensed()) { refuseUnlicensed('editTargetTasks'); e.returnValue = { ok: false, error: 'Zyn is not licensed.' }; return; }
  try { e.returnValue = targetEngine.editTargetTasks(config || {}); }
  catch (err) {
    log.warn('editTargetTasks:', err.message);
    e.returnValue = { ok: false, error: err.message || 'Target watch-list update failed.' };
  }
});

// A login code typed in by hand. The engine blocks in WaitForCode regardless of where the code
// comes from, so this is the escape hatch when the mailbox is slow, unreachable, or not set up.
ipcMain.on('targetSubmitOtp', (e, { email, code } = {}) => {
  e.returnValue = targetEngine.submitOtpManually(email, code);
});

ipcMain.on('getTargetTasks', (e) => { e.returnValue = dm.getTargetTasks(); });
ipcMain.on('saveTargetTasks', (e, data) => {
  const saved = dm.saveTargetTasks(data || {});
  targetEngine.setTargetCookieStandbyTasks?.('legacy-live', Array.isArray(saved && saved.tasks) ? saved.tasks.length : 0);
  e.returnValue = saved;
});

// How many of this SKU the account has already bought inside the rolling window — the UI uses this
// to show a task as rate-limited before it is ever started, rather than failing at checkout.
ipcMain.on('targetOrderCount', (e, { accountId, tcin } = {}) => {
  e.returnValue = {
    used: dm.recentTargetOrders(accountId, tcin).length,
    max: dm.ORDER_LIMIT_MAX,
    blocked: dm.targetOrderLimitReached(accountId, tcin),
  };
});

// ── Profiles ──────────────────────────────────────────────────────────────────────
ipcMain.on('getProfiles', (e) => { e.returnValue = dm.getProfiles(); });
ipcMain.on('createProfile', (e, data) => { e.returnValue = dm.createProfile(data); });
ipcMain.on('createProfilesBulk', (e, list) => { e.returnValue = dm.createProfilesBulk(list); });
ipcMain.on('updateProfile', (e, { id, data }) => { dm.updateProfile(id, data); e.returnValue = true; });
ipcMain.on('deleteProfile', (e, id) => { dm.deleteProfile(id); e.returnValue = true; });

// ── AYCD profile import / export ──────────────────────────────────────────────────
// AYCD publishes a standard billing-profile format so a user can move profiles between the 200+
// bots their Profile Builder supports. Speaking it means profiles can come in from anywhere and
// leave again, instead of being trapped in this app's own shape.
//
// Import MERGES: an existing profile with the same name is left alone rather than duplicated or
// overwritten. Re-importing the same file is therefore a no-op, which is the behaviour someone
// expects when they are not sure whether the first attempt worked.
ipcMain.handle('importAycdProfiles', async () => {
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Import AYCD profiles',
      filters: [{ name: 'AYCD profiles (JSON)', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (canceled || !filePaths || !filePaths[0]) return { ok: false, canceled: true };

    const raw = fs.readFileSync(filePaths[0], 'utf8');
    const incoming = aycd.parseAycdFile(raw);
    const existing = dm.getProfiles();
    const seen = new Set(existing.map((p) => String(p.profileName || '').trim().toLowerCase()));

    const fresh = [];
    let skipped = 0;
    for (const a of incoming) {
      const conv = aycd.fromAycd(a, () => nodeCrypto.randomUUID());
      const key = conv.profileName.toLowerCase();
      // AYCD's own spec says names are unique per user, so the name is the honest identity here.
      if (seen.has(key)) { skipped += 1; continue; }
      seen.add(key);
      fresh.push(conv);
    }
    if (fresh.length) dm.createProfilesBulk(fresh);
    return { ok: true, added: fresh.length, skipped, total: incoming.length, filePath: filePaths[0] };
  } catch (err) { return { ok: false, error: err.message }; }
});

// Writes a BARE ARRAY, which is what Profile Builder reads. `ids` exports a selection; omitted
// exports everything.
//
// PLAINTEXT CARD DATA, deliberately and with a warning in the UI: the format exists to move real
// profiles between programs, and a redacted export would not import anywhere. Same trade-off the
// full backup already makes.
ipcMain.handle('exportAycdProfiles', async (e, ids) => {
  try {
    const all = dm.getProfiles();
    const wanted = Array.isArray(ids) && ids.length
      ? all.filter((p) => ids.map(String).includes(String(p.id)))
      : all;
    if (!wanted.length) return { ok: false, error: 'No profiles to export.' };

    const stamp = new Date().toISOString().slice(0, 10);
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Export profiles in AYCD format',
      defaultPath: `aycd-profiles-${stamp}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };

    fs.writeFileSync(filePath, JSON.stringify(wanted.map(aycd.toAycd), null, 2), 'utf8');
    // A profile in several groups loses all but the first — AYCD has one group per profile. Said
    // out loud rather than swallowed, because the loss is invisible in the file itself.
    const multiGroup = wanted.filter((p) => (p.groups || []).length > 1).length;
    return { ok: true, count: wanted.length, multiGroup, filePath };
  } catch (err) { return { ok: false, error: err.message }; }
});

// ── License ───────────────────────────────────────────────────────────────────────
// The renderer gate is cosmetic; THIS is the real enforcement — every bot spawn checks the
// cached status, so pulling the key stops runs even if someone hides the gate in devtools.
function licensed() { return !revokedStatus && lic.cached().ok; }

// ── Fleet control: modules the operator has switched off for everyone ─────────────
//
// Refusing to START is the point. A stop -- even the soft one -- only acts after the tasks are
// running and the proxy data is already spent; this is what actually saves it when someone misses
// the "don't start yet" message.
//
// Held in memory only. It is authoritative on the server and refreshed every heartbeat, so
// persisting it would just create a stale copy that outlives the restriction.
let fleetDisabled = [];
let fleetNotice = '';

function moduleBlocked(name) {
  return fleetDisabled.includes(String(name || '').trim().toLowerCase());
}

// Refuse a spawn and tell the user WHY, in the operator's own words when they left a message.
// Silent refusal reads as the app being broken, which is a support ticket either way.
function refuseModule(name) {
  const label = String(name || 'This module');
  const msg = fleetNotice
    ? `${label} is switched off by the operator right now.

${fleetNotice}`
    : `${label} is switched off by the operator right now. It will come back on without you doing anything.`;
  log.warn(`[fleet] refused ${label} — disabled by operator`);
  notify(`${label} unavailable`, msg);
  try { mainWindow?.webContents?.send('fleetControl', { disabledModules: fleetDisabled, notice: fleetNotice }); } catch {}
}

function refuseUnlicensed(what) {
  const c = lic.cached();
  log.warn(`Blocked ${what} — license: ${c.reason}`);
  try { mainWindow?.webContents?.send('licenseStatus', c); } catch {}
}

ipcMain.handle('licenseStatus', async (e, { force } = {}) => {
  // The renderer calls this on mount, which is often AFTER a startup denial has already pushed its
  // status into a window that had no listener yet. Answering from the denial rather than re-deriving
  // it is what makes the gate stick instead of flickering past.
  if (revokedStatus) return revokedStatus;
  const key = dm.getSettings().licenseKey || '';
  const s = await lic.verifyLicense(key, { force: !!force });
  return { ...s, key };
});

ipcMain.handle('activateLicense', async (e, key) => {
  const s = await lic.verifyLicense(key, { force: true });
  if (!s.ok) return s;
  revokedStatus = null;   // a fresh key clears the denial; the claim below may set it again
  dm.saveSettings({ ...dm.getSettings(), licenseKey: String(key || '').trim() });
  // Claim the dashboard session NOW. initLicenseLock() otherwise only runs at startup, where it
  // returns early because no key is stored yet — so a user activating at the gate would run this
  // whole session with no HWID binding, no single-instance lock and no heartbeat until they
  // restarted the app.
  //
  // Awaited, unlike the startup call: a key can be perfectly valid and still refused because someone
  // else is running it, and returning ok here would open the app for exactly as long as it takes the
  // denial to arrive and throw the user back out. Report the refusal as the activation result so the
  // gate simply says why and they can try the next key.
  activating = true;
  try { await initLicenseLock(); } finally { activating = false; }
  if (revokedStatus) return { ok: false, reason: revokedStatus.reason };
  return s;
});

// ── Generate tab: bulk P-Bandai account creation ─────────────────────────────────
ipcMain.handle('runBotScript', async (e, scriptName, args, runId) => th.runBotScript(scriptName, args, mainWindow, runId));
ipcMain.on('stopBotScript', (e, runId) => { e.returnValue = th.stopBotScript(runId); });

// ── Accounts ──────────────────────────────────────────────────────────────────────
// getAccounts never returns passwords — only a hasPassword flag. Plaintext stays in main.
ipcMain.on('getAccounts', (e) => { e.returnValue = dm.getAccounts(); });
ipcMain.on('addAccountsBulk', (e, arg) => {
  // Accepts either a bare raw string (old callers) or { raw, site } (Accounts page's per-tab add).
  const { raw, site } = typeof arg === 'string' ? { raw: arg, site: '' } : (arg || {});
  e.returnValue = dm.addAccountsBulk(raw, site);
});
ipcMain.on('addGeneratedAccount', (e, { email, password, site }) => { dm.addGeneratedAccount({ email, password, site }); e.returnValue = dm.getAccounts(); });
ipcMain.on('updateAccount', (e, { id, data }) => { dm.updateAccount(id, data); e.returnValue = true; });
ipcMain.on('deleteAccount', (e, id) => { dm.deleteAccount(id); e.returnValue = true; });

// ── Proxies ───────────────────────────────────────────────────────────────────────
ipcMain.on('getProxies', (e) => { e.returnValue = dm.getProxies(); });
ipcMain.on('saveProxyList', (e, { name, raw }) => { dm.saveProxyList(name, raw); e.returnValue = true; });
ipcMain.on('deleteProxyList', (e, name) => { dm.deleteProxyList(name); e.returnValue = true; });

// ── Watchlist (P-Bandai monitor SKUs — single persisted list) ───────────────────────
ipcMain.on('getWatchlist', (e) => { e.returnValue = dm.getWatchlist(); });
ipcMain.on('saveWatchlist', (e, raw) => { dm.saveWatchlist(raw); });

// ── Settings ──────────────────────────────────────────────────────────────────────

// ── Shared stock monitor ─────────────────────────────────────────────────────────────────────────
// One monitor for everybody, instead of every copy polling the retailer through the operator's proxy
// pool. On the first Target drop, ~40 users each polled the same ~40 TCINs: forty times the data for
// information the first request already had, and enough volume from one provider to earn the 403s
// that filled the log. A Discord ping costs no retailer requests.
//
// Defaults are the operator's own monitor channels; the map is editable in Settings so a user can
// point it somewhere else, and any channel not listed is ignored outright.
const DEFAULT_MONITOR_CHANNELS = {
  '1531881160739918016': 'target',
  '1531881301010022585': 'pbandai',
};

function monitorChannelMap() {
  const s = dm.getSettings() || {};
  const raw = s.monitorChannels;
  if (raw && typeof raw === 'object' && Object.keys(raw).length) return raw;
  return DEFAULT_MONITOR_CHANNELS;
}

// Shipped so every copy gets restock pings and the Buy Now button without the user configuring
// anything. This IS a real exposure and is worth being clear about: a bot token can read every
// channel the bot is in and act as it, and one in the bundle is recoverable in minutes. It is
// accepted here because the alternative achieves nothing — giving every user the monitor means
// handing every user the token either way, and a pasted one leaks just as well as a bundled one.
// Keep this bot scoped to View Channel + Read Message History on the monitor channels and nothing
// else, so what a leak buys is the ability to read two channels Zyn users can already read.
//
// A CLICK IS NOT ROUTED TO THE CLICKER. Discord fans an interaction out to every process holding
// this token, so with it shipped, every copy of Zyn sees every Buy Now click. What stops user1's
// click spending user2's money is the owner check in discord-monitor.js — that filter is the only
// thing standing between a shared token and a fleet-wide buy, so treat it as load-bearing.
//
// Settings still wins when set, so the token can be rotated (or pointed at a different bot) without
// shipping a build — which matters, because rotating a hardcoded-only secret means a full release.
const MONITOR_BOT_TOKEN = '__ZYN_MONITOR_BOT_TOKEN__';

async function startGlobalMonitor() {
  const s = dm.getSettings() || {};
  const bundled = String(MONITOR_BOT_TOKEN || '').trim();
  const token = String(s.monitorBotToken || (bundled.startsWith('__ZYN_') ? '' : bundled) || '').trim();
  return discordMonitor.start({
    token,
    channelMap: monitorChannelMap(),
    // Only a click by the person whose licence this is may spend money here — the monitor bot is
    // shared, so Discord delivers every click to every copy. See discord-monitor.js.
    ownerDiscordId: buyerDiscordId,
    onBuyNow: handleBuyNow,
    // Route each line to the module it is ABOUT. Everything used to go to the Target log, so a
    // P-Bandai restock appeared under Target and the Bandai tab said nothing at all — the monitor
    // serves both sites, and one shared log made it look like it only served one.
    //
    // Lines that name neither site (connected, gateway error, Buy Now refused) are about the monitor
    // itself, so they go to both rather than being hidden on whichever tab you are not looking at.
    logger: (m) => {
      log.info(m);
      const line = String(m);
      const bandai = /p-?bandai/i.test(line);
      const target = /target/i.test(line);
      const both = !bandai && !target;
      try {
        if (target || both) mainWindow && mainWindow.webContents.send('targetLog', { line });
        if (bandai || both) mainWindow && mainWindow.webContents.send('pbandaiLog', { tag: 'monitor', line });
      } catch {}
    },
    onStockPing: (ping) => {
      // Target's engine takes it over the WS bridge. P-Bandai's engine is a separate bundled ESM
      // process with no such bridge, so its pings are logged only until that path exists — saying so
      // rather than silently dropping them, because "the monitor is running" would otherwise read as
      // "Bandai is covered".
      if (ping.site === 'target') {
        const sent = targetEngine.sendStockPing(ping);
        if (!sent) log.info('[monitor] target engine not connected — ping not delivered');
      } else {
        log.info(`[monitor] ${ping.label} ${ping.sku} seen — no engine bridge for this site yet`);
      }
    },
  });
}

ipcMain.handle('startGlobalMonitor', async () => startGlobalMonitor());

// Start it on boot rather than waiting for a button. This is the FALLBACK stock source, so it has to
// be up before a drop, not switched on once one is already happening. No token = it logs why and
// stops, which is the correct no-op for a user who never configures one.
app.whenReady().then(() => setTimeout(() => {
  startGlobalMonitor().catch((e) => log.info('[monitor] start failed: ' + e.message));
}, 4000));
ipcMain.handle('stopGlobalMonitor', async () => { discordMonitor.stop(); return discordMonitor.status(); });
ipcMain.on('globalMonitorStatus', (e) => { e.returnValue = discordMonitor.status(); });
ipcMain.on('globalMonitorChannels', (e) => { e.returnValue = monitorChannelMap(); });

ipcMain.on('getSettings', (e) => { e.returnValue = dm.getSettings(); });
ipcMain.on('saveSettings', (e, settings) => {
  const prev = dm.getSettings();
  dm.saveSettings(settings);
  e.returnValue = true;
  if (settings.discordBotToken !== prev.discordBotToken || settings.discordChannelId !== prev.discordChannelId) {
    startDiscordListener(settings);
  }
});

// ── Export / Import (backup & migrate) ────────────────────────────────────────────
// Async (dialog-driven) so these use invoke/handle, not sendSync. The exported file is PLAINTEXT
// (holds cards, passwords, Discord token) by the user's choice — the renderer confirms before calling.
ipcMain.handle('exportSettings', async () => {
  try {
    const stamp = new Date().toISOString().slice(0, 10);
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Zyn data',
      defaultPath: `zyn-backup-${stamp}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    fs.writeFileSync(filePath, JSON.stringify(dm.exportAll(), null, 2), 'utf8');
    return { ok: true, filePath };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('importSettings', async (e, mode) => {
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Import Zyn data',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (canceled || !filePaths || !filePaths[0]) return { ok: false, canceled: true };
    let bundle;
    try { bundle = JSON.parse(fs.readFileSync(filePaths[0], 'utf8')); }
    catch { return { ok: false, error: 'That file is not valid JSON.' }; }
    const summary = dm.importAll(bundle, mode === 'replace' ? 'replace' : 'merge');
    return { ok: true, summary, filePath: filePaths[0] };
  } catch (err) { return { ok: false, error: err.message }; }
});

// Renderer calls this on mount to get the cached status (avoids missed IPC events)
ipcMain.on('getDiscordStatus', (e) => { e.returnValue = discordStatusCache; });
ipcMain.on('reconnectDiscord', () => startDiscordListener(dm.getSettings()));

// Renderer requests a pull of the newest passes from the channel (e.g. when arming a task) so it can
// fire on a link posted before/between live events instead of waiting for the next messageCreate.
ipcMain.on('refreshQueuePasses', () => {
  if (!discordClient) return;
  const channelId = dm.getSettings().discordChannelId || '1352200333648068648';
  fetchRecentQueuePasses(discordClient, channelId);
});
