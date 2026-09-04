// Target checkout engine bridge.
//
// The checkout engine is a compiled Go binary (backend/backend.exe) that acts as a
// WebSocket CLIENT: on launch it repeatedly dials ws://127.0.0.1:<port>/ until a
// server answers. So THIS process must host that server. The protocol is a JSON
// envelope { type, messages: [...] }:
//
//   frontend -> engine :  send-configs | start-tasks | stop-tasks | received-code | received-token
//   engine   -> frontend: update-status | product | task-notification | request-code | ...
//
// The renderer's Target page speaks a simpler dialect over IPC (startTarget config +
// targetLog/targetStatus/targetDone events). This module is the translation layer:
// it builds the engine's profile/account/proxy JSON from data-manager, forwards the
// task, and maps engine status messages back to the renderer.

const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');
const WebSocket = require('ws');
const dm = require('./data-manager');
const plat = require('./platform');
// Packaged bot scripts reuse Electron as native Node.
const { nodeEnvironment, nodeExecutable, userDataDir } = require('./runtime-paths');
const plainLog = require('./plain-log');
const { normalizeState } = require('./address');
const reporter = require('./checkout-reporter');
const skuTitles = require('./sku-titles');
const engineContract = require('./native-engine-contract');
const nativeHyperBroker = require('./native-hyper-broker');
const manualCaptchaManager = require('./manual-captcha-manager');
const analyticsRecorder = require('./analytics-recorder');
const {
  resolveProxyAssignment,
  displayProxyGroup,
} = require('./proxy-resolve');
const { createStatusCoalescer, STATUS_FLUSH_MS } = require('./status-coalesce');
const { engineInfoFrom } = require('./engine-version');
const {
  LOGIN_HARVESTER_ID,
  LOGIN_HARVESTER_STOP_DELAY_MS,
  buildTargetLoginHarvesterConfig,
  loginStatusNeedsHarvester,
  loginStatusClearsHarvester,
  loginHarvesterShouldRun,
} = require('./target-login-harvester');

// IMAP belongs to the profile selected for this task. request-code normally carries taskID; email
// matching remains a fallback for older engine messages that only identify the account address.
function getImapConfig(profileId, email) {
  try { return dm.getProfileImap(profileId, email); }
  catch { return { host: '', port: 993, user: '', password: '' }; }
}

// OTP login is preferred over password when an IMAP mailbox is configured — it matches Target's
// passwordless default and avoids the passkey/password menu.
// AYCD Inbox API key — the preferred OTP source. Top-level Settings, falling back to the Generate tab.
function getAycdKey() {
  try { const s = dm.getSettings() || {}; return (s.aycdApiKey || (s.generate || {}).aycdApiKey || '').trim(); } catch { return ''; }
}

// Where Target's Shape cookies come from: 'In Bot' (bundled Playwright farmer) or 'Harvester'
// (external Chrome through Zyn's filtered, authenticated compatibility bridge). Drives both how the
// farmer is launched and what the checkout webhook reports, so failures retain their source.
function shapeMethodSetting() {
  try {
    const v = ((dm.getSettings() || {}).shapeMethod || '').trim();
    return /^harvester$/i.test(v) ? 'Harvester' : 'In Bot';
  } catch { return 'In Bot'; }
}

// OTP is available when EITHER an AYCD key OR an IMAP mailbox is configured.
function otpEnabled(profileId, email) {
  if (getAycdKey()) return true;
  const c = getImapConfig(profileId, email);
  return !!(c.host && c.user && c.password);
}

// Engine emits `request-code {email}` and blocks in WaitForCode until we send `received-code`.
// Fetch the login code from AYCD and profile IMAP in parallel, then use the first verified result.
// email -> { controller }. Owning the cancellation handle here lets task/group Stop close the
// mailbox transport instead of merely hiding the OTP prompt while a four-minute poll survives in
// the background and later emits an uncaught socket timeout.
const otpFetches = new Map();

// Codes the engine is currently waiting on: lowercased email ->
// { email, taskId, since, phase, message }.
// Surfaced to the UI so a code can be typed in by hand when the mailbox is slow, unreachable, or
// simply not configured — the engine blocks in WaitForCode either way, so without this a task just
// sits there until it times out.
const otpPending = new Map();

function emitOtpPending() {
  toRenderer('targetOtp', {
    pending: [...otpPending.values()].map(p => ({
      email: p.email, taskId: p.taskId, since: p.since,
      waiting: p.waiters ? p.waiters.size : 1,
      phase: p.phase || 'starting',
      message: p.message || 'Preparing automatic email lookup…',
    })),
  });
  scheduleLoginHarvesterReconcile();
}

function updateOtpPending(key, patch) {
  const entry = otpPending.get(String(key || '').toLowerCase());
  if (!entry) return false;
  Object.assign(entry, patch || {});
  emitOtpPending();
  return true;
}

function abortOtpFetch(key, reason = 'OTP request cancelled') {
  const normalized = String(key || '').toLowerCase();
  const active = otpFetches.get(normalized);
  if (!active) return false;
  // Delete before aborting so an old fetch's finally block cannot remove a newer fetch for the same
  // address if the user restarts quickly.
  otpFetches.delete(normalized);
  try { active.controller.abort(new Error(reason)); } catch {}
  return true;
}

function cancelOtpForTask(taskId, reason = 'Target task stopped') {
  const wanted = String(taskId || '');
  if (!wanted) return false;
  let changed = false;
  for (const [key, entry] of otpPending) {
    if (!entry?.waiters?.has(wanted) && String(entry?.taskId || '') !== wanted) continue;
    if (entry.waiters) entry.waiters.delete(wanted);
    changed = true;
    if (!entry.waiters || entry.waiters.size === 0) {
      otpPending.delete(key);
      abortOtpFetch(key, reason);
    } else if (String(entry.taskId || '') === wanted) {
      entry.taskId = [...entry.waiters][0] || '';
    }
  }
  if (changed) emitOtpPending();
  return changed;
}

function cancelAllOtpFetches(reason = 'Target run stopped') {
  for (const key of [...otpFetches.keys()]) abortOtpFetch(key, reason);
  otpPending.clear();
  emitOtpPending();
}

// Hand a code to the engine and clear the prompt. Shared by the automatic (IMAP/AYCD) path and the
// manual one, so both retire the pending entry identically. Never put the code itself in a log.
function deliverOtp(addr, code, source, fetchState = null) {
  const key = String(addr).toLowerCase();
  if (fetchState && (otpFetches.get(key) !== fetchState || fetchState.controller.signal.aborted || !otpPending.has(key))) {
    vlog(`[otp] stale code for ${addr} ignored after its task stopped or restarted`);
    return false;
  }
  const entry = otpPending.get(key);
  log(`[otp] code found ${source} — submitting it`, (entry && entry.taskId) || '');
  if (entry) {
    entry.phase = 'submitting';
    entry.message = source === 'entered by hand'
      ? 'Manual code received — submitting…'
      : 'Email code found — submitting…';
    emitOtpPending();
  }
  const site = (entry && entry.site) || engineContract.SITES.TARGET;
  sendToEngine({ type: 'received-code', messages: [{ email: addr, code: String(code), site }] });
  // One code satisfies one login. Keep the prompt and waiter state for any sibling task using the
  // same account; each Target login sends its own message.
  if (entry && entry.waiters && entry.waiters.size > 1) {
    const [first] = entry.waiters;
    entry.waiters.delete(first);
    entry.taskId = [...entry.waiters][0] || entry.taskId;
    entry.since = Date.now();
    entry.phase = 'starting';
    entry.message = 'Preparing the next automatic email lookup…';
    log(`[otp] ${entry.waiters.size} more task(s) still waiting on this mailbox`, entry.taskId || '');
    // The current lookup owns the code it just returned. Start a fresh provider race for the next
    // waiter after this call's finally block retires the current fetch; otherwise sibling tasks on
    // the same account can remain visible in the UI with no mailbox lookup behind them.
    setTimeout(() => {
      const next = otpPending.get(key);
      if (next && !otpFetches.has(key)) fetchOtpAndDeliver(next.email, next.taskId);
    }, 0);
  } else {
    otpPending.delete(key);
    // Leave the successful hand-off visible long enough to be perceived. This only delays the
    // renderer clear; the code has already reached the engine and the pending map is already clean.
    setTimeout(emitOtpPending, 900);
  }
  if (otpPending.has(key)) emitOtpPending();
  return true;
}

function submitOtpManually(email, code) {
  const addr = String(email || '').trim();
  const c = String(code || '').trim();
  if (!addr || !c) return false;
  deliverOtp(addr, c, 'entered by hand');
  abortOtpFetch(addr, 'Manual OTP supplied');
  return true;
}

async function fetchOtpAndDeliver(email, taskId = '') {
  const addr = String(email || '').trim();
  if (!addr) return;
  // Both providers use the same request-time freshness anchor, with a small clock/delivery buffer.
  const receivedAfter = Date.now() - 10000;
  const key = addr.toLowerCase();
  if (otpFetches.has(key)) {
    const open = otpPending.get(key);
    if (open) {
      if (!open.waiters) open.waiters = new Set([open.taskId || 'anon-0']);
      open.waiters.add(taskId || `anon-${open.waiters.size}`);
      emitOtpPending();
    }
    log('[otp] this account already has a mailbox fetch running — this task will take the next code', taskId);
    return;
  }
  const fetchState = { controller: new AbortController() };
  otpFetches.set(key, fetchState);
  const open = otpPending.get(key);
  const waiters = (open && open.waiters) || new Set();
  waiters.add(taskId || `anon-${waiters.size}`);
  otpPending.set(key, {
    email: addr,
    taskId,
    since: Date.now(),
    waiters,
    phase: 'starting',
    message: 'Preparing automatic email lookup…',
    site: engineTaskSites.resolve({ taskID: taskId }) || engineContract.SITES.TARGET,
  });
  emitOtpPending();
  const botDir = botDirPath();
  let sourceController = null;
  let forwardAbort = null;
  try {
    const aycdKey = getAycdKey();
    const profileId = taskProfileById.get(taskId) || '';
    const c = getImapConfig(profileId, addr);
    sourceController = new AbortController();
    forwardAbort = () => {
      if (!sourceController.signal.aborted) {
        sourceController.abort(fetchState.controller.signal.reason || new Error('OTP request cancelled'));
      }
    };
    fetchState.controller.signal.addEventListener('abort', forwardAbort, { once: true });
    if (fetchState.controller.signal.aborted) forwardAbort();

    // Register shared-mailbox ownership before either provider yields. Parallel task requests can
    // then require exact To: matching instead of letting the first connection consume a sibling's
    // code through relaxed catch-all matching.
    const hasImap = Boolean(c.host && c.user && c.password);
    const mailboxKey = hasImap
      ? `${String(c.host).toLowerCase()}|${String(c.user).toLowerCase()}`
      : '';
    const currentPending = otpPending.get(key);
    if (currentPending && mailboxKey) currentPending.mailboxKey = mailboxKey;

    const sources = [];
    let pollingAycd = false;
    let pollingImap = false;
    if (aycdKey) {
      if (typeof globalThis.fetch !== 'function') {
        try { const u = require('undici'); globalThis.fetch = u.fetch; globalThis.Headers = u.Headers; globalThis.Request = u.Request; globalThis.Response = u.Response; }
        catch { try { globalThis.fetch = require('node-fetch'); } catch {} }
      }
      const script = path.join(botDir, 'aycd-mail-client.mjs');
      if (fs.existsSync(script)) {
        pollingAycd = true;
        log('[otp] checking AYCD Inbox for the Target email', taskId);
        sources.push((async () => {
          try {
            const { fetchAuthCodeViaAycd } = await import(pathToFileURL(script).href);
            const found = await fetchAuthCodeViaAycd({
              apiKey: aycdKey, targetEmail: addr, fromFilter: 'target.com',
              codePattern: /(\d{4,8})/, timeoutMs: 120000, signal: sourceController.signal,
            });
            if (!found?.code) throw new Error('AYCD returned no code');
            return { code: found.code, source: 'from AYCD Inbox' };
          } catch (error) {
            if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') throw error;
            log('[otp] AYCD failed: ' + ((error && error.message) || error)
              + (hasImap ? ' — profile IMAP is still checking' : ''), taskId);
            throw error;
          }
        })());
      } else {
        log('[otp] AYCD mailbox reader is missing from this Zyn installation', taskId);
      }
    }

    if (hasImap) {
      const script = path.join(botDir, 'imap-client.mjs');
      if (fs.existsSync(script)) {
        pollingImap = true;
        log('[otp] checking the selected profile mailbox for the Target code', taskId);
        sources.push((async () => {
          try {
            const { fetchAuthCode } = await import(pathToFileURL(script).href);
            // Let other request-code messages from the same engine frame register their mailbox
            // keys before deciding whether relaxed recipient matching is safe.
            await new Promise(resolve => setTimeout(resolve, 0));
            const mailboxWaiters = [...otpPending.values()].filter(p => p.mailboxKey === mailboxKey).length;
            const soloLogin = mailboxWaiters <= 1;
            if (!soloLogin) {
              log(`[otp] ${mailboxWaiters} logins share this mailbox — matching each code to its exact recipient`, taskId);
            }
            const result = await fetchAuthCode(
              { host: c.host, port: c.port, user: c.user, password: c.password },
              addr,
              /(\d{6})/,
              240000,
              {
                fromFilter: 'target', relaxTo: soloLogin, signal: sourceController.signal, receivedAfter,
                onLog: (line) => log(String(line), taskId),
              },
            );
            if (!result?.code) throw new Error('No new Target code was found in this mailbox');
            return { code: result.code, source: 'from profile mailbox' };
          } catch (error) {
            if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') throw error;
            log('[otp] profile mailbox failed: ' + ((error && error.message) || error), taskId);
            throw error;
          }
        })());
      } else {
        log('[otp] mailbox reader is missing from this Zyn installation', taskId);
      }
    }

    if (!sources.length) {
      updateOtpPending(key, {
        phase: 'manual',
        message: 'Automatic email lookup is unavailable — enter the code manually.',
      });
      log('[otp] no OTP source configured — add an IMAP mailbox to the matching profile, or enter the code manually', taskId);
      return;
    }

    updateOtpPending(key, {
      phase: 'polling',
      message: pollingImap && pollingAycd
        ? 'Polling AYCD Inbox and the profile IMAP mailbox for the code…'
        : pollingImap
          ? 'Polling the profile IMAP mailbox for the code…'
          : 'Polling AYCD Inbox for the code…',
    });

    // AYCD and the profile inbox start together. The first verified code wins; aborting the shared
    // source controller immediately closes the losing IMAP socket or AYCD HTTP poll.
    const found = await Promise.any(sources);
    if (deliverOtp(addr, found.code, found.source, fetchState)) {
      sourceController.abort(new Error('OTP found by another source'));
    }
  } catch (e) {
    if (fetchState.controller.signal.aborted || e?.name === 'AbortError' || e?.code === 'ABORT_ERR') {
      vlog('[otp] mailbox fetch cancelled', taskId);
    } else {
      updateOtpPending(key, {
        phase: 'manual',
        message: 'Automatic email lookup finished without a code — enter it manually.',
      });
      log('[otp] every configured mailbox source finished without a code — enter it manually', taskId);
    }
  } finally {
    if (forwardAbort) fetchState.controller.signal.removeEventListener('abort', forwardAbort);
    if (sourceController && !sourceController.signal.aborted) {
      sourceController.abort(new Error('OTP lookup finished'));
    }
    if (otpFetches.get(key) === fetchState) otpFetches.delete(key);
  }
}

// ── Log verbosity ───────────────────────────────────────────────────────────────
// The engine and the Shape farmer both relay their raw stdout here, and the monitor re-emits a
// status every ~4s. That is the right level of detail when debugging the module and far too much
// for someone just running a drop: the useful line ("Adding To Cart") scrolls past between
// hundreds of "Getting Product(s)".
//
// Quiet is the DEFAULT. It drops routine chatter but never drops a failure — KEEP_IN_QUIET below
// is the escape hatch, so a decline body, a crashed farmer or a port clash still reaches the log.
// Set targetVerboseLogs in Settings to see everything again.
// When on, this copy never polls Target for stock — it acts only on stock-pings pushed in from the
// shared monitor. Off by default: turning it on with no monitor feeding it means tasks sit idle
// forever, and that must be a deliberate choice rather than something a user discovers mid-drop.
function sharedMonitorOnly() {
  try { return !!(dm.getSettings() || {}).targetSharedMonitorOnly; } catch { return false; }
}

function verboseLogs() {
  try { return !!(dm.getSettings() || {}).targetVerboseLogs; } catch { return false; }
}

// Anything matching this is ALWAYS logged, quiet or not. Erring toward keeping a line: a missing
// diagnostic costs a debugging session, an extra line costs one row.
// This used to also keep "warm done" and "bounced off", because targetVerboseLogs had no Settings
// control and verboseLogs() was permanently false — widening the regex was the only way to surface
// anything. Now that the switch exists, those lines belong behind it: they are step-by-step tuning
// output. The per-worker outcome still reaches everyone via "no atc".
// "bank:" and "browsers:" are the two lines that say whether farming is actually WORKING, and they
// were the only ones quiet mode dropped — so the log showed every failed harvest and never the
// successes beside them. That made the farmer look broken during a drop where it was in fact
// serving cookies the whole time (four orders were placed off it). A yield of 3/40 and a yield of
// 30/40 have to be distinguishable without turning verbose on.
const KEEP_IN_QUIET = /(error|fail|fatal|decline|refus|424|4\d\d body|EADDRINUSE|exited|missing|not starting|still in use|blocked|invalid|unauthor|timed? ?out|no atc|captcha|signature|replay canary|^\[shape\] bank:|^\[shape\] browsers:|farmer worker|- polls \d+\/\d+|: \+\d+ (login|atc) in |\[unexpected\])/i;

const ENGINE_PORT = 8727;   // must match the engine's -port flag
// Local Shape cookie broker. Defined ONCE here and pushed to both children — the farmer binds it
// (via ZYN_SHAPE_PORT) and the engine polls it (same var). Two hardcoded copies is what
// left the engine dialling a port the farmer had already vacated.
const SHAPE_PORT = 4727;
// Both loopback services — the cookie broker on SHAPE_PORT and the engine bridge on ENGINE_PORT —
// used to accept anything that could open a socket. On a shared or compromised machine that meant any
// local process could pull a live proxy credential out of the broker, or win the race to the bridge
// and be handed the task payload (pool, account password, card number) as the "engine". Neither side
// is reachable off-box (both bind 127.0.0.1), so a per-launch secret shared with our own children is
// enough: they already receive ZYN_SHAPE_PORT the same way, and nobody else can read our env block.
// Regenerated every launch, so a token learned once does not survive a restart.
const SHAPE_TOKEN = crypto.randomBytes(24).toString('hex');
// One shared monitor drives every checkout task in the module (see sendStart). Its id is fixed so
// stop/restart always replaces the same monitor instead of accumulating one per run.
const MONITOR_ID = 'target-monitor';

let wss = null;         // WebSocket.Server the engine dials into
// Set once the app is quitting. Teardown is not just "kill the children": stopTarget ENDS by calling
// ensureHarvesterBroker(), which arms a 250ms retry timer that spawns a brand-new farmer. On quit
// that timer fires after the window is gone, producing a parentless node holding :4727 — exactly the
// orphan that then blocks the next launch. Every respawn path checks this flag.
let quitting = false;
let boundPort = 0;              // the port the bridge ACTUALLY got (may differ from ENGINE_PORT)
const serverWaiters = [];       // callbacks queued while the socket is still binding
let startSeq = 0;               // bumped by stopTarget; a queued spawn from an older run is dropped
let engineConn = null;  // the engine's live socket (null when disconnected)
let engineProc = null;  // the backend.exe child process
let runningEngineVersion = '';
let farmerProc = null;  // the Shape cookie farmer/broker (node bot/shape-farmer.mjs, port 4727)
// Managed harvesters are isolated producer processes. They never bind :4727; each posts signed
// cookies into the single broker above, so one route/browser can be stopped or crash without
// interrupting the shared bank or another harvester.
const harvesterProcs = new Map(); // id -> { proc, fingerprint }
const harvesterStartFailures = new Map(); // id -> failure key, suppresses repeated reconciliation logs
let harvesterSyncTimer = null;
let win = null;         // renderer window for IPC
// Starts are additive, so a single pending slot is lossy while the engine is connecting or finishing
// a prior run. Preserve each config as its own FIFO entry: its SKU/quantity fields belong to that
// batch and must not be overwritten by a later group start.
const pendingTargetStarts = [];

function queueTargetStart(config) {
  pendingTargetStarts.push(config);
}

function removePendingTargetStartTask(taskId) {
  const requestedId = String(taskId || '');
  if (!requestedId) return;
  for (let index = pendingTargetStarts.length - 1; index >= 0; index -= 1) {
    const config = pendingTargetStarts[index];
    const tasks = Array.isArray(config && config.tasks) ? config.tasks : [];
    const remaining = tasks.filter(task => String(task && task.id || '') !== requestedId);
    if (!remaining.length) pendingTargetStarts.splice(index, 1);
    else if (remaining.length !== tasks.length) pendingTargetStarts[index] = { ...config, tasks: remaining };
  }
}

function clearPendingTargetStarts() {
  pendingTargetStarts.length = 0;
}
let taskActive = false;
// Ids of the checkout tasks currently handed to the engine. Needed so a per-task stop knows whether
// any siblings are still running (and the engine should stay up) and so an engine crash can clear
// every card rather than just one.
let runningTaskIds = new Set();
// Everything ever handed to the engine in a send-configs, keyed by name. The engine replaces each
// map wholesale, so a later start must re-send the earlier entries or it silently revokes them from
// tasks that are still running on them. See sendConfigs().
const sentConfigs = { profiles: {}, accounts: {}, proxies: {} };
// taskId -> accountId, so a confirmed order can be attributed to the account that placed it. The
// engine's product message carries the task id but not the account, and by the time it lands the
// task config is no longer in scope.
const taskAccountById = new Map();
// taskId -> profileId, retained for request-code messages that arrive after startTarget returned.
const taskProfileById = new Map();
// Target's native implementation names continuous checkout Endless, while the public task
// contract calls it loopCheckout. Retain each launch so confirmed orders can prune capped SKUs.
const taskCheckoutConfigById = new Map(); // taskId -> { skus, qty, loopCheckout }
// Site ownership belongs to the shared transport. Pokemon Center registers into this same map and
// process later; legacy taskID/taskId/id spellings remain unchanged on the wire.
const engineTaskSites = new engineContract.TaskSiteRegistry();

// ── renderer IPC helpers ────────────────────────────────────────────────────────
// The isDestroyed() checks below are necessary but NOT sufficient: when the window is closed or
// reloaded, the render FRAME can be disposed while webContents still reports alive. send() then
// fails asynchronously inside Electron, which prints a full stack to stderr instead of throwing —
// so try/catch can't suppress it. With the engine relaying every line through here, that produced
// one stack trace per log line and grew the stdout log to 2.7 GB, freezing the app. attachWindow()
// therefore latches the window dead on 'closed'/'render-process-gone' and we stop sending entirely.
let rendererDead = false;

function attachWindow(mainWindow) {
  if (!mainWindow) return;
  if (mainWindow === win) {
    // Same BrowserWindow, but a reload replaces the render frame — un-latch if it's actually alive,
    // otherwise a single reload would silence the log for the rest of the session.
    try { rendererDead = mainWindow.isDestroyed(); } catch { rendererDead = true; }
    return;
  }
  win = mainWindow;
  rendererDead = false;
  // Losing the window also means nothing is watching the run — tear the engine/farmer down rather
  // than leaving backend.exe and headful Chrome windows orphaned (both were seen surviving a close).
  const die = () => {
    rendererDead = true;
    try { if (taskActive || engineProc || farmerProc) stopTarget(); } catch {}
    try { if (pokemonTaskIds.size) stopPokemonCenter(); } catch {}
    try { if (walmartTaskIds.size) stopWalmart(); } catch {}
  };
  try {
    mainWindow.once('closed', die);
    mainWindow.webContents.once('destroyed', die);
    mainWindow.webContents.on('render-process-gone', die);
    // A crash is followed by an automatic reload (see electron.js). Once the new frame has loaded it
    // can receive again — without this the log would stay silenced until the app was restarted.
    mainWindow.webContents.on('did-finish-load', () => { rendererDead = false; });
  } catch {}
}

function toRenderer(channel, payload) {
  if (rendererDead) return;
  try {
    if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, payload);
    } else {
      rendererDead = true;
    }
  } catch { rendererDead = true; }
}
// Log lines are BATCHED before crossing to the renderer. The engine and the farmer together emit
// bursts of output, and one IPC message + one React re-render per line is enough to kill the render
// process when the app is backgrounded (Chromium throttles background renderers, the IPC queue backs
// up, the renderer dies — the black screen on app-switch, and the source of the disposed-frame
// flood). One message per flush interval keeps the UI responsive no matter how loud the engine gets.
const LOG_FLUSH_MS = 250;
const LOG_BUF_MAX = 800;   // matches the reducer's cap; drops oldest if the renderer stalls
let logBufs = {};          // taskId ('' = module-level) -> pending lines
let logTimer = null;

// Logs are buffered PER TASK. The engine tags its output with the task it came from, so a card
// shows only its own run; anything untagged (engine lifecycle, farmer, monitor) is module-level
// and keyed under ''. Without the split, ten tasks would share one firehose and none of them
// would be readable.
function flushLogs() {
  logTimer = null;
  const byTask = {};
  for (const key of Object.keys(logBufs)) {
    const lines = logBufs[key];
    if (!lines || !lines.length) continue;
    delete logBufs[key];
    byTask[key] = lines;
  }
  if (Object.keys(byTask).length) toRenderer('targetLogBatch', { byTask });
}

const LOG_LINE_MAX = 500;   // a single Shape header value is ~4 KB; 800 retained lines of those is not free
// Proxies leak into the log from two directions: the farmer names the one it failed on
// ("worker 0: no atc via host:port") and Go surfaces raw dial errors ("dial tcp 1.2.3.4:7778").
// Both end up in logs that get pasted into chat for debugging, which quietly publishes a paid
// proxy pool. Redacting HERE rather than at each source is deliberate — every line already funnels
// through log(), so a future caller cannot forget to scrub.
//
// Loopback is preserved on purpose: "127.0.0.1:4727" is a real diagnostic (the Shape broker) and
// tells an attacker nothing.
function redactProxies(line) {
  return String(line)
    // user:pass@host:port — drop the credentials outright, they are the part that matters
    .replace(/\b[^\s:/@]+:[^\s:/@]+@[a-z0-9.\-]+:\d{2,5}\b/gi, '<proxy>')
    // bare ipv4:port, except loopback / any-address
    .replace(/\b(?!127\.0\.0\.1\b)(?!0\.0\.0\.0\b)(?:\d{1,3}\.){3}\d{1,3}:\d{2,5}\b/g, '<proxy>')
    // gateway hostnames look like resipro.example.com:7777. Target's own URLs never carry a port
    // in these logs, so this cannot swallow one.
    .replace(/\b(?!localhost\b)[a-z0-9][a-z0-9.\-]*\.[a-z]{2,}:\d{2,5}\b/gi, '<proxy>');
}

// Setup chatter — login mode, session state, cookie-bank sizing, "engine connected". Useful when
// something will not start, noise on every single run. Verbose-only; the lines that report a
// PROBLEM go through log() so they always show.
const vlog = (line, taskId = '') => { if (verboseLogs()) log(line, taskId); };

// Full detail when running from source, plain sentences in a shipped build.
//
// Keyed on the app being UNPACKAGED so it needs nothing remembered at release time — the thing you
// have to remember to switch is the thing that ships wrong. `targetVerboseLogs` still forces raw
// output on any build, for a user we are debugging with.
let _isDev = null;
function devLogs() {
  if (_isDev === null) {
    try { _isDev = !require('electron').app.isPackaged; } catch { _isDev = true; }
  }
  return _isDev || verboseLogs();
}

// Per-card repeat tracking for the collapser in log().
const repeatState = {};

// Native and upstream failures can contain implementation identities. Normalize only known retired
// Zyn product identifiers at the renderer boundary; retailer product names remain untouched.
const retiredProductText = [
  [80, 111, 108, 97, 114, 32, 65, 73, 79],
  [80, 111, 108, 97, 114, 65, 73, 79],
  [72, 111, 112, 101, 32, 98, 114, 111, 107, 101, 114],
  [112, 111, 108, 97, 114, 45, 98, 97, 99, 107, 101, 110, 100],
  [112, 111, 108, 97, 114, 45, 119, 115, 115, 45, 112, 114, 111, 100, 117, 99, 116, 105, 111, 110],
  [72, 79, 80, 69, 95],
].map(bytes => String.fromCharCode(...bytes));
function zynBrandText(value) {
  let output = String(value == null ? '' : value);
  for (const retired of retiredProductText) output = output.split(retired).join('Zyn');
  return output;
}

const log = (line, taskId = '') => {
  if (rendererDead) return;
  let s = zynBrandText(redactProxies(line));
  if (!devLogs()) {
    // Allow-list: anything not recognised is dropped rather than shown raw, so engine chatter added
    // later cannot leak by default. plainLog.leaksInternals is the belt-and-braces check in case a
    // rule is ever written badly.
    s = plainLog.plainify(s);
    if (!s || plainLog.leaksInternals(s)) return;
  }
  const key = taskId || '';

  // Collapse an identical line repeating on the same card.
  //
  // A task pinned to a dead proxy retries on a fixed delay and emits the SAME line forever. Ten of
  // those ran at once on 2026-08-04 — roughly seven lines a second, indefinitely — and every one
  // became a buffer push, a flush, a Redux dispatch and a re-render. That is what made the window
  // stop responding; the underlying bug was the proxy never rotating, but a log that cannot be
  // out-run by a stuck task is worth having on its own.
  //
  // Every 25th repeat still prints, carrying the count, so a genuinely stuck task stays visible
  // instead of going silent — which would be its own kind of lie.
  const rep = repeatState[key] || (repeatState[key] = { last: '', n: 0 });
  if (s === rep.last) {
    rep.n += 1;
    if (rep.n % 25 !== 0) return;
    s = `${s}  (×${rep.n})`;
  } else {
    rep.last = s;
    rep.n = 0;
  }

  const buf = logBufs[key] || (logBufs[key] = []);
  buf.push(s.length > LOG_LINE_MAX ? s.slice(0, LOG_LINE_MAX) + '…' : s);
  if (buf.length > LOG_BUF_MAX) logBufs[key] = buf.slice(-LOG_BUF_MAX);
  if (!logTimer) logTimer = setTimeout(flushLogs, LOG_FLUSH_MS);
};

function logMonitorLine(line) {
  log(String(line || ''));
}

let lastSkuTitlePayload = '';
// Status used to cross to the renderer on every distinct engine step. Identical repeats are still
// dropped, but a real change is coalesced per task (last write wins) so 31 checkout tasks cannot
// each paint the Task Groups page 10 times in one burst. Stop/terminal still flushes immediately.
let lastStatusKeys = {};
function forgetStatusKeys(ids) {
  for (const id of ids) {
    if (!id && id !== 0) continue;
    delete lastStatusKeys[id];
    delete lastStatusKeys[String(id)];
  }
}
const statusCoalescer = createStatusCoalescer({
  intervalMs: STATUS_FLUSH_MS,
  send: updates => toRenderer('targetStatusBatch', { updates }),
});
// taskState is the ENGINE's own step (constants.StatusSteps: 0 idle, 1 running, 2 carted,
// 3 checked out, 4 declined), forwarded rather than inferred. The UI groups tasks by it, and
// guessing "carted" from the wording of a status line would be wrong the first time the engine
// rephrased one — which is a bad way to find out that the group you clicked selected nothing.
const status = (state, color, detail, taskId = '', taskState, running) => {
  const id = taskId || '';
  state = zynBrandText(state);
  detail = zynBrandText(detail);
  const key = state + '|' + (color || '') + '|' + (detail || '') + '|' + taskState + '|' + running;
  if (lastStatusKeys[id] === key) return;
  lastStatusKeys[id] = key;
  statusCoalescer.enqueue(id, {
    taskId: id, state, label: state, color: color || '', detail: detail || '',
    taskState: typeof taskState === 'number' ? taskState : undefined,
    running: typeof running === 'boolean' ? running : undefined,
  }, { immediate: running === false });
  if (id) {
    if (running === false) releaseLoginHarvesterTask(id);
    else noteLoginHarvesterTaskStatus(id, { state, detail, running });
  }
};
const flushStartingStatuses = coalescer => {
  if (coalescer && typeof coalescer.flushNow === 'function') coalescer.flushNow();
};

// ── engine binary path (packaged sibling of app.asar, or repo dir in dev) ────────
function bundledEnginePath() {
  const packed = process.resourcesPath && path.join(process.resourcesPath, 'engine', plat.engineBin());
  if (packed && fs.existsSync(packed)) return packed;
  return path.join(__dirname, '..', '..', 'backend', plat.engineBin());
}

function enginePath() {
  // The runtime manager installs engines side by side and changes this pointer only for future
  // spawns. A child that already owns tasks keeps its original executable and process image.
  const downloaded = String(process.env.ZYN_ENGINE_PATH || '');
  if (downloaded && fs.existsSync(downloaded)) return downloaded;
  return bundledEnginePath();
}

function bundledEngineVersion() {
  const candidates = [
    path.join(__dirname, '..', '..', '..', 'config', 'engine-runtime.json'),
    process.resourcesPath ? path.join(process.resourcesPath, 'engine-runtime.json') : '',
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      const version = JSON.parse(fs.readFileSync(file, 'utf8')).version;
      if (version) return String(version);
    } catch {}
  }
  return '';
}

function installedEngineRaw() {
  const downloaded = String(process.env.ZYN_ENGINE_PATH || '');
  if (downloaded && enginePath() === downloaded) {
    return String(process.env.ZYN_ENGINE_VERSION || '');
  }
  return bundledEngineVersion();
}

function getEngineInfo() {
  return engineInfoFrom({
    runningRaw: runningEngineVersion || installedEngineRaw(),
    installedRaw: installedEngineRaw() || bundledEngineVersion(),
    engineRunning: Boolean(engineProc),
  });
}

// Where the farmer mirrors its cookie bank. Both spawns below get the same path, so the broker-only
// process that REPLACES a killed farmer reloads the bank that farmer had earned instead of coming up
// empty. Returns '' outside Electron, which simply disables persistence rather than failing.
function bankFile() {
  try { return path.join(require('electron').app.getPath('userData'), 'target-cookie-bank.json'); }
  catch { return ''; }
}

// Kill harvest browsers that outlived their farmer.
//
// killTree uses taskkill /F /T, which force-kills the tree — so the farmer never receives a signal
// and never gets to close its browsers itself. Playwright's Chromium is a separate OS process and is
// frequently no longer inside that tree by the time this runs, so /T misses it: the app returns to
// the key gate while four harvest windows keep going, holding proxy sessions, reachable only through
// Task Manager. That is what "Stop All" did.
//
// Matched on OUR OWN launch flags, never on process name. Every harvest browser carries
// --disable-blink-features=AutomationControlled AND the off-screen window position; the operator's
// own Chrome carries neither. Requiring BOTH is what makes it safe to run while they are browsing.
// Run before the first farmer of a session. A crash, a Task Manager kill or a power loss runs no
// handler at all, so browsers from the PREVIOUS session can still be alive — holding proxy sessions
// and counting against the provider's concurrency while the new run wonders why it is being limited.
let staleSwept = false;
function sweepStaleHarvestersOnStart() {
  if (staleSwept) return;   // once per app session — this blocks, and it is only ever leftovers
  staleSwept = true;
  sweepOrphanHarvesters();
}

// The sweep itself, and the list of browser forks it knows about, now live in platform.js — the
// matching rule is identical, only the way you enumerate processes differs by OS. Never sweep while
// ANOTHER farmer is alive: a dev instance and the packaged app can both be running (this was found
// with exactly that pair on screen) and the flag match cannot tell whose browsers are whose.
const sweepOrphanHarvesters = plat.sweepOrphanHarvesters;
const killTree = plat.killTree;

// A full stop gives the native monitor one short, bounded chance to publish its exact final wire
// counters. Keep only the two normalized identifiers needed to correlate that acknowledgement; the
// telemetry payload itself, request data, proxy values, and product inputs are never retained here.
const TARGET_ENGINE_STOP_GRACE_MS = 1500;
const activeMonitorBandwidthRuns = new Map(); // monitorId -> runId
let pendingTargetEngineStop = null;

function trackTargetMonitorBandwidth(message) {
  const monitorId = message.monitorId;
  const runId = message.runId;
  if (message.running) {
    activeMonitorBandwidthRuns.set(monitorId, runId);
    return null;
  }
  if (activeMonitorBandwidthRuns.get(monitorId) === runId) {
    activeMonitorBandwidthRuns.delete(monitorId);
  }
  acknowledgeLiveEditMonitorStop(monitorId);
  targetMainMonitorPendingStopIds.delete(monitorId);
  const pending = pendingTargetEngineStop;
  if (!pending || pending.expectedRuns.get(monitorId) !== runId) return null;
  pending.expectedRuns.delete(monitorId);
  return pending.expectedRuns.size === 0 ? pending : null;
}

function forcePendingTargetEngineStop(pending = pendingTargetEngineStop) {
  if (!pending || pendingTargetEngineStop !== pending || pending.forceIssued) return false;
  pending.forceIssued = true;
  if (pending.timer) clearTimeout(pending.timer);
  pending.timer = null;
  killTree(pending.proc);
  return true;
}

function beginTargetEngineStop(proc) {
  if (!proc) {
    activeMonitorBandwidthRuns.clear();
    return false;
  }
  if (pendingTargetEngineStop) {
    if (pendingTargetEngineStop.proc === proc) return !pendingTargetEngineStop.forceIssued;
    forcePendingTargetEngineStop(pendingTargetEngineStop);
  }
  const pending = {
    proc,
    expectedRuns: new Map(activeMonitorBandwidthRuns),
    timer: null,
    forceIssued: false,
  };
  pendingTargetEngineStop = pending;
  const connected = engineConn && engineConn.readyState === WebSocket.OPEN;
  if (!connected || pending.expectedRuns.size === 0) {
    forcePendingTargetEngineStop(pending);
    return false;
  }
  pending.timer = setTimeout(() => forcePendingTargetEngineStop(pending), TARGET_ENGINE_STOP_GRACE_MS);
  if (pending.timer && typeof pending.timer.unref === 'function') pending.timer.unref();
  return true;
}

function finishTargetEngineStop(proc) {
  const pending = pendingTargetEngineStop;
  if (!pending || pending.proc !== proc) return false;
  activeMonitorBandwidthRuns.clear();
  if (pending.timer) clearTimeout(pending.timer);
  pending.timer = null;
  pendingTargetEngineStop = null;
  return true;
}

// ── Shape cookie farmer ──────────────────────────────────────────────────────────
// Target.com is behind Shape/F5. The engine fetches signed Shape headers from a local broker on
// :4727 (see bot/shape-farmer.mjs). We launch that farmer with the task's own proxy group so the
// cookies are harvested — and IP-bound — through the same proxies the engine replays them on.
function isPackaged() { try { return require('electron').app.isPackaged; } catch { return false; } }
function botDirPath() {
  return isPackaged() ? path.join(process.resourcesPath, 'bot') : path.join(__dirname, '..', '..', 'bot');
}

const HARVESTER_BROWSERS = new Set(['auto', 'chrome', 'msedge', 'brave', 'vivaldi', 'yandex', 'opera', 'chromium']);
// Running is deliberately session-only. Persisted settings describe how a harvester should run,
// but only an explicit Start-button IPC may add its id to this set. This prevents app startup,
// settings saves, proxy edits, restores, and the periodic reconciler from reviving old run state.
const explicitlyStartedHarvesterIds = new Set();

function normalizedManagedHarvesterId(value, fallback = '') {
  return String(value || fallback).replace(/[^a-z0-9_-]/gi, '').slice(0, 64);
}

function setManagedHarvesterRunning(command = {}) {
  const id = normalizedManagedHarvesterId(command && command.id);
  if (!id || (command.running !== true && command.running !== false)) return false;
  if (id === LOGIN_HARVESTER_ID) return false;
  let settings = {};
  try { settings = dm.getSettings() || {}; } catch {}
  const configured = Array.isArray(settings.targetHarvesters)
    && settings.targetHarvesters.some((raw, index) => normalizedManagedHarvesterId(
      raw && raw.id, `harvester-${index + 1}`,
    ) === id);
  if (!configured) {
    explicitlyStartedHarvesterIds.delete(id);
    return false;
  }
  if (command.running) explicitlyStartedHarvesterIds.add(id);
  else explicitlyStartedHarvesterIds.delete(id);
  return true;
}

function managedHarvesterConfigs() {
  let settings = {};
  try { settings = dm.getSettings() || {}; } catch {}
  // A missing setting is a fresh/legacy install with no user-created harvesters. Treat it as an
  // explicit empty managed list so starting checkout cannot resurrect the retired task-owned
  // producer and consume local or proxy bandwidth without the user configuring one.
  const userList = Array.isArray(settings.targetHarvesters) ? settings.targetHarvesters : [];
  const configs = userList.filter(raw => (raw && raw.type) !== 'login'
    && normalizedManagedHarvesterId(raw && raw.id) !== LOGIN_HARVESTER_ID).map((raw, index) => {
    const type = ['atc', 'auto'].includes(raw && raw.type) ? raw.type : 'auto';
    const engine = String((raw && raw.engine) || '').toLowerCase() === 'patchright' ? 'patchright' : 'playwright';
    const route = String((raw && raw.proxyListName) || '');
    const workerCap = route ? 100 : 2;
    const requestedWorkers = Math.max(1, Math.min(workerCap, parseInt(raw && raw.workers, 10) || 1));
    const id = normalizedManagedHarvesterId(raw && raw.id, `harvester-${index + 1}`);
    return {
      id,
      name: String((raw && raw.name) || `Harvester ${index + 1}`).slice(0, 80),
      type,
      engine,
      atcMode: raw && raw.atcMode === 'v2' ? 'v2' : 'v1',
      browser: HARVESTER_BROWSERS.has(raw && raw.browser) ? raw.browser : 'auto',
      proxyListName: route,
      // Two home-IP workers are useful; more only duplicates one route and is unnecessarily noisy.
      workers: requestedWorkers,
      input: String((raw && raw.input) || '').slice(0, 12000),
      cookieTtlSec: Math.max(30, Math.min(86400, parseInt(raw && raw.cookieTtlSec, 10) || 600)),
      intervalDelaySec: Math.max(0, Math.min(3600, parseInt(raw && raw.intervalDelaySec, 10) || 0)),
      loadsPerBrowser: Math.max(1, Math.min(10, parseInt(raw && raw.loadsPerBrowser, 10) || 3)),
      startSchedule: String((raw && raw.startSchedule) || ''),
      stopSchedule: String((raw && raw.stopSchedule) || ''),
      enabled: explicitlyStartedHarvesterIds.has(id),
    };
  }).filter(config => config.id);
  if (explicitlyStartedHarvesterIds.has(LOGIN_HARVESTER_ID)) {
    configs.push(buildTargetLoginHarvesterConfig(settings, true));
  }
  const configuredIds = new Set(configs.map(config => config.id));
  configuredIds.add(LOGIN_HARVESTER_ID);
  for (const id of [...explicitlyStartedHarvesterIds]) {
    if (!configuredIds.has(id)) explicitlyStartedHarvesterIds.delete(id);
  }
  return configs;
}

function harvesterScheduleActive(config, now = Date.now()) {
  if (!config.enabled) return false;
  const startsAt = config.startSchedule ? Date.parse(config.startSchedule) : NaN;
  const stopsAt = config.stopSchedule ? Date.parse(config.stopSchedule) : NaN;
  if (Number.isFinite(startsAt) && now < startsAt) return false;
  if (Number.isFinite(stopsAt) && now >= stopsAt) return false;
  return true;
}

const loginLatchedTaskIds = new Set();
const lastTargetTaskStatusText = new Map();
let loginHarvesterStopTimer = null;
let loginHarvesterReconcileTimer = null;

function accountHasSavedSession(accountId) {
  try {
    const accounts = dm.getAccounts() || [];
    const account = accounts.find(item => String(item && item.id) === String(accountId || ''));
    return Boolean(account && account.hasSession);
  } catch {
    return false;
  }
}

function otpPendingNeedsLoginHarvester() {
  if (!otpPending.size) return false;
  for (const entry of otpPending.values()) {
    const taskId = String((entry && entry.taskId) || '');
    if (taskId && runningTaskIds.has(taskId)) return true;
    const waiters = entry && entry.waiters;
    if (waiters) {
      for (const id of waiters) {
        if (runningTaskIds.has(String(id))) return true;
      }
    }
  }
  return false;
}

function runningTasksNeedingLogin() {
  const ids = [];
  const seen = new Set();
  const add = (id) => {
    const value = String(id || '');
    if (!value || seen.has(value) || !runningTaskIds.has(value)) return;
    seen.add(value);
    ids.push(value);
  };
  for (const id of runningTaskIds) {
    if (loginLatchedTaskIds.has(id) || loginStatusNeedsHarvester(lastTargetTaskStatusText.get(id))) {
      add(id);
    }
  }
  for (const entry of otpPending.values()) {
    add(entry && entry.taskId);
    if (entry && entry.waiters) {
      for (const id of entry.waiters) add(id);
    }
  }
  return ids;
}

function setLoginHarvesterRunning(running) {
  const next = running === true;
  const current = explicitlyStartedHarvesterIds.has(LOGIN_HARVESTER_ID);
  if (next === current) return false;
  if (next) explicitlyStartedHarvesterIds.add(LOGIN_HARVESTER_ID);
  else explicitlyStartedHarvesterIds.delete(LOGIN_HARVESTER_ID);
  return true;
}

function loginHarvesterDemandState() {
  return {
    authorized: targetHarvestAuthorized,
    runningTaskIds,
    latchedTaskIds: loginLatchedTaskIds,
    otpPending: otpPendingNeedsLoginHarvester(),
    statuses: lastTargetTaskStatusText,
  };
}

function reconcileLoginHarvester() {
  if (loginHarvesterReconcileTimer) {
    clearTimeout(loginHarvesterReconcileTimer);
    loginHarvesterReconcileTimer = null;
  }
  if (quitting) {
    clearLoginHarvesterState();
    return;
  }
  const neededIds = runningTasksNeedingLogin();
  let demandChanged = neededIds.length !== targetLoginDemandTaskIds.size;
  if (!demandChanged) {
    for (const id of neededIds) {
      if (!targetLoginDemandTaskIds.has(id)) {
        demandChanged = true;
        break;
      }
    }
  }
  targetLoginDemandTaskIds.clear();
  for (const id of neededIds) targetLoginDemandTaskIds.add(id);
  if (demandChanged) syncTargetCookieBankDemand();

  const needed = loginHarvesterShouldRun(loginHarvesterDemandState());
  if (needed) {
    if (loginHarvesterStopTimer) {
      clearTimeout(loginHarvesterStopTimer);
      loginHarvesterStopTimer = null;
    }
    if (setLoginHarvesterRunning(true)) {
      log('[target] starting login harvester — tasks need a Target sign-in');
    }
    ensureHarvesterBroker();
    return;
  }

  if (!explicitlyStartedHarvesterIds.has(LOGIN_HARVESTER_ID)) return;
  if (loginHarvesterStopTimer) return;
  loginHarvesterStopTimer = setTimeout(() => {
    loginHarvesterStopTimer = null;
    if (loginHarvesterShouldRun(loginHarvesterDemandState())) {
      reconcileLoginHarvester();
      return;
    }
    if (setLoginHarvesterRunning(false)) {
      log('[target] stopping login harvester — no tasks waiting for sign-in');
    }
    syncHarvesterProducers();
  }, LOGIN_HARVESTER_STOP_DELAY_MS);
  loginHarvesterStopTimer.unref?.();
}

function scheduleLoginHarvesterReconcile() {
  if (loginHarvesterReconcileTimer) return;
  loginHarvesterReconcileTimer = setTimeout(() => {
    loginHarvesterReconcileTimer = null;
    reconcileLoginHarvester();
  }, 50);
  loginHarvesterReconcileTimer.unref?.();
}

function latchLoginHarvesterForTasks(tasks) {
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const id = String((task && task.id) || '');
    if (!id) continue;
    if (!accountHasSavedSession(task.accountId)) loginLatchedTaskIds.add(id);
  }
  scheduleLoginHarvesterReconcile();
}

function releaseLoginHarvesterTask(taskId) {
  const id = String(taskId || '');
  if (!id) return;
  loginLatchedTaskIds.delete(id);
  lastTargetTaskStatusText.delete(id);
  scheduleLoginHarvesterReconcile();
}

function noteLoginHarvesterTaskStatus(taskId, status) {
  const id = String(taskId || '');
  if (!id) return;
  const text = [status && status.state, status && status.label, status && status.detail]
    .filter(Boolean).join(' ');
  lastTargetTaskStatusText.set(id, text);
  if (loginStatusClearsHarvester(text)) loginLatchedTaskIds.delete(id);
  scheduleLoginHarvesterReconcile();
}

function clearLoginHarvesterState() {
  if (loginHarvesterStopTimer) {
    clearTimeout(loginHarvesterStopTimer);
    loginHarvesterStopTimer = null;
  }
  if (loginHarvesterReconcileTimer) {
    clearTimeout(loginHarvesterReconcileTimer);
    loginHarvesterReconcileTimer = null;
  }
  explicitlyStartedHarvesterIds.delete(LOGIN_HARVESTER_ID);
}

function managedHarvesterMode() { return managedHarvesterConfigs() !== null; }

// Delete decrypted pool files left behind by earlier runs — including runs of versions that never
// cleaned up at all. Anything still present is by definition finished with: the farmer unlinks its own
// file within a second of starting, so a survivor means that process is long gone. Skips files younger
// than a minute purely so a farmer starting concurrently can't have the rug pulled out from under it.
function sweepStaleProxyFiles() {
  try {
    const dir = os.tmpdir();
    const cutoff = Date.now() - 60_000;
    let n = 0;
    for (const f of fs.readdirSync(dir)) {
      if (!/^shape-proxies-\d+\.txt$/.test(f)) continue;   // exact shape, never a broad glob
      const full = path.join(dir, f);
      try {
        if (fs.statSync(full).mtimeMs > cutoff) continue;
        fs.unlinkSync(full);
        n++;
      } catch {}
    }
    if (n) log(`cleaned up ${n} leftover proxy file(s) from previous runs`);
  } catch {}
}
const findNodeExe = nodeExecutable;

// Standalone broker for Harvester mode. The broker lives inside the farmer process, so it must be
// present before an external Chrome capture reaches Zyn's port-4312 compatibility bridge.
//
// This starts the same process with no farming workers. The main process filters the capture, then
// asks this module to authenticate one /saveCookies write to the tracked broker on :4727.
let brokerOnly = false;
// Guards the async port wait in ensureHarvesterBroker: stopTarget can be called repeatedly (Stop All
// plus a per-task Stop), and without this each call queued another spawn that all raced the same port.
let brokerPending = false;
let farmerPending = false;   // same guard for the real farmer's port wait
// A farmer start that arrived while another spawn was mid-flight. Held rather than dropped, so the
// newer request survives the older chain being abandoned. See startFarmer().
let farmerWanted = null;

// Hand a finished port chain over to whatever start came in behind it. A chain abandoned because the
// run generation moved on used to just vanish: no farmer, no log line, no card status — and the only
// visible symptom was the engine dialling :4727 several times a second for the rest of the session.
function farmerChainDone() {
  farmerPending = false;
  const next = farmerWanted;
  farmerWanted = null;
  if (next && targetHarvestAuthorized && !quitting && !farmerProc) startFarmer(next);
}

// Dynamic Target cookie-bank demand. The broker is the only authority that accepts cookies, while
// this bridge is the only authority that knows which checkout tasks actually reached the engine.
// Keep those concerns separate: publish counts and a per-task setting, never task ids or secrets.
const TARGET_ATC_COOKIES_PER_TASK_DEFAULT = 3;
const TARGET_COOKIE_TASK_MAX = 1000;
const TARGET_COOKIE_TOTAL_MAX = 10000;
const TARGET_ATC_COOKIES_PER_TASK_MAX = Number.MAX_SAFE_INTEGER;
const targetCookieActiveTaskIds = new Set();
const targetCookieStandbySources = new Map();
// The launcher explicitly opens this latch after the replacement license authority reports an
// active session. Task-group bootstrap runs before that authority exists, so default-deny here is
// what prevents saved harvesters from consuming local/proxy bandwidth while signed out.
let targetHarvestAuthorized = false;
let targetCookieDemandRetryTimer = null;
let targetCookieDemandInFlight = false;
let lastTargetCookieDemandKey = '';
const targetLoginDemandTaskIds = new Set();

function normalizeTargetCookieTaskCount(value) {
  const parsed = Number.parseInt(String(value == null ? '' : value), 10);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(TARGET_COOKIE_TASK_MAX, parsed)) : 0;
}

function targetAtcCookiesPerTask() {
  let configured;
  try { configured = (dm.getSettings() || {}).targetAtcCookiesPerTask; } catch {}
  const parsed = Number.parseInt(String(configured == null ? '' : configured), 10);
  return Number.isFinite(parsed) && parsed >= 0
    ? Math.min(TARGET_ATC_COOKIES_PER_TASK_MAX, parsed)
    : TARGET_ATC_COOKIES_PER_TASK_DEFAULT;
}

function targetCookieDemand() {
  const activeTasks = Math.min(TARGET_COOKIE_TASK_MAX, targetCookieActiveTaskIds.size);
  // Once the Task Groups store has loaded, it is authoritative even at zero. Its initial migration
  // leaves the old target-tasks.json in place, so taking max forever would make deleted groups spring
  // back from that stale legacy copy and prevent the bank from scaling down.
  const taskGroupStandby = targetCookieStandbySources.get('task-groups') || 0;
  const hasLiveLegacyStandby = targetCookieStandbySources.has('legacy-live');
  const standbyTasks = taskGroupStandby > 0
    ? taskGroupStandby
    : hasLiveLegacyStandby
      ? targetCookieStandbySources.get('legacy-live')
      : targetCookieStandbySources.has('task-groups')
        ? 0
        : Math.max(0, ...targetCookieStandbySources.values());
  const basis = !targetHarvestAuthorized
    ? 'paused'
    : activeTasks ? 'active' : standbyTasks ? 'standby' : 'paused';
  const effectiveTasks = basis === 'paused' ? 0 : activeTasks || standbyTasks;
  const atcPerTask = targetAtcCookiesPerTask();
  return {
    mode: 'per-task',
    basis,
    activeTasks,
    standbyTasks,
    effectiveTasks,
    atcPerTask,
    targets: {
      // Login Shape signatures are only needed while a running task is signing in or recovering
      // a session. Standby ATC prefarm must not keep a login producer alive.
      login: basis === 'paused' ? 0 : Math.min(TARGET_COOKIE_TASK_MAX, targetLoginDemandTaskIds.size),
      atc: effectiveTasks > 0 && atcPerTask === 0
        ? null
        : Math.min(TARGET_COOKIE_TOTAL_MAX, effectiveTasks * atcPerTask),
    },
  };
}

function scheduleTargetCookieDemandRetry() {
  if (quitting || (!targetHarvestAuthorized && !farmerProc) || targetCookieDemandRetryTimer) return;
  targetCookieDemandRetryTimer = setTimeout(() => {
    targetCookieDemandRetryTimer = null;
    publishTargetCookieDemand();
  }, 500);
  targetCookieDemandRetryTimer.unref?.();
}

function publishTargetCookieDemand() {
  if (quitting || (!targetHarvestAuthorized && !farmerProc)) return targetCookieDemand();
  if (targetCookieDemandInFlight) {
    scheduleTargetCookieDemandRetry();
    return targetCookieDemand();
  }
  const demand = targetCookieDemand();
  const key = JSON.stringify(demand);
  const body = JSON.stringify({
    basis: demand.basis,
    activeTasks: demand.activeTasks,
    standbyTasks: demand.standbyTasks,
    atcPerTask: demand.atcPerTask,
    loginTasks: demand.targets.login,
  });
  targetCookieDemandInFlight = true;
  const req = http.request({
    host: '127.0.0.1', port: SHAPE_PORT, path: '/demand', method: 'POST', timeout: 1200,
    headers: {
      'x-zyn-token': SHAPE_TOKEN,
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    },
  }, (res) => {
    res.resume();
    res.on('end', () => {
      targetCookieDemandInFlight = false;
      if (res.statusCode >= 200 && res.statusCode < 300) {
        lastTargetCookieDemandKey = key;
        if (JSON.stringify(targetCookieDemand()) !== key) scheduleTargetCookieDemandRetry();
        return;
      }
      scheduleTargetCookieDemandRetry();
    });
  });
  req.on('error', () => {
    targetCookieDemandInFlight = false;
    scheduleTargetCookieDemandRetry();
  });
  req.on('timeout', () => req.destroy(new Error('cookie demand request timed out')));
  req.end(body);
  return demand;
}

function syncTargetCookieBankDemand() {
  const demand = targetCookieDemand();
  const key = JSON.stringify(demand);
  if (!targetHarvestAuthorized) {
    // A broker that was created while authorized may remain as the lightweight owner of the
    // persisted bank. Publish an explicit zero target so extension posts and in-flight producer
    // work cannot keep prefarming after revocation. Before first authorization there is no broker
    // and therefore nothing to contact or retry.
    if (farmerProc && key !== lastTargetCookieDemandKey) publishTargetCookieDemand();
    return demand;
  }
  ensureHarvesterBroker();
  if (key !== lastTargetCookieDemandKey || !farmerProc) publishTargetCookieDemand();
  return demand;
}

function setTargetHarvestAuthorized(authorized) {
  const next = authorized === true;
  targetHarvestAuthorized = next;
  lastTargetCookieDemandKey = '';
  if (!next) {
    clearLoginHarvesterState();
    // stopHarvesterProducer deletes before killing, so each child's exit callback cannot resurrect
    // itself; its delayed ensureHarvesterBroker call also observes this closed latch.
    for (const id of [...harvesterProcs.keys()]) stopHarvesterProducer(id);
    if (!farmerProc && targetCookieDemandRetryTimer) clearTimeout(targetCookieDemandRetryTimer);
    if (!farmerProc) targetCookieDemandRetryTimer = null;
  }
  const demand = syncTargetCookieBankDemand();
  if (next) scheduleLoginHarvesterReconcile();
  return demand;
}

function setTargetCookieStandbyTasks(source, count) {
  const name = String(source || 'external').slice(0, 40);
  const normalized = normalizeTargetCookieTaskCount(count);
  targetCookieStandbySources.set(name, normalized);
  return syncTargetCookieBankDemand();
}

function acceptTargetCookieTasks(tasks) {
  let changed = false;
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const id = String(task && task.id || '');
    if (id && !targetCookieActiveTaskIds.has(id)) {
      targetCookieActiveTaskIds.add(id);
      changed = true;
    }
  }
  if (changed) syncTargetCookieBankDemand();
  return changed;
}

function releaseTargetCookieTask(taskId) {
  const removed = targetCookieActiveTaskIds.delete(String(taskId || ''));
  if (removed) syncTargetCookieBankDemand();
  return removed;
}

function clearTargetCookieTasks() {
  if (!targetCookieActiveTaskIds.size) return false;
  targetCookieActiveTaskIds.clear();
  syncTargetCookieBankDemand();
  return true;
}

try {
  const legacy = dm.getTargetTasks && dm.getTargetTasks();
  const count = Array.isArray(legacy && legacy.tasks) ? legacy.tasks.length : 0;
  if (count > 0) targetCookieStandbySources.set('legacy-migrated', normalizeTargetCookieTaskCount(count));
} catch {}

function saveHarvesterCookie(cookie) {
  ensureHarvesterBroker();
  if (!farmerProc || farmerProc.killed || farmerProc.exitCode != null
      || Number(listenerPid(SHAPE_PORT)) !== Number(farmerProc.pid)) {
    return Promise.reject(new Error('Zyn does not own the Target cookie broker'));
  }
  const body = JSON.stringify(cookie || {});
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: SHAPE_PORT, path: '/saveCookies', method: 'POST', timeout: 1200,
      headers: {
        'x-zyn-token': SHAPE_TOKEN,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, res => {
      let response = '';
      res.on('data', chunk => {
        response += chunk;
        if (response.length > 65536) req.destroy(new Error('cookie broker response is too large'));
      });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(response || '{}'); }
        catch { reject(new Error('cookie broker returned invalid JSON')); return; }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`cookie broker returned ${res.statusCode}`));
          return;
        }
        resolve(parsed);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('cookie broker request timed out')));
    req.end(body);
  });
}

function ensureHarvesterBroker() {
  if (quitting) return;                         // never resurrect the broker while shutting down
  if (!targetHarvestAuthorized) return;         // license authority has not opened the reversible harvest latch
  const managed = managedHarvesterConfigs();
  if (managed) {
    armHarvesterScheduleSync();
    syncHarvesterProducers(managed);
    // Replace a legacy task-owned farmer with a broker-only owner. Checkout stopping must never
    // stop the managed cookie producers or their bank.
    if (farmerProc && !brokerOnly) {
      const pid = farmerProc.pid;
      killTree(farmerProc);
      farmerProc = null;
      sweepOrphanHarvesters(pid);
    }
  }
  if (farmerProc) return;                       // a task's farmer already provides the broker
  if (farmerPending) return;                    // a real farmer is mid-spawn — it wins, it can farm
  if (!managed && shapeMethodSetting() !== 'Harvester') return;

  const botDir = botDirPath();
  const script = path.join(botDir, 'shape-farmer.mjs');
  if (!fs.existsSync(script)) return;

  const env = nodeEnvironment({ FORCE_COLOR: '0', ZYN_SHAPE_PORT: String(SHAPE_PORT), ZYN_SHAPE_TOKEN: SHAPE_TOKEN,
    // The farmer watches its stdin for EOF and exits when it closes — the only parent-death
    // signal that survives a crash or an End Task, neither of which runs a quit handler.
    ZYN_PARENT_WATCH: '1', ZYN_OWNER_PID: String(process.pid), ZYN_ENGINE_PATH: enginePath() });

  // stopTarget kills the running farmer and calls straight into here, so this hits the SAME
  // kill-then-bind race that startFarmer had: the dead farmer still held :4727 and the broker
  // died on EADDRINUSE the moment it launched. Fixed there but not here, which is why the log
  // still alternated "harvester broker listening" with "broker error: EADDRINUSE".
  if (brokerPending) return;
  brokerPending = true;
  // Take the port back from our own orphan first; only then wait for it to actually free up.
  reclaimBrokerPort((mine) => {
    if (quitting || !targetHarvestAuthorized || !mine) { brokerPending = false; return; }
    whenPortFree(SHAPE_PORT, (free) => {
      brokerPending = false;
      if (quitting || !targetHarvestAuthorized) return; // authorization may close while the port probe is pending
      if (!free) { log(`harvester broker: port ${SHAPE_PORT} still in use — skipping`); return; }
      if (farmerProc || farmerPending) return;   // a real farmer claimed it (or is claiming it)
      spawnHarvesterBroker(script, botDir, env);
    });
  });
}

function spawnHarvesterBroker(script, botDir, env) {
  if (!targetHarvestAuthorized) return;
  let settings = {};
  try { settings = dm.getSettings() || {}; } catch {}
  const poolSize = parseInt(settings.targetCookieBank, 10) > 0 ? parseInt(settings.targetCookieBank, 10) : 0;
  const cookieTtlSec = parseInt(settings.targetCookieTtlSec, 10) > 0 ? parseInt(settings.targetCookieTtlSec, 10) : 600;
  const maxDrainPerMin = parseInt(settings.targetCookieDrainPerMin, 10) > 0 ? parseInt(settings.targetCookieDrainPerMin, 10) : 0;
  let proc;
  try {
    proc = spawn(findNodeExe(), [script, '--noFarm=true', `--bankFile=${bankFile()}`,
      `--poolSize=${poolSize}`, `--cookieTtlMs=${cookieTtlSec * 1000}`,
      `--maxDrainPerMin=${maxDrainPerMin}`], { cwd: botDir, stdio: ['pipe', 'pipe', 'pipe'], env, ...plat.spawnOpts() });
    farmerProc = proc;
    brokerOnly = true;
    // A replacement broker starts with only its legacy CLI cap. Republish the live/standby demand
    // once it begins listening; the retry loop covers the short spawn-to-listen gap.
    proc.once('spawn', () => {
      lastTargetCookieDemandKey = '';
      setTimeout(syncTargetCookieBankDemand, 150);
    });
  } catch (e) { log('harvester broker spawn failed: ' + e.message); return; }

  // Farmer chatter is debug-level: in quiet mode only failures get through (see KEEP_IN_QUIET).
  const relay = (chunk) => String(chunk).split(/\r?\n/).forEach((l) => {
    const t = l.trim();
    if (t && (verboseLogs() || KEEP_IN_QUIET.test(t))) log(t);
  });
  proc.stdout.on('data', relay);
  proc.stderr.on('data', relay);
  // Only clear the handle if it still refers to THIS process. The old unconditional version was
  // how the app lost track of a live broker: kill the farmer, spawn a broker, and the dead farmer's
  // exit event — which arrives whenever the OS gets round to it — would null the handle to the NEW
  // broker. Nothing then knew that process existed, so nothing ever killed it, and it held :4727
  // for the rest of the session ("port 4727 still in use — another bot holding it?").
  proc.on('exit', () => {
    if (farmerProc === proc) { farmerProc = null; brokerOnly = false; lastTargetCookieDemandKey = ''; }
    if (!quitting && managedHarvesterMode()) setTimeout(ensureHarvesterBroker, 1000);
  });
  log(`[target] harvester broker listening on 127.0.0.1:${SHAPE_PORT} — authenticated extension bridge is ready`);
}

// ── reclaiming :4727 ─────────────────────────────────────────────────────────────
// The broker port is fixed by the native engine contract and the main-process compatibility
// bridge. Instead of fleeing a squatted port we take it back — but ONLY from our own orphan,
// identified by a live protocol handshake, never by process name.
//
// This matters most for the upgrade itself: the fixes above stop NEW orphans, but every machine
// that ran an earlier build already has a farmer left over from the last clean exit. Without this,
// the first launch of the fixed build still says "port 4727 still in use" and still sends the user
// to Task Manager — the exact outcome all of this exists to prevent.

// GET /status. Non-null means SOMETHING answered; null means nothing is listening (or it is not
// speaking HTTP), which is the normal free-port case.
function probeBroker(cb) {
  const req = http.get({ host: '127.0.0.1', port: SHAPE_PORT, path: '/status', timeout: 1200 }, (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => { try { cb(JSON.parse(body)); } catch { cb(null); } });
  });
  req.on('error', () => cb(null));
  req.on('timeout', () => { req.destroy(); cb(null); });
}

// A cold account initially farms login with one safe lane. Once the
// engine persists its new account session, unlock the staggered ATC lanes in the native farmer.
function signalFarmerSessionReady() {
  const req = http.request({
    host: '127.0.0.1', port: SHAPE_PORT, path: '/session-ready', method: 'POST', timeout: 1200,
    headers: { 'x-zyn-token': SHAPE_TOKEN },
  }, (res) => res.resume());
  req.on('error', (e) => vlog('[target] shape farmer session-ready signal failed: ' + e.message));
  req.on('timeout', () => req.destroy());
  req.end();
}

// Two acceptable proofs. `app` is the explicit marker current builds send; the legacy branch
// recognises pre-marker brokers by the exact /status shape only our farmer produces, because those
// are precisely the orphans this needs to clear.
function isOurBroker(j) {
  if (!j || typeof j !== 'object') return false;
  if (j.app === 'zyn-shape-broker') return true;
  return j.ok === true && j.pools && typeof j.pools.login === 'number' && typeof j.pools.atc === 'number';
}

// PID owning the LISTENING socket on 127.0.0.1:<port>. Matched on the address columns rather than
// the state word, because "LISTENING" is localised on non-English Windows while "0.0.0.0:0" as the
// foreign address (which only a listening socket has) is not.
const listenerPid = plat.listenerPid;
const imageNameOf = plat.imageNameOf;

// Calls cb() when the port is ours to use — either free, or reclaimed. Calls cb(false) when a
// FOREIGN program holds it, which we must never kill.
function reclaimBrokerPort(cb) {
  probeBroker((j) => {
    if (!j) return cb(true);                       // nothing listening (or not ours to talk to)
    if (!isOurBroker(j)) {
      log(`[target] port ${SHAPE_PORT} is held by another program — close it and press Start again`);
      return cb(false);                            // the ONLY hard refusal: never touch a stranger
    }

    // It is one of ours. The question is whether anything is still tracking it.
    //
    // farmerProc is the app's handle. If it is set, the caller owns the lifecycle (startFarmer kills
    // a broker-only process itself) and we must not interfere. If it is NULL, this broker is
    // UNTRACKED — left by a previous app run, or one this session lost the handle to — and nothing
    // will ever kill it. That was the dead end: the app could see the process was its own child,
    // knew it was a broker, and still sat there logging "port 4727 still in use" forever.
    if (farmerProc) return cb(true);

    const pid = listenerPid(SHAPE_PORT);
    if (!pid) { log(`[target] port ${SHAPE_PORT} busy but its owner could not be resolved`); return cb(true); }
    const image = imageNameOf(pid);
    if (!plat.isNodeImage(image) && image !== 'zyn') { // native packaged farmer reuses Zyn in Node mode
      log(`[target] port ${SHAPE_PORT} held by ${image || 'an unknown process'} — leaving it alone`);
      return cb(false);
    }
    try {
      plat.killPid(pid);
      log('[target] cleared an untracked cookie broker');
    } catch (e) {
      // Usually just "process not found" because it was already on its way out. Not a reason to
      // abandon the start — whenPortFree is the real arbiter of whether the port came free.
      vlog('[target] broker cleanup: ' + e.message);
    }
    cb(true);
  });
}

// Resolves once nothing is listening on `port`, or after `tries` attempts. killTree only SIGNALS
// the child — the OS keeps its listening socket for a moment afterwards — so "have we killed it"
// and "is the port actually free" are different questions, and only the second one matters before
// binding. Probed by attempting a real bind rather than guessing with a fixed sleep.
function whenPortFree(port, cb, tries = 12) {
  const probe = net.createServer();
  probe.once('error', () => {
    if (tries <= 0) return cb(false);
    setTimeout(() => whenPortFree(port, cb, tries - 1), 250);
  });
  probe.once('listening', () => probe.close(() => cb(true)));
  probe.listen(port, '127.0.0.1');
}

function startFarmer(config) {
  if (!targetHarvestAuthorized) return;
  // A broker-only process can't farm, so replace it when a task needs real in-bot harvesting.
  // This applies in Harvester mode too: in-bot farming is ALWAYS the primary source and the
  // extension is a supplement, so a broker-only process must never survive into a running task.
  if (farmerProc && brokerOnly) {
    const pid = farmerProc.pid;
    killTree(farmerProc);
    farmerProc = null;
    brokerOnly = false;
    sweepOrphanHarvesters(pid);
  }
  if (farmerProc) return;
  sweepStaleHarvestersOnStart();
  // Hold it instead of discarding it. The chain below can take seconds (probe, netstat, taskkill,
  // then up to 3s of bind retries), and a start landing inside that window used to be thrown away.
  if (farmerPending) { farmerWanted = config; return; }

  // Wait for :4727 UNCONDITIONALLY, not just when replacing a broker we can see. stopTarget kills
  // the farmer and clears farmerProc immediately, so a start right after a stop found farmerProc
  // null, skipped the wait entirely, and spawned into the socket the dying process still held —
  // "broker error: EADDRINUSE" / "shape farmer exited (code 1)". Whether we still hold a handle to
  // the old process says nothing about whether the OS has released its port.
  // Snapshot the run generation: the port chain below can take seconds (probe, netstat, taskkill,
  // then up to 3s of bind retries), and a Stop pressed inside that window used to spawn a headful
  // farmer anyway — real browser windows and a real account login after the user stopped everything.
  // killTree in stopTarget cannot help, because nothing has spawned yet for it to kill.
  const seq = startSeq;
  farmerPending = true;
  reclaimBrokerPort((mine) => {
    if (quitting || !targetHarvestAuthorized || seq !== startSeq) { farmerChainDone(); return; }
    if (!mine) {
      // A port held by someone else's program will not come free on a retry, so drop the queued
      // request too rather than spinning on it.
      farmerPending = false; farmerWanted = null;
      // Say it on the cards, not just in the log — a grey log line is invisible to a user whose
      // tasks are about to sit on "Starting" with no cookies.
      for (const id of runningTaskIds) {
        status('Error', '#fb5454', `port ${SHAPE_PORT} is used by another program`, id);
      }
      return;
    }
    whenPortFree(SHAPE_PORT, (free) => {
      // Hand off before returning, or a start queued behind this one is lost with it.
      if (quitting || !targetHarvestAuthorized || seq !== startSeq) { farmerChainDone(); return; }   // stopped (or quit) while we waited
      farmerPending = false;
      if (!free) { farmerWanted = null; log(`shape farmer: port ${SHAPE_PORT} still in use — not starting (another bot holding it?)`); return; }
      if (farmerProc) { farmerWanted = null; return; }   // something claimed it while we waited
      farmerWanted = null;
      spawnFarmer(config);
    });
  });
}

function spawnFarmer(config) {
  if (!targetHarvestAuthorized) return;
  const botDir = botDirPath();
  const script = path.join(botDir, 'shape-farmer.mjs');
  if (!fs.existsSync(script)) { log('shape farmer missing: ' + script); return; }

  // The farmer needs the pool in the clear, and it is a separate process, so it goes to a file. That
  // file is the ONLY plaintext copy of an in-house pool that ever touches a user's disk — it used to be
  // written and then left there forever, so every run added another readable copy of every credential
  // (85 had accumulated on one machine over four days). Three things now bound the exposure: stale
  // copies from earlier runs are swept first, the file is created 0600, and the farmer unlinks it the
  // instant it has parsed it. The sweep is what cleans up existing installs without asking anyone.
  sweepStaleProxyFiles();
  let proxyFile = '';
  try {
    const lines = proxyLinesFor(config.proxyListName);
    proxyFile = path.join(os.tmpdir(), `shape-proxies-${Date.now()}.txt`);
    fs.writeFileSync(proxyFile, lines.join('\n'), { encoding: 'utf8', mode: 0o600 });
  } catch (e) { log('farmer proxy file error: ' + e.message); }

  const env = nodeEnvironment({ FORCE_COLOR: '0', ZYN_SHAPE_PORT: String(SHAPE_PORT), ZYN_SHAPE_TOKEN: SHAPE_TOKEN,
    // The farmer watches its stdin for EOF and exits when it closes — the only parent-death
    // signal that survives a crash or an End Task, neither of which runs a quit handler.
    ZYN_PARENT_WATCH: '1', ZYN_OWNER_PID: String(process.pid), ZYN_ENGINE_PATH: enginePath() });

  // Pass the task's account creds via env (never argv — argv is world-readable in the process list).
  // The farmer does a real email+password login so it captures the credential_validations request's
  // Shape headers — the exact endpoint/context the engine replays (a dummy email only fires the
  // wrong passwordless request and gets a 401 Shape Block).
  let hasSession = false;
  let accountEmail = '';
  try {
    const creds = config.accountId ? dm.getAccountCreds(config.accountId) : null;
    if (creds) {
      accountEmail = creds.email || '';
      env.SHAPE_ACCT_EMAIL = accountEmail;
      env.SHAPE_ACCT_PASS = creds.password || '';
      hasSession = !!creds.cookie;
    }
  } catch {}

  // Match the farmer's harvest to the engine's login path: OTP → capture secure_codes ("Get a code"),
  // password → capture credential_validations ("Enter your password").
  const loginMode = otpEnabled(config.profileId, accountEmail) ? 'otp' : 'password';
  vlog('[target] login mode: ' + loginMode + (loginMode === 'otp' ? ' (IMAP configured)' : ' (no IMAP — password fallback)'));

  // With a saved session the engine goes straight to refresh-login and only ever asks for atc
  // cookies — pre-warming login cookies would just burn proxies and OTP menu hits. The farmer still
  // harvests login on demand if the engine actually asks (i.e. the saved session turned out stale).
  const types = hasSession ? 'atc' : 'login,atc';
  vlog('[target] session ' + (hasSession ? 'restored — farming ATC cookies only' : 'not saved — farming login + ATC cookies'));

  // ATC harvesting has to CLICK add-to-cart, so it needs an in-stock product. The task's own TCIN
  // is out of stock right up until the drop, which would leave us with zero ATC cookies at exactly
  // the wrong moment. Harvest from a stable in-stock item instead (Shape signs the endpoint, not the
  // product). Overridable in Settings as targetAtcHarvestTcin.
  // Comma-separated TCINs or full product URLs, rotated per harvest. Multiple entries matter:
  // hammering one product from one IP is a pattern, and a single item going out of stock mid-drop
  // would silently stop ATC production.
  // Products the harvester rotates through to farm ATC cookies. The farmer opens each product page
  // and lets Shape sign a cart_items request, but that request is STUBBED (route.fulfill) so Target
  // never receives it — nothing is really added to a cart and the single-use nonce stays fresh for
  // the engine's one replay. What matters is therefore not stock depth but that the page LOADS and
  // renders a working Add-to-Cart, which is why the retired 1005151150 broke harvesting.
  //
  // shape-farmer.mjs advances to the next entry on EVERY attempt, success or failure, so a wide list
  // means no single product page is hit repeatedly from one IP — and one item going dead can no
  // longer stall the pool, it just gets skipped on the next pass. Bare TCINs or full Target URLs
  // both work. Override in Settings with targetAtcHarvestTcins.
  // Trading-card boxes, matching the category actually being dropped. Duplicates from the source
  // list were removed — a repeated TCIN only wastes rotation slots on a page already visited.
  //
  // CAVEAT worth knowing if farming stalls: these sell out far more often than the general
  // merchandise this list replaced. An out-of-stock page renders NO add-to-cart, so Shape has
  // nothing to sign and that pass logs "cart_items never fired after clicks". Rotation means a dead
  // entry is skipped rather than fatal, but if too many go out at once the pool starves — mix in a
  // couple of cheap always-stocked items via Settings → targetAtcHarvestTcins if that happens.
  let atcTcins = [
    '95081084', '95225598', '95225596', '95081083', '94982545',
    '95051708', '1011960744', '94681699', '94681674', '94776406',
    '94860238', '94921087', '1011239459', '94336416', '1010649371',
    '1012199003', '1011904877', '1006295656', '1006088045', '95294439',
    '95027462', '95022215',
  ].join(',');
  let poolSize = 0;              // 0 = uncapped; the TTL is the only thing that expires a cookie
  // 0 = "one worker per detected browser". The farmer already defaults to BROWSERS.length, but this
  // used to pass a hardcoded 3, which silently OVERRODE it: after Brave was added the farmer detected
  // four browsers and still started three workers, so round-robin never reached index 3 and bundled
  // Chromium stopped being used at all. Adding a browser quietly removed one.
  //
  // Leaving it 0 means installing a fork is all it takes to put that fork to work.
  let workers = 0;
  // Collect conservatively by default, but let operators amortise a
  // Chromium launch across fresh contexts and opt into multiple signatures from one page.
  let capturesPerLoad = 1;
  let loadsPerBrowser = 3;
  // Abort bulk assets through the harvest proxy. Shape's documents, stylesheets, scripts and XHR
  // remain available; the UI can disable this immediately if live yield ever regresses.
  let blockHeavyResources = true;
  // How long a banked Shape cookie stays usable. Ours to choose, not Target's — nothing tells us when
  // Shape stops honouring a header, so this is a bet in both directions: too low discards cookies
  // that would still have worked, too high replays dead ones and each of those is a 401 that burns
  // the task's attempt. Seconds here, milliseconds on the wire.
  let cookieTtlSec = 600;
  // 0 = unlimited, which is what shipped before this existed. Caps how fast a BANKED reserve can be
  // drained; a cookie handed straight to a waiting task is never paced, so a live drop is unaffected.
  let maxDrainPerMin = 0;
  try {
    const s = dm.getSettings() || {};
    atcTcins = (s.targetAtcHarvestTcins || s.targetAtcHarvestTcin || '').trim() || atcTcins;
    poolSize = parseInt(s.targetCookieBank, 10) > 0 ? parseInt(s.targetCookieBank, 10) : poolSize;
    workers = parseInt(s.targetHarvestWorkers, 10) > 0 ? parseInt(s.targetHarvestWorkers, 10) : workers;
    cookieTtlSec = parseInt(s.targetCookieTtlSec, 10) > 0 ? parseInt(s.targetCookieTtlSec, 10) : cookieTtlSec;
    const configuredCaptures = parseInt(s.targetCapturesPerLoad, 10);
    capturesPerLoad = Number.isFinite(configuredCaptures)
      ? Math.max(1, Math.min(10, configuredCaptures)) : capturesPerLoad;
    const configuredLoads = parseInt(s.targetLoadsPerBrowser, 10);
    loadsPerBrowser = Number.isFinite(configuredLoads)
      ? Math.max(1, Math.min(10, configuredLoads)) : loadsPerBrowser;
    if (s.targetBlockHeavyResources === false || s.targetBlockHeavyResources === 'false') {
      blockHeavyResources = false;
    } else if (s.targetBlockHeavyResources === true || s.targetBlockHeavyResources === 'true') {
      blockHeavyResources = true;
    }
    maxDrainPerMin = parseInt(s.targetCookieDrainPerMin, 10) > 0 ? parseInt(s.targetCookieDrainPerMin, 10) : 0;
  } catch {}

  // Shape Method = Harvester adds external Chrome as a cookie source; it does not replace in-bot
  // farming. Chrome talks only to the filtered port-4312 bridge, which authenticates accepted saves
  // to this process, so both sources feed the same bank without exposing the broker token.
  //
  // This used to pass --noFarm=true here, which disabled the built-in farmer outright. Combined with
  // startFarmer()'s early `if (farmerProc) return`, selecting Harvester meant in-bot farming could
  // never run at all — a task just sat on "Waiting For Shape (atc cookie)" until the extension
  // happened to bank one, and forever if it never did. In-bot is the primary source; the extension
  // is the fallback.
  const harvesterMode = shapeMethodSetting() === 'Harvester';
  if (harvesterMode) vlog(`[target] Shape Method: Harvester — in-bot farming ON, external Chrome bridge on 127.0.0.1:4312`);

  vlog('[target] cookie bank: ' + (poolSize > 0 ? poolSize + ' per type' : 'uncapped') + ', ' + (workers > 0 ? workers : 'auto')
    + ' worker(s), ttl ' + cookieTtlSec + 's, harvesting ATC from ' + atcTcins.split(',').length + ' product(s)');
  vlog(`[target] farmer throughput: up to ${capturesPerLoad} cookie(s) per page load, random 1–${loadsPerBrowser} page load(s) per browser launch, heavy assets ${blockHeavyResources ? 'blocked (images/media/fonts)' : 'allowed'}`);
  // Whether capped or not, the bank settles at (harvests/min x TTL) -- a cap only decides whether
  // workers idle once they reach it. Measured 2026-08-01: 3 workers produced ~2.9/min, so ~29 on a
  // 10-minute TTL, which is where it sat all run.
  //
  // The old estimate assumed ~40s per harvest (1.5/min/worker) and predicted 45. Real throughput was
  // ~62s per harvest, so the figure below is built from ~1 per worker per minute instead -- an
  // estimate that over-promises is worse than none, because it makes a healthy farmer look broken.
  const perWorkerPerMin = 1;
  // `workers` is 0 when it means "one per browser", and the farmer picks the real number after it
  // detects them. Assume the common Windows set (chrome, msedge, brave, chromium) for this estimate
  // rather than printing 0 — the farmer's own "started N farmer worker(s)" line is authoritative.
  const workersForEstimate = workers > 0 ? workers : 4;
  const settlesNear = Math.floor(workersForEstimate * perWorkerPerMin * (cookieTtlSec / 60));
  vlog(`[target] note: ${workersForEstimate} worker(s) settle near ${settlesNear} cookies at a ${cookieTtlSec}s ttl`
    + `${poolSize > 0 && poolSize < settlesNear ? ` — but the ${poolSize} cap will hold it lower` : ''}`
    + '. More workers or a longer ttl raise it; the cap cannot.');

  const args = [script, `--proxyFile=${proxyFile}`, `--tcin=${(config.sku || '').trim()}`,
    `--atcTcins=${atcTcins}`, `--poolSize=${poolSize}`, ...(workers > 0 ? [`--workers=${workers}`] : []),
    `--capturesPerLoad=${capturesPerLoad}`, `--loadsPerBrowser=${loadsPerBrowser}`,
    `--blockHeavyResources=${blockHeavyResources}`, `--browsers=auto`,
    `--sessionReady=${hasSession}`,
    // --diag was pinned on, so every user saw the farmer's internal step commentary — persona hardware,
    // the drawn warm-up routine, screenshot paths. That is tuning output, not operator output. It now
    // follows the same Verbose Target logs switch as everything else: off for normal use, on when
    // someone is actually debugging a harvest.
    '--headless=true', `--diag=${verboseLogs()}`, `--loginMode=${loginMode}`, `--types=${types}`,
    `--maxDrainPerMin=${maxDrainPerMin}`,
    `--bankFile=${bankFile()}`, `--cookieTtlMs=${cookieTtlSec * 1000}`];
  let proc;
  try {
    proc = spawn(findNodeExe(), args, { cwd: botDir, stdio: ['pipe', 'pipe', 'pipe'], env, ...plat.spawnOpts() });
    farmerProc = proc;
    brokerOnly = false;
  } catch (e) { log('shape farmer spawn failed: ' + e.message); return; }
  // Farmer chatter is debug-level: in quiet mode only failures get through (see KEEP_IN_QUIET).
  const relay = (chunk) => String(chunk).split(/\r?\n/).forEach((l) => {
    const t = l.trim();
    if (t && (verboseLogs() || KEEP_IN_QUIET.test(t))) log(t);
  });
  proc.stdout.on('data', relay);
  proc.stderr.on('data', relay);
  proc.on('error', (e) => log('shape farmer error: ' + e.message));
  // Same stale-handle guard as the broker above.
  proc.on('exit', (code) => {
    if (farmerProc === proc) { farmerProc = null; brokerOnly = false; }
    log('shape farmer exited (code ' + code + ')');
  });
  vlog(`shape farmer starting — harvesting Shape cookies on 127.0.0.1:${SHAPE_PORT}`);
  // Confirm the broker actually came up, and say so plainly if it did not.
  //
  // Without this the only evidence is the ENGINE's side of it: hundreds of "connection refused" on
  // :4727 a second, which reads like an engine bug and says nothing about why the cookie source is
  // missing. Some of those are unavoidable and harmless — the engine is spawned right after this and
  // dials immediately, while the farmer still has to start Node and bind — so the useful signal is
  // not "were there refusals" but "did the broker ever come up at all".
  let waited = 0;
  const probe = setInterval(() => {
    if (farmerProc !== proc) { clearInterval(probe); return; }   // replaced or stopped; not our problem
    waited += 1000;
    const req = http.get({ host: '127.0.0.1', port: SHAPE_PORT, path: '/status', timeout: 800 }, (res) => {
      res.resume();
      clearInterval(probe);
      log(`[target] cookie broker ready on 127.0.0.1:${SHAPE_PORT} (${(waited / 1000).toFixed(0)}s)`);
    });
    req.on('error', () => {
      if (waited < 25000) return;                                 // still starting; keep waiting
      clearInterval(probe);
      log(`[target] cookie broker never came up on ${SHAPE_PORT} — tasks will get no Shape cookies. `
        + `The farmer process is ${farmerProc === proc ? 'still running' : 'gone'}; check the lines above for why.`);
    });
    req.on('timeout', () => req.destroy());
  }, 1000);
  probe.unref?.();
}

function harvesterProxyLines(config) {
  return resolveAssignment(config.proxyListName).sources.flatMap(source => source.lines)
    .filter(line => parseProxyLine(line));
}

function harvesterFingerprint(config) {
  let proxyState = 'local';
  if (config.proxyListName) {
    try {
      const lines = harvesterProxyLines(config);
      proxyState = lines.length
        ? `${lines.length}:${crypto.createHash('sha256').update(lines.join('\n')).digest('hex')}`
        : 'unavailable';
    } catch { proxyState = 'unavailable'; }
  }
  return JSON.stringify({ config, proxyState });
}

function stopHarvesterProducer(id) {
  const entry = harvesterProcs.get(id);
  if (!entry) return;
  harvesterProcs.delete(id);
  try { killTree(entry.proc); } catch {}
}

function spawnHarvesterProducer(config) {
  const botDir = botDirPath();
  const script = path.join(botDir, 'shape-farmer.mjs');
  if (!fs.existsSync(script)) { log('shape farmer missing: ' + script); return; }

  sweepStaleProxyFiles();
  let proxyFile = '';
  try {
    const lines = taggedHarvesterLines(config.proxyListName);
    // A named proxy route is an instruction, not a preference. If its list was deleted, renamed,
    // emptied, or failed to decrypt, never turn a metered-proxy harvester into a home-IP harvester.
    if (config.proxyListName && !lines.length) {
      const failureKey = `proxy:${config.proxyListName}`;
      if (harvesterStartFailures.get(config.id) !== failureKey) {
        log(`[target] harvester ${config.name} not started — proxy group ${displayProxyGroup(config.proxyListName)} is unavailable or empty`);
        harvesterStartFailures.set(config.id, failureKey);
      }
      return;
    }
    harvesterStartFailures.delete(config.id);
    proxyFile = path.join(os.tmpdir(), `shape-proxies-${Date.now()}${Math.floor(Math.random() * 1000)}.txt`);
    fs.writeFileSync(proxyFile, lines.join('\n'), { encoding: 'utf8', mode: 0o600 });
  } catch (e) {
    const failureKey = `proxy-error:${e.message}`;
    if (harvesterStartFailures.get(config.id) !== failureKey) {
      log(`harvester ${config.name} proxy file error: ${e.message}`);
      harvesterStartFailures.set(config.id, failureKey);
    }
    if (config.proxyListName) return;
  }

  let settings = {};
  try { settings = dm.getSettings() || {}; } catch {}

  // Optional operator-set harvest data directory (e.g. a RAM disk or a second NVMe). Each managed
  // harvester launches a non-persistent Playwright browser, so every worker's profile + Chromium
  // disk cache lands in a fresh dir under os.tmpdir(). Point the child's os.tmpdir() at the
  // configured path via TEMP/TMP/TMPDIR so the small-synchronous-write storm from many Chromium
  // sessions (SQLite cookie/cache writes) never touches the OS drive. Falls back to the default
  // temp on any error so a bad path can never stop harvesting.
  const harvestDataRoot = String(settings.targetHarvestDataDir || '').trim();
  const dataDirEnv = {};
  if (harvestDataRoot) {
    try {
      const dir = path.join(harvestDataRoot, `zyn-harvest-${config.id}`);
      fs.mkdirSync(dir, { recursive: true });
      dataDirEnv.TMPDIR = dir; dataDirEnv.TEMP = dir; dataDirEnv.TMP = dir;
    } catch (e) {
      log(`harvester ${config.name} data dir unusable (${harvestDataRoot}): ${e.message} — using default temp`);
    }
  }

  const env = nodeEnvironment({ FORCE_COLOR: '0', ZYN_SHAPE_PORT: String(SHAPE_PORT), ZYN_SHAPE_TOKEN: SHAPE_TOKEN,
    // The farmer watches its stdin for EOF and exits when it closes — the only parent-death
    // signal that survives a crash or an End Task, neither of which runs a quit handler.
    ZYN_PARENT_WATCH: '1', ZYN_OWNER_PID: String(process.pid), ZYN_ENGINE_PATH: enginePath(), ...dataDirEnv });

  const builtInTargets = String(settings.targetAtcHarvestTcins || settings.targetAtcHarvestTcin || '').trim();
  const defaultTargets = [
    '95081084', '95225598', '95225596', '95081083', '94982545',
    '95051708', '1011960744', '94681699', '94681674', '94776406',
    '94860238', '94921087', '1011239459', '94336416', '1010649371',
    '1012199003', '1011904877', '1006295656', '1006088045', '95294439',
    '95027462', '95022215',
  ].join(',');
  const atcTcins = String(config.input || '').split(/[\s,]+/).filter(Boolean).join(',') || builtInTargets || defaultTargets;
  const poolSize = parseInt(settings.targetCookieBank, 10) > 0 ? parseInt(settings.targetCookieBank, 10) : 0;
  const capturesPerLoad = Math.max(1, Math.min(10, parseInt(settings.targetCapturesPerLoad, 10) || 1));
  const loadsPerBrowser = Math.max(1, Math.min(10, parseInt(config.loadsPerBrowser, 10)
    || parseInt(settings.targetLoadsPerBrowser, 10) || 3));
  const blockHeavyResources = settings.targetBlockHeavyResources !== false && settings.targetBlockHeavyResources !== 'false';
  const types = config.type === 'auto' ? 'login,atc' : config.type;
  const engine = String(config.engine || '').toLowerCase() === 'patchright' ? 'patchright' : 'playwright';
  const headed = engine === 'patchright';
  const profileRoot = headed
    ? (userDataDir('shape-patchright') ? path.join(userDataDir('shape-patchright'), String(config.id))
      : path.join(os.tmpdir(), 'zyn-shape-patchright', String(config.id)))
    : '';
  const args = [script,
    '--producer=true',
    `--harvesterId=${config.id}`,
    `--harvesterName=${config.name}`,
    `--harvesterType=${config.type}`,
    `--engine=${engine}`,
    `--atcMode=${config.atcMode}`,
    `--routeLabel=${displayProxyGroup(config.proxyListName)}`,
    `--proxyFile=${proxyFile}`,
    `--atcTcins=${atcTcins}`,
    `--poolSize=${poolSize}`,
    `--workers=${config.workers}`,
    `--capturesPerLoad=${capturesPerLoad}`,
    `--loadsPerBrowser=${loadsPerBrowser}`,
    `--blockHeavyResources=${blockHeavyResources}`,
    `--browsers=${config.browser}`,
    `--types=${types}`,
    '--sessionReady=false',
    '--loginMode=password',
    `--headless=${headed ? 'false' : 'true'}`,
    '--offscreen=true',
    ...(profileRoot ? [`--profileRoot=${profileRoot}`] : []),
    `--diag=${verboseLogs()}`,
    `--intervalDelayMs=${config.intervalDelaySec * 1000}`,
    `--cookieTtlMs=${config.cookieTtlSec * 1000}`,
  ];

  let proc;
  try {
    proc = spawn(findNodeExe(), args, { cwd: botDir, stdio: ['pipe', 'pipe', 'pipe'], env, ...plat.spawnOpts() });
  } catch (e) { log(`harvester ${config.name} spawn failed: ${e.message}`); return; }

  const fingerprint = harvesterFingerprint(config);
  harvesterProcs.set(config.id, { proc, fingerprint });
  const relay = (chunk) => String(chunk).split(/\r?\n/).forEach((line) => {
    const text = line.trim();
    if (text && (verboseLogs() || KEEP_IN_QUIET.test(text))) log(`[${config.name}] ${text}`);
  });
  proc.stdout.on('data', relay);
  proc.stderr.on('data', relay);
  proc.on('error', error => log(`harvester ${config.name} error: ${error.message}`));
  proc.on('exit', (code) => {
    const current = harvesterProcs.get(config.id);
    if (current && current.proc === proc) harvesterProcs.delete(config.id);
    log(`harvester ${config.name} exited (code ${code})`);
    if (!quitting) setTimeout(ensureHarvesterBroker, 1000);
  });
  const mode = config.type === 'login' ? '' : config.atcMode === 'v2' ? ' ATC+' : ' ATC';
  log(`[target] harvester ${config.name} starting — ${config.type}${mode}, ${headed ? 'headed' : 'headless'}, ${config.workers} worker(s), ${displayProxyGroup(config.proxyListName)}`);
}

function syncHarvesterProducers(configs = managedHarvesterConfigs() || []) {
  const active = configs.filter(config => harvesterScheduleActive(config));
  const wanted = new Map(active.map(config => [config.id, config]));
  for (const id of [...harvesterStartFailures.keys()]) {
    if (!wanted.has(id)) harvesterStartFailures.delete(id);
  }
  for (const [id, entry] of harvesterProcs) {
    const config = wanted.get(id);
    if (!config || entry.fingerprint !== harvesterFingerprint(config)) stopHarvesterProducer(id);
  }
  for (const config of active) {
    if (!harvesterProcs.has(config.id)) spawnHarvesterProducer(config);
  }
}

function armHarvesterScheduleSync() {
  if (harvesterSyncTimer) return;
  harvesterSyncTimer = setInterval(() => {
    if (quitting) return;
    if (!managedHarvesterMode()) {
      clearInterval(harvesterSyncTimer);
      harvesterSyncTimer = null;
      return;
    }
    ensureHarvesterBroker();
  }, 15000);
  harvesterSyncTimer.unref?.();
}

function syncTargetHarvesters(mainWindow, runCommand = null) {
  if (mainWindow) attachWindow(mainWindow);
  // Reconciliation alone never grants permission to start. Only the renderer's explicit Start or
  // Stop action sends a validated command; all other callers merely apply configuration changes to
  // harvesters already authorized during this app session. The login harvester is the exception:
  // checkout demand arms it, never a Start click.
  if (runCommand && typeof runCommand === 'object') setManagedHarvesterRunning(runCommand);
  ensureHarvesterBroker();
  syncTargetCookieBankDemand();
  scheduleLoginHarvesterReconcile();
  return true;
}

// ── config translation: data-manager shapes -> engine JSON ───────────────────────
function normalizeCountry(c) {
  const s = String(c || '').trim();
  if (!s) return 'US';
  if (/^united states$|^usa$|^us$/i.test(s)) return 'US';
  return s;
}

function buildProfileMap(profileId, accountId) {
  const p = (dm.getProfiles() || []).find(x => String(x.id) === String(profileId));
  if (!p) return {};
  const s = p.shipping || {};
  const b = p.billingSameShipping === false ? (p.billing || {}) : s;
  const pay = p.payment || {};
  const country = normalizeCountry(s.country);
  const first = s.firstName || '';
  const last = s.lastName || '';
  const zip = s.zipcode || s.zip || '';
  const state = normalizeState(s.state);
  const billingCountry = normalizeCountry(b.country);
  const billingFirst = b.firstName || '';
  const billingLast = b.lastName || '';
  const billingZip = b.zipcode || b.zip || '';
  const billingState = normalizeState(b.state);
  const prof = {
    id: String(p.id),
    profileGroup: p.group || (Array.isArray(p.groups) ? p.groups[0] : '') || '',
    profileName: p.profileName || p.email || 'profile',
    email: p.email || '',
    phone: p.phone || '',
    shippingFirstName: first, shippingLastName: last,
    shippingAddress1: s.address || '', shippingAddress2: s.address2 || '',
    shippingCity: s.city || '', shippingState: state, shippingZip: zip, shippingCountry: country,
    billingFirstName: billingFirst, billingLastName: billingLast,
    billingAddress1: b.address || '', billingAddress2: b.address2 || '',
    billingCity: b.city || '', billingState, billingZip, billingCountry,
    cardName: pay.cardName || `${first} ${last}`.trim(),
    cardNumber: String(pay.cardNumber || '').replace(/\s+/g, ''),
    cardExpiryMonth: String(pay.cardMonth || '').padStart(2, '0'),
    // The engine builds the year as "20"+value (request.go SubmitPayment), so it wants 2 digits.
    // Profiles store 4 ("2027"), which produced "202027" → 400 "Invalid expiry year". slice(-2)
    // normalizes either form.
    cardExpiryYear: String(pay.cardYear || '').slice(-2),
    cardCvv: pay.cardCvv || '',
    account: accountId ? String(accountId) : '',
  };
  return { [String(p.id)]: prof };
}

// Account password is decrypted in main only at this moment (never written to disk,
// never sent to the renderer) and handed to the engine over the loopback socket.
function buildAccountMap(accountId) {
  if (!accountId) return {};
  const creds = dm.getAccountCreds(accountId);
  if (!creds) return {};
  return {
    [String(accountId)]: {
      id: String(accountId),
      accountGroup: '',
      type: 'target',
      username: creds.email || '',
      password: creds.password || '',
      cookie: creds.cookie || '',   // saved session — engine refreshes instead of full OTP login
    },
  };
}

function parseProxyLine(line) {
  // host:port  |  host:port:user:pass
  const parts = String(line).split(':');
  if (parts.length < 2) return null;
  return { address: parts[0], port: parts[1], username: parts[2] || '', password: parts[3] || '' };
}

// One place that resolves a group name to raw proxy lines, so the engine's proxy map and the Shape
// farmer's --proxyFile can never disagree about what a group contains.
function proxyLinesFor(listName) {
  if (!listName) return [];
  return dm.getProxyLines(listName) || [];
}

function resolveAssignment(ref) {
  return resolveProxyAssignment(ref, {
    getProxyLines: name => {
      try { return dm.getProxyLines(name) || []; } catch { return []; }
    },
    getProxies: () => {
      try { return dm.getProxies() || { lists: [] }; } catch { return { lists: [] }; }
    },
  });
}

function groupOf(name) {
  return displayProxyGroup(name);
}

function sourceNamesFor(ref) {
  return resolveAssignment(ref).sources.map(source => source.name);
}

function cachedProxySources(taskId, proxyListName) {
  const existing = taskCheckoutConfigById.get(taskId) || {};
  if (Array.isArray(existing.proxySources)) return existing.proxySources;
  return sourceNamesFor(proxyListName);
}

function taggedHarvesterLines(ref) {
  return resolveAssignment(ref).sources.flatMap(source => (
    source.lines.map(line => `${source.name}\t${line}`)
  ));
}

function buildProxyMap(listName) {
  const map = {};
  for (const source of resolveAssignment(listName).sources) {
    const arr = source.lines.map(parseProxyLine).filter(Boolean);
    if (arr.length) map[source.name] = arr;
  }
  return map;
}

// ── engine messaging ─────────────────────────────────────────────────────────────
function sendToEngine(obj) {
  let envelope;
  try { envelope = engineContract.parseEnvelope(obj); }
  catch (e) { log('[target] invalid engine message: ' + e.message); return false; }
  try {
    if (engineConn && engineConn.readyState === WebSocket.OPEN) {
      engineConn.send(JSON.stringify(envelope));
      return true;
    }
  } catch (e) { log('engine send error: ' + e.message); }
  // A dropped message is invisible otherwise, and the two that matter here fail in ways that look
  // like something else entirely: a lost send-configs leaves every rotation reporting "invalid
  // group", and a lost start-tasks leaves cards sitting on "Starting" forever.
  log(`[target] engine not connected — dropped "${envelope.type}"`);
  return false;
}

// config is optional: called with no argument this re-sends everything already accumulated, which is
// what a reconnecting engine needs.
function sendConfigs(config = {}) {
  // Success and decline notifications are independently optional. The legacy discordWebhook key
  // remains the success destination so existing users keep their confirmed-order notifications;
  // declines never inherit it implicitly.
  let checkoutHook = '';
  let declineHook = '';
  try {
    const webhookSettings = dm.getSettings() || {};
    checkoutHook = String(webhookSettings.discordWebhook || '').trim();
    declineHook = String(webhookSettings.discordDeclineWebhook || '').trim();
  } catch {}
  const settings = JSON.stringify({
    webhooks: { checkout: checkoutHook, decline: declineHook },
    // Reported on Target's checkout webhook. Driven by the Settings value, not by whether a process
    // happens to be alive — the broker runs in both modes, so process state can't distinguish them.
    shapeMethod: shapeMethodSetting(),
    // Cloudflare captures the upstream solver key and forwards only this field. Settings.json
    // never stores it; the upstream license never reaches this process.
    lucaApiKey: solverLucaApiKey,
  });
  // Every task's account/profile/proxy group must be in ONE configs message — the engine keys off
  // these maps when it starts each task, so a task whose account is missing here silently never
  // logs in. Maps are merged across all tasks rather than sent per task.
  //
  // And merged across STARTS, not just tasks. The engine REPLACES each map wholesale
  // (proxy.SetProxies rebuilds state.groups from what it is handed), while a task keeps running
  // against the group name it launched with. So starting a second batch on a different proxy list —
  // or none — used to delete the group the first batch was still using, and those tasks then failed
  // every rotation with "invalid group" until they were stopped. Nothing recovered on its own: the
  // group only comes back if something sends it again.
  //
  // Accumulating means every group/profile/account we have ever sent is in every message, with the
  // newest content winning for a given name, so a re-send can add and update but never take away.
  const proxyMaps = new Map();
  for (const t of (config.tasks || [])) {
    Object.assign(sentConfigs.profiles, buildProfileMap(t.profileId, t.accountId));
    Object.assign(sentConfigs.accounts, buildAccountMap(t.accountId));
    const proxyKey = String(t.proxyListName || '');
    if (!proxyMaps.has(proxyKey)) proxyMaps.set(proxyKey, buildProxyMap(t.proxyListName));
    Object.assign(sentConfigs.proxies, proxyMaps.get(proxyKey));
  }
  const { profiles, accounts, proxies } = sentConfigs;
  // ConfigsStruct fields are STRINGS holding inner JSON (settings/profileList/proxyList/accountList).
  return sendToEngine({ type: 'send-configs', messages: [{
    settings,
    profileList: JSON.stringify(profiles),
    proxyList: JSON.stringify(proxies),
    accountList: JSON.stringify(accounts),
  }] });
}

let liveEditMonitorId = '';
let liveEditMonitorTimer = null;
let liveEditMonitorSequence = 0;
let liveEditStoppedMainMonitor = false;

// The checkout module owns one Target monitor. Additive starts update it to the union of every
// active task's watch list. Each restart gets a generation-specific ID so native stop/start
// goroutines cannot race on one reused key. One scan timer prevents an earlier batch stopping a
// later batch's initial scan.
const TARGET_MAIN_MONITOR_SYNC_MS = 100;
const TARGET_MAIN_MONITOR_SCAN_MS = 20000;
const TARGET_MAIN_MONITOR_RETRY_MS = 5000;
let targetMainMonitorRunning = false;
let targetMainMonitorId = '';
let targetMainMonitorSequence = 0;
let targetMainMonitorNeedsSync = false;
const targetMainMonitorPendingStopIds = new Set();
let targetMainMonitorSyncTimer = null;
let targetMainMonitorScanTimer = null;
let targetMainMonitorRetryTimer = null;

function clearTargetMainMonitorState() {
  if (targetMainMonitorSyncTimer) clearTimeout(targetMainMonitorSyncTimer);
  if (targetMainMonitorScanTimer) clearTimeout(targetMainMonitorScanTimer);
  if (targetMainMonitorRetryTimer) clearTimeout(targetMainMonitorRetryTimer);
  targetMainMonitorSyncTimer = null;
  targetMainMonitorScanTimer = null;
  targetMainMonitorRetryTimer = null;
  targetMainMonitorRunning = false;
  targetMainMonitorId = '';
  targetMainMonitorNeedsSync = false;
}

function queueTargetMainMonitorSync() {
  targetMainMonitorNeedsSync = true;
  if (targetMainMonitorRetryTimer || !runningTaskIds.size) return;
  targetMainMonitorRetryTimer = setTimeout(() => {
    targetMainMonitorRetryTimer = null;
    if (targetMainMonitorNeedsSync && runningTaskIds.size) reconcileTargetMainMonitor();
  }, TARGET_MAIN_MONITOR_RETRY_MS);
  if (targetMainMonitorRetryTimer && typeof targetMainMonitorRetryTimer.unref === 'function') targetMainMonitorRetryTimer.unref();
}

function sendPendingTargetMainMonitorStop() {
  if (!targetMainMonitorPendingStopIds.size || !engineConn) return false;
  return sendToEngine({
    type: 'stop-tasks', messages: [...targetMainMonitorPendingStopIds].map(id => ({ id })),
  });
}

function queueTargetMonitorStop(id) {
  const monitorId = String(id || '').trim();
  if (!monitorId) return false;
  targetMainMonitorPendingStopIds.add(monitorId);
  return sendPendingTargetMainMonitorStop();
}

function targetMainMonitorSpec() {
  const quantities = new Map();
  const maxPrices = new Map();
  let ignoreLowStock = false;
  let proxyGroup = 'Local';
  let proxySources = [];
  for (const id of runningTaskIds) {
    const config = taskCheckoutConfigById.get(id);
    if (!config) continue;
    if (proxyGroup === 'Local') {
      proxyGroup = groupOf(config.proxyListName);
      proxySources = Array.isArray(config.proxySources) && config.proxySources.length
        ? config.proxySources.slice()
        : sourceNamesFor(config.proxyListName);
    }
    const qty = Math.max(1, parseInt(config.qty, 10) || 1);
    ignoreLowStock = ignoreLowStock || config.ignoreLowStock === true;
    for (const rawSku of (config.skus || [])) {
      const sku = String(rawSku || '').trim();
      if (!sku) continue;
      const previous = quantities.get(sku);
      quantities.set(sku, previous == null ? qty : Math.min(previous, qty));
      const maxPrice = String((config.maxPriceBySku || {})[sku] || '').trim();
      if (maxPrice) maxPrices.set(sku, maxPrice);
    }
  }
  const items = [...quantities.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([monitorInput, quantity]) => ({ monitorInput, quantity: String(quantity), maxPrice: maxPrices.get(monitorInput) || '' }));
  return { items, proxyGroup, proxySources, ignoreLowStock };
}

function editTargetMainMonitor(spec, monitorId = targetMainMonitorId) {
  if (!monitorId) return false;
  const monitorItems = spec.items.map(item => ({
    id: item.monitorInput,
    monitorInput: item.monitorInput,
    quantity: item.quantity,
    color: '',
    sizes: [],
    maxPrice: item.maxPrice || '',
  }));
  return sendToEngine({
    type: 'edit-tasks',
    messages: [{
      id: monitorId,
      type: 'Target',
      site: 'Target',
      proxyGroup: spec.proxyGroup,
      proxySources: spec.proxySources || [],
      ignoreLowStock: spec.ignoreLowStock,
      item: monitorItems,
      monitorItems,
    }],
  });
}

function reconcileTargetMainMonitor() {
  const spec = targetMainMonitorSpec();
  if (!spec.items.length) {
    let stopped = true;
    if (targetMainMonitorRunning && targetMainMonitorId) {
      stopped = queueTargetMonitorStop(targetMainMonitorId);
    }
    clearTargetMainMonitorState();
    return stopped;
  }

  const wasRunning = targetMainMonitorRunning && !!targetMainMonitorId;
  // A post-scan live-edit worker belongs to the old monitor generation. Retire it before creating
  // a fresh main generation so additive starts never run two local Target monitors in parallel.
  if (!wasRunning && liveEditMonitorId) stopLiveEditMonitor();
  const monitorId = wasRunning
    ? targetMainMonitorId
    : MONITOR_ID + '-main-' + (++targetMainMonitorSequence);
  const sent = wasRunning
    ? editTargetMainMonitor(spec, monitorId)
    : sendToEngine({ type: 'start-monitors', messages: [{
      id: monitorId,
      site: 'Target',
      proxyGroup: spec.proxyGroup,
      proxySources: spec.proxySources || [],
      monitorDelay: '4000',
      ignoreLowStock: spec.ignoreLowStock,
      items: spec.items,
    }] });
  if (!sent) {
    queueTargetMainMonitorSync();
    return false;
  }
  targetMainMonitorRunning = true;
  targetMainMonitorId = monitorId;
  targetMainMonitorNeedsSync = false;
  if (targetMainMonitorRetryTimer) clearTimeout(targetMainMonitorRetryTimer);
  targetMainMonitorRetryTimer = null;

  // Native monitor startup is asynchronous. Re-send the latest union once registration has had a
  // chance to finish, covering an additive start that arrives in that narrow window.
  if (!wasRunning) {
    if (targetMainMonitorSyncTimer) clearTimeout(targetMainMonitorSyncTimer);
    targetMainMonitorSyncTimer = setTimeout(() => {
      targetMainMonitorSyncTimer = null;
      if (targetMainMonitorRunning && targetMainMonitorId === monitorId && engineConn) {
        if (!editTargetMainMonitor(targetMainMonitorSpec(), monitorId)) queueTargetMainMonitorSync();
      }
    }, TARGET_MAIN_MONITOR_SYNC_MS);
    if (targetMainMonitorSyncTimer && typeof targetMainMonitorSyncTimer.unref === 'function') targetMainMonitorSyncTimer.unref();
  }

  if (sharedMonitorOnly()) {
    if (targetMainMonitorScanTimer) clearTimeout(targetMainMonitorScanTimer);
    targetMainMonitorScanTimer = setTimeout(() => {
      targetMainMonitorScanTimer = null;
      if (targetMainMonitorRunning && targetMainMonitorId === monitorId) {
        queueTargetMonitorStop(monitorId);
        targetMainMonitorRunning = false;
        targetMainMonitorId = '';
      }
      log('[target] monitor: initial scan done — this copy is no longer polling Target');
    }, TARGET_MAIN_MONITOR_SCAN_MS);
    if (targetMainMonitorScanTimer && typeof targetMainMonitorScanTimer.unref === 'function') targetMainMonitorScanTimer.unref();
  }
  log('[target] monitor: ' + (wasRunning ? 'updated to ' : 'scanning ')
    + spec.items.length + ' active SKU(s) across ' + runningTaskIds.size + ' task(s)');
  return true;
}

function acknowledgeLiveEditMonitorStop(id) {
  if (!id || id !== liveEditMonitorId) return false;
  if (liveEditMonitorTimer) clearTimeout(liveEditMonitorTimer);
  liveEditMonitorTimer = null;
  liveEditMonitorId = '';
  return true;
}

function stopLiveEditMonitor() {
  if (liveEditMonitorTimer) clearTimeout(liveEditMonitorTimer);
  liveEditMonitorTimer = null;
  const id = liveEditMonitorId;
  liveEditMonitorId = '';
  if (id) queueTargetMonitorStop(id);
}

function skuMetaFromItems(items) {
  const maxPriceBySku = {};
  const priorityBySku = {};
  for (const item of (Array.isArray(items) ? items : [])) {
    const sku = String(item && (item.sku || item.monitorInput) || '').trim();
    if (!sku) continue;
    maxPriceBySku[sku] = String(item && item.maxPrice || '').trim();
    if (item && item.priority === true) priorityBySku[sku] = true;
  }
  return { maxPriceBySku, priorityBySku };
}

function engineItemsFor(skus, qty, maxPriceBySku = {}, priorityBySku = {}) {
  return (Array.isArray(skus) ? skus : []).map(sku => ({
    id: sku,
    monitorInput: sku,
    quantity: String(qty || 1),
    color: '',
    sizes: [],
    maxPrice: maxPriceBySku[sku] || '',
    priority: priorityBySku[sku] === true,
  }));
}

// A group edit replaces restock inputs in-place. Checkout tasks drain those edits at every step.
// If the selected TCIN is no longer watched, or a higher-priority watched SKU is in stock, the
// engine abandons the current product before payment and returns to restock selection. After
// submit-order starts, the checkout stays locked to the selected TCIN.
function editTargetTasks(config = {}) {
  const skus = [...new Set((Array.isArray(config.skus) ? config.skus : [])
    .map(value => String(value || '').trim())
    .filter(value => /^\d{6,}$/.test(value)))];
  const { maxPriceBySku, priorityBySku } = skuMetaFromItems(config.items);
  const ignoreLowStock = config.ignoreLowStock === true || config.stockConfidence === 'confirmed-10-plus';
  const qty = Math.max(1, parseInt(config.qty, 10) || 1);
  const selected = (Array.isArray(config.tasks) ? config.tasks : [])
    .filter(task => task && task.id && runningTaskIds.has(task.id));
  if (!selected.length) return { ok: false, updated: 0, watched: 0, cappedTasks: 0, error: 'No selected Target tasks are running.' };

  const makeItems = list => engineItemsFor(list, qty, maxPriceBySku, priorityBySku);
  let cappedTasks = 0;
  const messages = selected.map(task => {
    const accountId = task.accountId || taskAccountById.get(task.id) || '';
    const eligible = accountId
      ? skus.filter(sku => {
        try { return !dm.targetOrderLimitReached(accountId, sku); } catch { return true; }
      })
      : skus.slice();
    if (!eligible.length && skus.length) cappedTasks += 1;
    if (eligible.length < skus.length) {
      const capped = skus.filter(sku => !eligible.includes(sku));
      log('[limit] live edit skipped ' + capped.join(', ') + ' for this account', task.id);
    }
    const items = makeItems(eligible);
    return { id: task.id, type: 'Target', site: 'Target', item: items, monitorItems: items, ignoreLowStock };
  });

  const sent = sendToEngine({ type: 'edit-tasks', messages });
  if (!sent) return { ok: false, updated: 0, watched: 0, cappedTasks, error: 'The native Target engine is not connected.' };

  messages.forEach((message, index) => {
    const existing = taskCheckoutConfigById.get(message.id) || {};
    const selectedTask = selected[index] || {};
    taskCheckoutConfigById.set(message.id, {
      ...existing,
      skus: message.monitorItems.map(item => item.monitorInput),
      maxPriceBySku: Object.fromEntries(message.monitorItems.map(item => [item.monitorInput, item.maxPrice || ''])),
      priorityBySku: Object.fromEntries(message.monitorItems
        .filter(item => item.priority === true)
        .map(item => [item.monitorInput, true])),
      qty,
      proxyListName: selectedTask.proxyListName || existing.proxyListName || '',
      proxySources: sourceNamesFor(selectedTask.proxyListName || existing.proxyListName || ''),
      ignoreLowStock,
    });
  });

  const watched = [...new Set(messages.flatMap(message => message.monitorItems.map(item => item.monitorInput)))];
  const monitorItems = makeItems(watched);
  stopLiveEditMonitor();
  let monitorRefreshed = true;
  if (!sharedMonitorOnly()) {
    monitorRefreshed = reconcileTargetMainMonitor();
    liveEditStoppedMainMonitor = !targetMainMonitorRunning;
  } else if (targetMainMonitorRunning) {
    // While the one-time main scan is still alive, edit that monitor to the full active union.
    // Once it has stopped, the temporary live-edit scan below remains the low-traffic fallback.
    monitorRefreshed = reconcileTargetMainMonitor();
  } else if (watched.length) {
    const first = selected[0] || {};
    const id = MONITOR_ID + '-edit-' + (++liveEditMonitorSequence);
    liveEditMonitorId = id;
    monitorRefreshed = sendToEngine({ type: 'start-monitors', messages: [{
      id,
      site: 'Target',
      proxyGroup: groupOf(first.proxyListName),
      proxySources: sourceNamesFor(first.proxyListName),
      monitorDelay: '4000',
      ignoreLowStock,
      items: watched.map(sku => ({
        monitorInput: sku,
        quantity: String(qty),
        maxPrice: maxPriceBySku[sku] || '',
      })),
    }] });
    if (monitorRefreshed) {
      liveEditMonitorTimer = setTimeout(() => {
        const finishedId = liveEditMonitorId;
        liveEditMonitorId = '';
        liveEditMonitorTimer = null;
        if (finishedId) queueTargetMonitorStop(finishedId);
        log('[target] monitor: live-edit scan done — returning to the shared monitor');
      }, 20000);
      if (liveEditMonitorTimer && typeof liveEditMonitorTimer.unref === 'function') liveEditMonitorTimer.unref();
    } else {
      liveEditMonitorId = '';
    }
  }

  log('[target] watch list updated for ' + messages.length + ' running task(s): '
    + watched.length + ' SKU(s), qty ' + qty);
  if (!monitorRefreshed) log('[target] monitor refresh failed; checkout tasks still received the new watch list');
  return { ok: true, updated: messages.length, watched: watched.length, cappedTasks, monitorRefreshed };
}

// Continue a looping Target task only while this account still has an eligible watched SKU.
// The native task loops internally, so the launch-time cap alone cannot prevent a third order.
function enforceTargetLoopCheckout(taskId, accountId, purchasedTcin) {
  const config = taskCheckoutConfigById.get(taskId);
  if (!config || !config.loopCheckout) return;
  if (!accountId || !purchasedTcin || !config.skus.includes(purchasedTcin)) {
    log('[loop] stopped for safety — checkout result did not identify a watched account/SKU', taskId);
    stopTarget(taskId);
    return;
  }

  const eligible = config.skus.filter(sku => !dm.targetOrderLimitReached(accountId, sku));
  const used = dm.recentTargetOrders(accountId, purchasedTcin).length;
  if (eligible.length === config.skus.length) {
    log('[loop] order ' + used + '/' + dm.ORDER_LIMIT_MAX + ' recorded for ' + purchasedTcin + ' — continuing', taskId);
    return;
  }
  if (!eligible.length) {
    log('[loop] every watched SKU reached the ' + dm.ORDER_LIMIT_MAX + '-order limit — stopping', taskId);
    status('Limit Reached', '#f59e0b', dm.ORDER_LIMIT_MAX + ' orders per SKU in the last 4h', taskId, undefined, false);
    stopTarget(taskId);
    return;
  }

  const items = engineItemsFor(eligible, config.qty, config.maxPriceBySku || {}, config.priorityBySku || {});
  if (!sendToEngine({
    type: 'edit-tasks',
    messages: [{ id: taskId, type: 'Target', site: 'Target', item: items, monitorItems: items, ignoreLowStock: config.ignoreLowStock === true }],
  })) {
    log('[loop] could not remove capped SKUs — stopping for safety', taskId);
    stopTarget(taskId);
    return;
  }
  const capped = config.skus.filter(sku => !eligible.includes(sku));
  config.skus = eligible.slice();
  log('[loop] capped ' + capped.join(', ') + ' — continuing on ' + eligible.join(', '), taskId);
}

function sendStart(config) {
  liveEditStoppedMainMonitor = false;
  const skus = config.skus || [];
  const allTasks = config.tasks || [];
  if (!skus.length || !allTasks.length) return 0;

  // Enforce the 2-per-4h-per-account-per-SKU cap. Until now the cap only RECORDED orders; nothing
  // read them back, so a restart after two orders happily went for a third.
  //
  // Enforced here before the first order. Looping tasks also re-check after every confirmed
  // checkout, remove newly capped SKUs, and stop when no eligible watched SKU remains.
  //
  // Filtered per SKU, not per task: an account capped on SKU A can still take SKU B, and dropping
  // the whole task would silently give up on products it is still allowed to buy.
  const tasks = [];
  for (const t of allTasks) {
    const acct = t.accountId || '';
    const eligible = acct ? skus.filter(s => !dm.targetOrderLimitReached(acct, s)) : skus.slice();
    if (!eligible.length) {
      // startTarget optimistically marked it running; the engine never receives it, so drop it or a
      // Stop would target an id the engine has no task for and the card would sit on "Starting".
      runningTaskIds.delete(t.id);
      engineTaskSites.remove(t.id);
      taskProfileById.delete(t.id);
      taskCheckoutConfigById.delete(t.id);
      status('Limit Reached', '#f59e0b', `${dm.ORDER_LIMIT_MAX} orders in the last 4h`, t.id, undefined, false);
      log(`[limit] not starting — this account already has ${dm.ORDER_LIMIT_MAX} order(s) of ${skus.join(', ')} in the last 4h`, t.id);
      continue;
    }
    if (eligible.length < skus.length) {
      const capped = skus.filter(s => !eligible.includes(s));
      log(`[limit] skipping ${capped.join(', ')} — already at ${dm.ORDER_LIMIT_MAX} order(s) in the last 4h`, t.id);
    }
    tasks.push({ ...t, skus: eligible });
  }
  if (!tasks.length) {
    log('[limit] every task is at its 4-hour order limit — nothing started');
    return 0;
  }

  // The engine short-circuits proxy assignment ONLY on the literal group name "Local"
  // (BaseTask.SwapProxy). Any other value — including the empty string the UI sends for "no proxy"
  // — is treated as a real group name, GetProxy finds nothing under it, and the task is killed with
  // "Error Assigning Proxy" before it ever runs. Same for the monitor.

  // Each task is handed its whole ELIGIBLE watch list. matchKeys() (sites/target/monitor_sub.go)
  // turns monitorItems into the TCINs a task will wake for. Priority SKUs are tried first when
  // more than one is in stock. Leaving a capped SKU out of that set is what stops the task buying it.
  const { maxPriceBySku, priorityBySku } = skuMetaFromItems(config.items);
  const itemsFor = (list) => engineItemsFor(list, config.qty || 2, maxPriceBySku, priorityBySku);

  const messages = tasks.map(t => ({
    id: t.id,
    type: 'Target',
    site: 'Target',
    taskGroup: '',
    monitorDelay: '3000',
    retryDelay: '3000',
    proxyGroup: groupOf(t.proxyListName),
    proxySources: cachedProxySources(t.id, t.proxyListName),
    profileId: t.profileId || '',
    profileGroup: '',
    accountId: t.accountId || '',
    // The engine's restock watch (matchKeys / waitForStockPing) reads monitorItems, NOT item — so the
    // TCINs must be in BOTH or it reports "No valid TCIN inputs".
    item: itemsFor(t.skus),
    monitorItems: itemsFor(t.skus),
    // Target engine requires mode "Default" or "Checkout" — anything else logs "unrecognised task
    // mode" and the task never runs get-session/checkout. This UI is always a checkout flow.
    status: '', mode: 'Checkout', minPrice: '', maxPrice: '', statusColor: '',
    running: true, carted: false, failed: false, successful: false,
    loopCheckout: (t.loopCheckout != null ? t.loopCheckout === true : t.repeatCheckout === true) || config.endless === true, waitForQueue: false, QueueEntryDelay: '0',
    // allInstock=false puts the task in wait-for-restock, where it blocks in waitForStockPing()
    // until the monitor publishes. That is the whole point of the monitor-driven model: tasks idle
    // until something is actually in stock, then fire — and after an out-of-stock they fall back
    // into the same wait (bailToRestock) and keep watching until stopped.
    allInstock: false,
    // Target currently reads Endless for repeat behavior. Send both fields so a native update
    // can adopt LoopCheckout without changing the app-side contract again.
    endless: (t.loopCheckout != null ? t.loopCheckout === true : t.repeatCheckout === true) || config.endless === true, useFillerItem: !!config.useFillerItem,
    useOtpLogin: otpEnabled(t.profileId), startSchedule: '', stopSchedule: '', ignoreLowStock: config.ignoreLowStock === true || config.stockConfidence === 'confirmed-10-plus',
  }));
  if (!sendToEngine({ type: 'start-tasks', messages })) return -1;
  toRenderer('targetRunStarted', { taskIds: tasks.map(task => task.id), startedAt: Date.now() });

  for (const task of tasks) {
    const existing = taskCheckoutConfigById.get(task.id) || {};
    taskCheckoutConfigById.set(task.id, {
      ...existing,
      skus: task.skus.slice(),
      maxPriceBySku,
      priorityBySku,
      proxyListName: task.proxyListName || existing.proxyListName || '',
      proxySources: cachedProxySources(task.id, task.proxyListName || existing.proxyListName || ''),
    });
  }
  const watched = [...new Set(tasks.flatMap(t => t.skus))];

  // flushStart reconciles the one native monitor after every pending checkout batch has been
  // delivered, so additive configs cannot race duplicate starts for the same monitor ID.
  const firstRef = tasks[0] && tasks[0].proxyListName;
  const grp = groupOf(firstRef);
  const proxyCount = resolveAssignment(firstRef).sources.reduce((sum, source) => sum + source.lines.length, 0);
  log(`[target] monitor watching ${watched.length} SKU(s) for ${tasks.length} task(s)`);
  log(grp === 'Local'
    ? '[target] ⚠ proxy group: Local (your own IP) — redsky will 403 the monitor. Pick a list on the task, then STOP and START it.'
    : `[target] proxy group: ${grp} (${proxyCount} proxies)`);
  return tasks.length;
}

function flushStart() {
  if (pendingTargetEngineStop || !pendingTargetStarts.length) return 0;
  let startedTotal = 0;
  while (pendingTargetStarts.length) {
    const config = pendingTargetStarts[0];
    if (!config || !Array.isArray(config.tasks) || !config.tasks.length) {
      pendingTargetStarts.shift();
      continue;
    }
    if (!sendConfigs(config)) break;
    // Count what sendStart actually started — tasks whose account is at its 4-hour limit are
    // refused there, and claiming them here would report a count the engine never received.
    const started = sendStart(config);
    if (started < 0) break;
    pendingTargetStarts.shift();
    if (!started) continue;
    startedTotal += started;
    taskActive = true;
    log(`${started} task(s) started on ${(config.skus || []).length} SKU(s)`);
  }
  if (startedTotal) reconcileTargetMainMonitor();
  return startedTotal;
}

// ── Pokemon Center US: native checkout tasks on the shared Go transport ─────────
const POKEMON_SITE = engineContract.SITES.POKEMON_CENTER_US;
const pokemonTaskIds = new Set();
const pokemonTaskConfigs = new Map();
const pendingPokemonStarts = [];
let pokemonStartSeq = 0;
let pokemonQueueStreamHealth = { configured: false, connected: false, connecting: false };
let pokemonQueueStreamLogKey = '';
let solverLucaApiKey = '';

const pokemonStatusCoalescer = createStatusCoalescer({
  intervalMs: STATUS_FLUSH_MS,
  send: updates => toRenderer('pokemonStatusBatch', { updates }),
});
const pokemonLogBufs = {};
let pokemonLogTimer = null;
function flushPokemonLogs() {
  pokemonLogTimer = null;
  const byTask = {};
  for (const key of Object.keys(pokemonLogBufs)) {
    const lines = pokemonLogBufs[key];
    if (!lines || !lines.length) continue;
    delete pokemonLogBufs[key];
    byTask[key] = lines;
  }
  if (Object.keys(byTask).length) toRenderer('pokemonLogBatch', { byTask });
}

function pokemonStatus(state, color, detail, taskId, taskState, running) {
  state = zynBrandText(state);
  detail = zynBrandText(detail);
  pokemonStatusCoalescer.enqueue(String(taskId || ''), {
    taskId: String(taskId || ''), state: String(state || ''), label: String(state || ''),
    color: String(color || ''), detail: String(detail || ''),
    taskState: typeof taskState === 'number' ? taskState : undefined,
    running: typeof running === 'boolean' ? running : undefined,
  }, { immediate: running === false });
}

function pokemonLog(line, taskId = '') {
  let value = zynBrandText(redactProxies(String(line || ''))).replace(/[\r\n]+/g, ' ').trim();
  if (!value) return;
  if (value.length > LOG_LINE_MAX) value = value.slice(0, LOG_LINE_MAX) + '…';
  const key = String(taskId || '');
  const buf = pokemonLogBufs[key] || (pokemonLogBufs[key] = []);
  buf.push(value);
  if (buf.length > LOG_BUF_MAX) pokemonLogBufs[key] = buf.slice(-LOG_BUF_MAX);
  if (!pokemonLogTimer) pokemonLogTimer = setTimeout(flushPokemonLogs, LOG_FLUSH_MS);
}

function pokemonDone(taskId = '') {
  toRenderer('pokemonDone', { taskId: String(taskId || '') });
}

// A native crash or spawn failure is not retryable here: blindly respawning can loop forever on a
// missing/invalid executable. Fail every optimistic start together and clear both FIFOs so a later
// user start cannot resurrect a card that was already reported done.
function failNativeEngineRuns(reason, publishError = false) {
  const detail = String(reason || 'Native engine stopped').replace(/[\r\n]+/g, ' ').slice(0, 200);
  const failedConnection = engineConn;
  engineConn = null;
  try { if (failedConnection) failedConnection.close(); } catch {}
  taskActive = false;
  activeMonitorBandwidthRuns.clear();
  stopLiveEditMonitor();
  targetMainMonitorPendingStopIds.clear();
  clearTargetMainMonitorState();
  cancelAllOtpFetches(detail);
  for (const id of runningTaskIds) {
    if (publishError) status('Error', '#fb5454', detail, id, undefined, false);
    toRenderer('targetDone', { taskId: id });
  }
  for (const id of pokemonTaskIds) {
    if (publishError) pokemonStatus('Error', '#fb5454', detail, id, 0, false);
    pokemonDone(id);
  }
  for (const id of walmartTaskIds) {
    if (publishError) walmartStatus('Error', '#fb5454', detail, id, 0, false);
    walmartDone(id);
  }
  runningTaskIds.clear();
  clearTargetCookieTasks();
  clearPendingTargetStarts();
  pokemonTaskIds.clear();
  pokemonTaskConfigs.clear();
  pendingPokemonStarts.length = 0;
  walmartTaskIds.clear();
  walmartTaskConfigs.clear();
  pendingWalmartStarts.length = 0;
  walmartMonitorIds.clear();
  engineTaskSites.clear();
  taskAccountById.clear();
  taskProfileById.clear();
  taskCheckoutConfigById.clear();
  manualCaptchaManager.cancelPending();
  nativeHyperBroker.cancelPending();
  toRenderer('targetDone', { taskId: '' });
}

function pokemonQueueStreamLine() {
  if (pokemonQueueStreamHealth.connected) {
    return '[queue-monitor] push event stream connected; HTTPS fallback remains active';
  }
  if (pokemonQueueStreamHealth.connecting) {
    return '[queue-monitor] push event stream reconnecting; HTTPS fallback remains active';
  }
  if (!pokemonQueueStreamHealth.configured) {
    return '[queue-monitor] push event stream is not configured; HTTPS fallback remains active';
  }
  return '[queue-monitor] push event stream unavailable; HTTPS fallback remains active';
}

function setPokemonQueueStreamHealth(next = {}) {
  pokemonQueueStreamHealth = {
    configured: next.configured === true,
    connected: next.connected === true,
    connecting: next.connecting === true,
  };
  const line = pokemonQueueStreamLine();
  if (line === pokemonQueueStreamLogKey) return;
  pokemonQueueStreamLogKey = line;
  for (const id of pokemonTaskIds) pokemonLog(line, id);
}

function setSolverLucaKey(key = '') {
  const next = String(key || '').trim();
  if (next === solverLucaApiKey) return;
  solverLucaApiKey = next;
  if (solverLucaApiKey) sendConfigs();
}

function publishPokemonQueueProtection(event = {}) {
  const kind = String(event.kind || '').toLowerCase() === 'captcha' ? 'captcha' : 'queue';
  const sent = sendStockPing({
    site: 'PokemonCenter',
    sku: 'queue',
    name: kind === 'captcha' ? 'Site captcha protection detected' : 'Site queue detected',
    from: 'zyn-event-stream',
  });
  if (sent) {
    for (const id of pokemonTaskIds) pokemonLog(`[queue-monitor] push event received (${kind})`, id);
  }
  return sent;
}

function normalizePokemonInput(value) {
  const input = String(value || '').trim();
  if (!input) return '';
  if (input.toLowerCase() === 'placeholder') return 'placeholder';
  if (/^https?:\/\//i.test(input)) {
    try {
      const parsed = new URL(input);
      if (!(parsed.hostname === 'pokemoncenter.com' || parsed.hostname.endsWith('.pokemoncenter.com'))) return '';
      const product = parsed.pathname.match(/\/product\/([^/]+)/);
      return product && product[1] ? `https://www.pokemoncenter.com/product/${product[1]}` : '';
    } catch { return ''; }
  }
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input) ? input : '';
}

function validatePokemonInputs(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(/[\n,]/);
  const entries = list.map(entry => String(entry || '').trim()).filter(Boolean);
  const normalized = entries.map(normalizePokemonInput);
  return {
    inputs: [...new Set(normalized.filter(Boolean))].slice(0, 3),
    invalid: entries.filter((entry, index) => !normalized[index]),
    tooMany: [...new Set(normalized.filter(Boolean))].length > 3,
  };
}

function pokemonInputs(value) {
  return validatePokemonInputs(value).inputs;
}

function validatePokemonProducts(products, legacyInputs, legacyQuantity) {
  const rows = Array.isArray(products)
    ? products
    : pokemonInputs(legacyInputs).map(input => ({ input, quantity: legacyQuantity }));
  const populated = rows.map(row => ({
    input: String((row && (row.input || row.monitorInput || row.id)) || '').trim(),
    quantity: String(Math.max(1, parseInt(row && row.quantity, 10) || 1)),
  })).filter(row => row.input);
  const normalized = populated.map(row => normalizePokemonInput(row.input));
  const seen = new Set();
  const valid = [];
  populated.forEach((row, index) => {
    const input = normalized[index];
    if (!input || seen.has(input)) return;
    seen.add(input);
    valid.push({ input, quantity: row.quantity });
  });
  return {
    products: valid.slice(0, 3),
    invalid: populated.filter((row, index) => !normalized[index]).map(row => row.input),
    tooMany: valid.length > 3 || populated.length > 3,
  };
}

function pokemonItems(products) {
  return products.map(product => ({
    id: product.input, monitorInput: product.input, quantity: product.quantity, maxPrice: '', color: '', sizes: [],
  }));
}

function pokemonMessage(task = {}, shared = {}) {
  const products = validatePokemonProducts(
    task.products != null ? task.products : shared.products,
    task.inputs != null ? task.inputs : shared.inputs,
    task.quantity != null ? task.quantity : shared.quantity,
  ).products;
  const items = pokemonItems(products);
  return engineContract.normalizeStartTask({
    id: String(task.id || ''), type: POKEMON_SITE, site: POKEMON_SITE,
    taskGroup: '',
    monitorDelay: String(task.monitorDelay || shared.monitorDelay || '3000'),
    retryDelay: String(task.retryDelay || shared.retryDelay || '3000'),
    proxyGroup: String(task.proxyListName || '').trim() || 'Local',
    profileId: String(task.profileId || ''), profileGroup: '', accountId: '',
    item: items, monitorItems: items,
    status: '', mode: 'Default', minPrice: '', maxPrice: '', statusColor: '',
    running: true, carted: false, failed: false, successful: false,
    loopCheckout: task.loopCheckout != null ? !!task.loopCheckout : !!shared.loopCheckout,
    waitForQueue: task.waitForQueue != null ? !!task.waitForQueue : !!shared.waitForQueue,
    QueueEntryDelay: String(task.queueEntryDelay != null ? task.queueEntryDelay : (shared.queueEntryDelay || '0')),
    allInstock: task.allInstock != null ? !!task.allInstock : !!shared.allInstock,
    endless: false, useFillerItem: false, useOtpLogin: false,
    startSchedule: '', stopSchedule: '', ignoreLowStock: false,
  });
}

function rememberPokemonConfig(task, shared) {
  const merged = {
    ...shared, ...task,
    products: validatePokemonProducts(
      task.products != null ? task.products : shared.products,
      task.inputs != null ? task.inputs : shared.inputs,
      task.quantity != null ? task.quantity : shared.quantity,
    ).products,
  };
  pokemonTaskConfigs.set(String(task.id), merged);
  return merged;
}

// Loop Checkout rotates inside the selected profile's first group. The engine replaces its entire
// profile store on send-configs, so every rotation candidate must be present even when it does not
// own an initial task.
function addPokemonRotationProfiles(tasks) {
  let profiles = [];
  try {
    profiles = (dm.getProfiles() || []).filter(profile => profile && profile.profileType === 'pokemoncenter');
  } catch {}
  const groups = new Set();
  for (const task of tasks) {
    if (!task.loopCheckout) continue;
    const profile = profiles.find(value => String(value.id) === String(task.profileId));
    const group = String((profile && (profile.group || (profile.groups || [])[0])) || '').trim();
    if (group) groups.add(group);
  }
  for (const profile of profiles) {
    const group = String(profile.group || (profile.groups || [])[0] || '').trim();
    if (group && groups.has(group)) Object.assign(sentConfigs.profiles, buildProfileMap(profile.id, ''));
  }
}

function flushPokemonStarts() {
  if (pendingTargetEngineStop || !engineConn || engineConn.readyState !== WebSocket.OPEN) return 0;
  let started = 0;
  while (pendingPokemonStarts.length) {
    const config = pendingPokemonStarts[0] || {};
    const tasks = (config.tasks || []).filter(task => task && pokemonTaskIds.has(String(task.id || '')));
    if (!tasks.length) {
      pendingPokemonStarts.shift();
      continue;
    }
    addPokemonRotationProfiles(tasks);
    const messages = tasks.map(task => pokemonMessage(task, config));
    if (!messages.every(message => message.profileId && message.item.length)) {
      for (const message of messages) {
        if (!message.profileId || !message.item.length) {
          pokemonStatus('Invalid Task', '#fb5454', !message.profileId ? 'Select a checkout profile' : 'Add a product', message.id, 0, false);
          pokemonTaskIds.delete(message.id);
          pokemonTaskConfigs.delete(message.id);
          engineTaskSites.remove(message.id);
          pokemonDone(message.id);
        }
      }
    }
    const valid = messages.filter(message => message.profileId && message.item.length);
    if (!valid.length) {
      pendingPokemonStarts.shift();
      continue;
    }
    if (!sendConfigs({ tasks }) || !sendToEngine({ type: 'start-tasks', messages: valid })) {
      break;
    }
    pendingPokemonStarts.shift();
    started += valid.length;
    for (const message of valid) {
      pokemonLog('Pokémon Center task started', message.id);
      pokemonLog(pokemonQueueStreamLine(), message.id);
    }
  }
  taskActive = runningTaskIds.size > 0 || pokemonTaskIds.size > 0 || walmartTaskIds.size > 0;
  return started;
}

function startPokemonCenter(config = {}, mainWindow) {
  attachWindow(mainWindow);
  const requestedTasks = Array.isArray(config.tasks) ? config.tasks : [config];
  const sharedValidation = validatePokemonProducts(config.products, config.inputs, config.quantity);
  const usesSharedProducts = requestedTasks.some(task => !task || task.products == null);
  const invalidTask = requestedTasks.some(task => {
    const validation = validatePokemonProducts(
      task && task.products != null ? task.products : config.products,
      task && task.inputs != null ? task.inputs : config.inputs,
      task && task.quantity != null ? task.quantity : config.quantity,
    );
    return validation.invalid.length || validation.tooMany || !validation.products.length;
  });
  if ((usesSharedProducts && (sharedValidation.invalid.length || sharedValidation.tooMany || !sharedValidation.products.length)) || invalidTask) return false;
  let validProfileIds = new Set();
  try {
    validProfileIds = new Set((dm.getProfiles() || [])
      .filter(profile => profile && profile.profileType === 'pokemoncenter')
      .map(profile => String(profile.id)));
  } catch {}
  const tasks = requestedTasks
    .filter(task => task && task.id && validProfileIds.has(String(task.profileId)));
  const products = sharedValidation.products;
  if (!tasks.length) return false;

  const batch = { ...config, products, tasks: tasks.map(task => rememberPokemonConfig(task, { ...config, products })) };
  pendingPokemonStarts.push(batch);
  for (const task of batch.tasks) {
    const id = String(task.id);
    pokemonTaskIds.add(id);
    engineTaskSites.register(id, POKEMON_SITE);
    pokemonStatus('Starting', '#868686', 'launching engine', id, 1, true);
  }
  flushStartingStatuses(pokemonStatusCoalescer);
  forgetStatusKeys(batch.tasks.map(task => task && task.id));
  const seq = ++pokemonStartSeq;
  ensureServer(() => {
    if (seq !== pokemonStartSeq && !batch.tasks.some(task => pokemonTaskIds.has(String(task.id)))) return;
    spawnEngine();
    if (engineConn && engineConn.readyState === WebSocket.OPEN) flushPokemonStarts();
  });
  return true;
}

function editPokemonCenter(config = {}) {
  const requested = Array.isArray(config.tasks) ? config.tasks : [];
  const selected = requested.length
    ? requested.filter(task => task && pokemonTaskIds.has(String(task.id || '')))
    : [...pokemonTaskIds].map(id => ({ id }));
  if (!selected.length) return { ok: false, updated: 0, error: 'No selected Pokémon Center tasks are running.' };

  const invalidInput = selected.some(update => {
    const previous = pokemonTaskConfigs.get(String(update.id)) || {};
    const products = update.products != null ? update.products
      : (config.products != null ? config.products : previous.products);
    const inputs = update.inputs != null ? update.inputs : (config.inputs != null ? config.inputs : previous.inputs);
    const quantity = update.quantity != null ? update.quantity : (config.quantity != null ? config.quantity : previous.quantity);
    const validation = validatePokemonProducts(products, inputs, quantity);
    return validation.invalid.length || validation.tooMany;
  });
  if (invalidInput) {
    return { ok: false, updated: 0, error: 'Use up to three Pokémon Center SKUs, product URLs, or placeholder.' };
  }

  const tasks = selected.map(update => {
    const id = String(update.id);
    const previous = pokemonTaskConfigs.get(id) || { id };
    const { tasks: ignoredTasks, ...shared } = config;
    return rememberPokemonConfig({ ...previous, ...shared, ...update, id }, previous);
  });
  addPokemonRotationProfiles(tasks);
  sendConfigs({ tasks });
  const messages = tasks.map(task => pokemonMessage(task, task));
  if (!messages.every(message => message.profileId && message.item.length)) {
    return { ok: false, updated: 0, error: 'Every running task needs a profile and at least one product.' };
  }
  const ok = sendToEngine({ type: 'edit-tasks', messages });
  if (ok) {
    for (const message of messages) pokemonLog(`Watch list updated (${message.item.length} product${message.item.length === 1 ? '' : 's'})`, message.id);
  }
  return { ok, updated: ok ? messages.length : 0, error: ok ? '' : 'The native engine is not connected.' };
}

function setPokemonCenterTaskProxy(taskId, proxyListName) {
  const id = String(taskId || '');
  if (!pokemonTaskIds.has(id)) return false;
  const group = String(proxyListName || '').trim() || 'Local';
  if (group !== 'Local') {
    Object.assign(sentConfigs.proxies, buildProxyMap(group));
    sendConfigs();
  }
  const current = pokemonTaskConfigs.get(id) || { id };
  pokemonTaskConfigs.set(id, { ...current, proxyListName: group === 'Local' ? '' : group });
  return sendToEngine({ type: 'set-task-proxy', messages: [{ id, proxyGroup: group }] });
}

function stopPokemonCenter(taskId) {
  const requestedId = String(taskId || '');
  const ids = requestedId ? [requestedId] : [...pokemonTaskIds];
  if (engineConn && ids.length) sendToEngine({ type: 'stop-tasks', messages: ids.map(id => ({ id })) });
  for (const id of ids) {
    pokemonTaskIds.delete(id);
    pokemonTaskConfigs.delete(id);
    engineTaskSites.remove(id);
    manualCaptchaManager.cancelTask(id);
    pokemonDone(id);
  }
  if (!requestedId) {
    pokemonStartSeq += 1;
    pendingPokemonStarts.length = 0;
  } else {
    for (let i = pendingPokemonStarts.length - 1; i >= 0; i -= 1) {
      pendingPokemonStarts[i].tasks = (pendingPokemonStarts[i].tasks || []).filter(task => String(task.id) !== requestedId);
      if (!pendingPokemonStarts[i].tasks.length) pendingPokemonStarts.splice(i, 1);
    }
  }
  if (pokemonTaskIds.size || runningTaskIds.size) {
    taskActive = true;
    return true;
  }
  taskActive = false;
  nativeHyperBroker.cancelPending();
  manualCaptchaManager.cancelPending();
  beginTargetEngineStop(engineProc);
  return true;
}

function runningPokemonCenterCount() { return pokemonTaskIds.size; }

const WALMART_SITE = engineContract.SITES.WALMART;
const walmartTaskIds = new Set();
const walmartTaskConfigs = new Map();
const pendingWalmartStarts = [];
const walmartMonitorIds = new Map(); // pid -> monitor task id
let walmartStartSeq = 0;

const walmartStatusCoalescer = createStatusCoalescer({
  intervalMs: STATUS_FLUSH_MS,
  send: updates => toRenderer('walmartStatusBatch', { updates }),
});
const walmartLogBufs = {};
let walmartLogTimer = null;
function flushWalmartLogs() {
  walmartLogTimer = null;
  const byTask = {};
  for (const key of Object.keys(walmartLogBufs)) {
    const lines = walmartLogBufs[key];
    if (!lines || !lines.length) continue;
    delete walmartLogBufs[key];
    byTask[key] = lines;
  }
  if (Object.keys(byTask).length) toRenderer('walmartLogBatch', { byTask });
}

function walmartStatus(state, color, detail, taskId, taskState, running) {
  state = zynBrandText(state);
  detail = zynBrandText(detail);
  walmartStatusCoalescer.enqueue(String(taskId || ''), {
    taskId: String(taskId || ''), state: String(state || ''), label: String(state || ''),
    color: String(color || ''), detail: String(detail || ''),
    taskState: typeof taskState === 'number' ? taskState : undefined,
    running: typeof running === 'boolean' ? running : undefined,
  }, { immediate: running === false });
}

function walmartLog(line, taskId = '') {
  let value = zynBrandText(redactProxies(String(line || ''))).replace(/[\r\n]+/g, ' ').trim();
  if (!value) return;
  if (value.length > LOG_LINE_MAX) value = value.slice(0, LOG_LINE_MAX) + '…';
  const key = String(taskId || '');
  const buf = walmartLogBufs[key] || (walmartLogBufs[key] = []);
  buf.push(value);
  if (buf.length > LOG_BUF_MAX) walmartLogBufs[key] = buf.slice(-LOG_BUF_MAX);
  if (!walmartLogTimer) walmartLogTimer = setTimeout(flushWalmartLogs, LOG_FLUSH_MS);
}

function walmartDone(taskId = '', { idle = false } = {}) {
  toRenderer('walmartDone', { taskId: String(taskId || ''), idle: idle === true });
}

function isWalmartOfferId(value) {
  return /^[A-Za-z0-9]{32}$/.test(String(value || '').trim());
}

function parseWalmartPid(value) {
  const input = String(value || '').trim();
  if (!input || isWalmartOfferId(input) || input.toLowerCase() === 'placeholder') return '';
  const lower = input.toLowerCase();
  const ip = lower.indexOf('/ip/');
  if (ip >= 0) {
    let rest = input.slice(ip + 4);
    const query = rest.indexOf('?');
    if (query >= 0) rest = rest.slice(0, query);
    const parts = rest.split('/');
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      const part = String(parts[i] || '').trim();
      if (/^\d{6,}$/.test(part)) return part;
    }
    return '';
  }
  const item = input.match(/\/(\d{6,})(?:[/?]|$)/);
  if (item) return item[1];
  return /^\d{6,}$/.test(input) ? input : '';
}

function normalizeWalmartInput(value) {
  const input = String(value || '').trim();
  if (!input) return '';
  if (input.toLowerCase() === 'placeholder') return 'placeholder';
  if (isWalmartOfferId(input)) return input;
  if (/^https?:\/\//i.test(input)) {
    try {
      const parsed = new URL(input);
      if (!(parsed.hostname === 'walmart.com' || parsed.hostname.endsWith('.walmart.com'))) return '';
      return input;
    } catch { return ''; }
  }
  return /^\d{6,}$/.test(input) ? input : '';
}

function validateWalmartProducts(products, legacyInput, legacyQuantity, legacyMaxPrice) {
  const rows = Array.isArray(products)
    ? products
    : (legacyInput ? [{ input: legacyInput, quantity: legacyQuantity, maxPrice: legacyMaxPrice }] : []);
  const populated = rows.map(row => ({
    input: String((row && (row.input || row.monitorInput || row.id)) || '').trim(),
    quantity: String(Math.max(1, parseInt(row && row.quantity, 10) || 1)),
    maxPrice: String((row && row.maxPrice) || '').trim(),
  })).filter(row => row.input);
  const normalized = populated.map(row => normalizeWalmartInput(row.input));
  const seen = new Set();
  const valid = [];
  populated.forEach((row, index) => {
    const input = normalized[index];
    if (!input || seen.has(input)) return;
    seen.add(input);
    valid.push({ input, quantity: row.quantity, maxPrice: row.maxPrice });
  });
  if (!valid.length && !invalid.length) {
    return { products: [{ input: 'placeholder', quantity: '1', maxPrice: '' }], invalid: [] };
  }
  return {
    products: valid,
    invalid: populated.filter((row, index) => !normalized[index]).map(row => row.input),
  };
}

function walmartItems(products) {
  return products.map(product => ({
    id: product.input, monitorInput: product.input, quantity: product.quantity,
    maxPrice: product.maxPrice || '', color: '', sizes: [],
  }));
}

function normalizeWalmartMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  if (mode === 'raffle entry' || mode === 'raffle' || mode === 'draw') return 'Raffle Entry';
  return 'Checkout';
}

function walmartMessage(task = {}, shared = {}) {
  const products = validateWalmartProducts(
    task.products != null ? task.products : shared.products,
    task.input != null ? task.input : shared.input,
    task.quantity != null ? task.quantity : shared.quantity,
    task.maxPrice != null ? task.maxPrice : shared.maxPrice,
  ).products;
  const items = walmartItems(products);
  return engineContract.normalizeStartTask({
    id: String(task.id || ''), type: WALMART_SITE, site: WALMART_SITE,
    taskGroup: '',
    monitorDelay: String(task.monitorDelay || shared.monitorDelay || '3000'),
    retryDelay: String(task.retryDelay || shared.retryDelay || '3000'),
    proxyGroup: String(task.proxyListName || '').trim() || 'Local',
    profileId: String(task.profileId || ''), profileGroup: '',
    accountId: String(task.accountId || ''),
    item: items, monitorItems: items,
    status: '', mode: normalizeWalmartMode(task.mode || shared.mode), minPrice: '', maxPrice: '', statusColor: '',
    running: true, carted: false, failed: false, successful: false,
    loopCheckout: false, waitForQueue: false, QueueEntryDelay: '0',
    allInstock: false, endless: task.endless != null ? !!task.endless : !!shared.endless,
    useFillerItem: false, useOtpLogin: false,
    startSchedule: '', stopSchedule: '', ignoreLowStock: false,
  });
}

function rememberWalmartConfig(task, shared) {
  const merged = {
    ...shared, ...task,
    products: validateWalmartProducts(
      task.products != null ? task.products : shared.products,
      task.input != null ? task.input : shared.input,
      task.quantity != null ? task.quantity : shared.quantity,
      task.maxPrice != null ? task.maxPrice : shared.maxPrice,
    ).products,
  };
  walmartTaskConfigs.set(String(task.id), merged);
  return merged;
}

function stopWalmartMonitor(pid) {
  const id = walmartMonitorIds.get(String(pid || ''));
  if (!id) return;
  walmartMonitorIds.delete(String(pid));
  if (engineConn) sendToEngine({ type: 'stop-tasks', messages: [{ id }] });
}

function walmartPidsFromConfig(config) {
  const products = validateWalmartProducts(
    config && config.products, config && config.input, config && config.quantity, config && config.maxPrice,
  ).products;
  return products.map(product => parseWalmartPid(product.input)).filter(Boolean);
}

function reconcileWalmartMonitors() {
  const wanted = new Set();
  for (const config of walmartTaskConfigs.values()) {
    if (normalizeWalmartMode(config.mode) === 'Raffle Entry') continue;
    for (const pid of walmartPidsFromConfig(config)) wanted.add(pid);
  }
  for (const pid of [...walmartMonitorIds.keys()]) {
    if (!wanted.has(pid)) stopWalmartMonitor(pid);
  }
  if (!engineConn || engineConn.readyState !== WebSocket.OPEN) return;
  for (const pid of wanted) {
    if (walmartMonitorIds.has(pid)) continue;
    const id = `walmart-monitor-${pid}`;
    const owner = [...walmartTaskConfigs.values()].find(config => walmartPidsFromConfig(config).includes(pid));
    const sent = sendToEngine({ type: 'start-monitors', messages: [{
      id, site: WALMART_SITE,
      proxyGroup: String((owner && owner.proxyListName) || '').trim() || 'Local',
      monitorDelay: String((owner && owner.monitorDelay) || '3000'),
      ignoreLowStock: false,
      items: [{ monitorInput: pid, quantity: '1', maxPrice: '' }],
    }] });
    if (sent) walmartMonitorIds.set(pid, id);
  }
}

function flushWalmartStarts() {
  if (pendingTargetEngineStop || !engineConn || engineConn.readyState !== WebSocket.OPEN) return 0;
  let started = 0;
  while (pendingWalmartStarts.length) {
    const config = pendingWalmartStarts[0] || {};
    const tasks = (config.tasks || []).filter(task => task && walmartTaskIds.has(String(task.id || '')));
    if (!tasks.length) {
      pendingWalmartStarts.shift();
      continue;
    }
    const messages = tasks.map(task => walmartMessage(task, config));
    const valid = messages.filter(message => message.profileId && message.accountId && message.item.length);
    for (const message of messages) {
      if (valid.includes(message)) continue;
      walmartStatus('Invalid Task', '#fb5454', !message.accountId ? 'Select a Walmart account'
        : (!message.profileId ? 'Select a checkout profile' : 'Add a product'), message.id, 0, false);
      walmartTaskIds.delete(message.id);
      walmartTaskConfigs.delete(message.id);
      engineTaskSites.remove(message.id);
      walmartDone(message.id);
    }
    if (!valid.length) {
      pendingWalmartStarts.shift();
      continue;
    }
    if (!sendConfigs({ tasks }) || !sendToEngine({ type: 'start-tasks', messages: valid })) break;
    pendingWalmartStarts.shift();
    started += valid.length;
    for (const message of valid) walmartLog('Walmart task started', message.id);
    reconcileWalmartMonitors();
  }
  taskActive = runningTaskIds.size > 0 || pokemonTaskIds.size > 0 || walmartTaskIds.size > 0;
  return started;
}

function startWalmart(config = {}, mainWindow) {
  attachWindow(mainWindow);
  const requestedTasks = Array.isArray(config.tasks) ? config.tasks : [config];
  const products = validateWalmartProducts(config.products, config.input, config.quantity, config.maxPrice).products;
  if (!products.length) return false;
  let validAccountIds = new Set();
  let validProfileIds = new Set();
  try {
    validAccountIds = new Set((dm.getAccounts() || [])
      .filter(account => String((account && account.site) || '').toLowerCase() === 'walmart')
      .map(account => String(account.id)));
    validProfileIds = new Set((dm.getProfiles() || [])
      .filter(profile => String((profile && profile.profileType) || '').toLowerCase() === 'walmart')
      .map(profile => String(profile.id)));
  } catch {}
  const tasks = requestedTasks.filter(task => task && task.id
    && validAccountIds.has(String(task.accountId))
    && validProfileIds.has(String(task.profileId)));
  if (!tasks.length) return false;

  const batch = { ...config, products, tasks: tasks.map(task => rememberWalmartConfig(task, { ...config, products })) };
  pendingWalmartStarts.push(batch);
  for (const task of batch.tasks) {
    const id = String(task.id);
    walmartTaskIds.add(id);
    engineTaskSites.register(id, WALMART_SITE);
    taskAccountById.set(id, String(task.accountId || ''));
    taskProfileById.set(id, String(task.profileId || ''));
    walmartStatus('Starting', '#868686', 'launching engine', id, 1, true);
  }
  flushStartingStatuses(walmartStatusCoalescer);
  const seq = ++walmartStartSeq;
  ensureServer(() => {
    if (seq !== walmartStartSeq && !batch.tasks.some(task => walmartTaskIds.has(String(task.id)))) return;
    spawnEngine();
    if (engineConn && engineConn.readyState === WebSocket.OPEN) flushWalmartStarts();
  });
  return true;
}

function editWalmart(config = {}) {
  const requested = Array.isArray(config.tasks) ? config.tasks : [];
  const selected = requested.length
    ? requested.filter(task => task && walmartTaskIds.has(String(task.id || '')))
    : [...walmartTaskIds].map(id => ({ id }));
  if (!selected.length) return { ok: false, updated: 0, error: 'No selected Walmart tasks are running.' };
  const tasks = selected.map(update => {
    const id = String(update.id);
    const previous = walmartTaskConfigs.get(id) || { id };
    return rememberWalmartConfig({ ...previous, ...config, ...update, id }, previous);
  });
  sendConfigs({ tasks });
  const messages = tasks.map(task => walmartMessage(task, task));
  if (!messages.every(message => message.profileId && message.accountId && message.item.length)) {
    return { ok: false, updated: 0, error: 'Every running task needs an account, profile, and product.' };
  }
  const ok = sendToEngine({ type: 'edit-tasks', messages });
  if (ok) reconcileWalmartMonitors();
  return { ok, updated: ok ? messages.length : 0, error: ok ? '' : 'The native engine is not connected.' };
}

function setWalmartTaskProxy(taskId, proxyListName) {
  const id = String(taskId || '');
  if (!walmartTaskIds.has(id)) return false;
  const group = String(proxyListName || '').trim() || 'Local';
  if (group !== 'Local') {
    Object.assign(sentConfigs.proxies, buildProxyMap(group));
    sendConfigs();
  }
  const current = walmartTaskConfigs.get(id) || { id };
  walmartTaskConfigs.set(id, { ...current, proxyListName: group === 'Local' ? '' : group });
  return sendToEngine({ type: 'set-task-proxy', messages: [{ id, proxyGroup: group }] });
}

function stopWalmart(taskId) {
  const requestedId = String(taskId || '');
  const ids = requestedId ? [requestedId] : [...walmartTaskIds];
  if (engineConn && ids.length) sendToEngine({ type: 'stop-tasks', messages: ids.map(id => ({ id })) });
  for (const id of ids) {
    walmartTaskIds.delete(id);
    walmartTaskConfigs.delete(id);
    engineTaskSites.remove(id);
    taskAccountById.delete(id);
    taskProfileById.delete(id);
    walmartDone(id, { idle: true });
  }
  if (!requestedId) {
    walmartStartSeq += 1;
    pendingWalmartStarts.length = 0;
  } else {
    for (let i = pendingWalmartStarts.length - 1; i >= 0; i -= 1) {
      pendingWalmartStarts[i].tasks = (pendingWalmartStarts[i].tasks || []).filter(task => String(task.id) !== requestedId);
      if (!pendingWalmartStarts[i].tasks.length) pendingWalmartStarts.splice(i, 1);
    }
  }
  reconcileWalmartMonitors();
  if (walmartTaskIds.size || pokemonTaskIds.size || runningTaskIds.size) {
    taskActive = true;
    return true;
  }
  taskActive = false;
  nativeHyperBroker.cancelPending();
  manualCaptchaManager.cancelPending();
  beginTargetEngineStop(engineProc);
  return true;
}

function decodeNativeTaskLog(value) {
  try {
    const input = Buffer.from(String(value || ''), 'base64');
    const key = Buffer.from('Zyn-Task-Log-v1');
    const output = Buffer.alloc(input.length);
    for (let i = 0; i < input.length; i += 1) output[i] = input[i] ^ key[i % key.length];
    return output.toString('utf8');
  } catch { return ''; }
}

function handleEngineMessage(data, connection) {
  // A closing or replaced socket may still have buffered messages. Only the currently owned native
  // connection may mutate task state or acknowledge a monitor shutdown.
  if (!connection || engineConn !== connection) return;
  let msg;
  try { msg = engineContract.parseEnvelope(data); } catch { return; }
  const items = msg.messages;
  switch (msg.type) {
    // Product names, pushed by the monitor from the redsky response it already parses. The app
    // cannot look these up itself — redsky fingerprints the TLS handshake and refuses a plain
    // request with 403 regardless of proxy, so the engine's client is the only source.
    case 'product-titles': {
      const payload = items[0] || {};
      try {
        const merged = skuTitles.mergeTitles(payload.titles || {});
        // `missing` is TCINs redsky says do not exist. Forwarded even when no NEW name arrived,
        // because a SKU going missing is exactly the case where no name ever will.
        const titles = merged || skuTitles.getTitles();
        const missing = Array.isArray(payload.missing) ? payload.missing : [];
        const next = JSON.stringify({ titles, missing });
        if (next === lastSkuTitlePayload) break;
        lastSkuTitlePayload = next;
        toRenderer('targetSkuTitles', { titles, missing });
      } catch (e) { log('[target] sku names: ' + e.message); }
      break;
    }
    case 'update-status':
      for (const m of items) {
        if (!m) continue;
        const st = m.status || '';
        if (!st) continue;
        // taskID is set by BaseTask.UpdateStatus (bot-base/task/schema.go). Routing on it is what
        // puts each line on its own card; the monitor's own updates arrive under MONITOR_ID and
        // are mapped to '' so they show as module-level rather than inventing a phantom task.
        const rawId = m.taskID || '';
        if (String(rawId).startsWith('walmart-monitor-')) {
          if (st) walmartLog(st, '');
          continue;
        }
        const id = String(rawId).startsWith(MONITOR_ID) ? '' : rawId;
        if (engineTaskSites.resolve(m) === POKEMON_SITE) {
          pokemonStatus(st, m.color, '', id, m.state, m.running);
          pokemonLog(st, id);
          if (m.running === false && id) {
            pokemonTaskIds.delete(id);
            pokemonTaskConfigs.delete(id);
            engineTaskSites.remove(id);
            manualCaptchaManager.cancelTask(id);
            taskActive = runningTaskIds.size > 0 || pokemonTaskIds.size > 0 || walmartTaskIds.size > 0;
          }
          continue;
        }
        if (engineTaskSites.resolve(m) === WALMART_SITE) {
          walmartStatus(st, m.color, '', id, m.state, m.running);
          walmartLog(st, id);
          if (m.running === false && id) {
            walmartTaskIds.delete(id);
            walmartTaskConfigs.delete(id);
            engineTaskSites.remove(id);
            taskAccountById.delete(id);
            taskProfileById.delete(id);
            taskActive = runningTaskIds.size > 0 || pokemonTaskIds.size > 0 || walmartTaskIds.size > 0;
            reconcileWalmartMonitors();
          }
          continue;
        }
        status(st, m.color, '', id, m.state, m.running);
        if (m.running === false) acknowledgeLiveEditMonitorStop(rawId);
        const pendingMonitorStopAcknowledged = m.running === false
          || (targetMainMonitorPendingStopIds.has(rawId) && st === 'Idle');
        if (pendingMonitorStopAcknowledged) targetMainMonitorPendingStopIds.delete(rawId);
        const mainMonitorRejected = rawId === targetMainMonitorId && st === 'Cloud Disconnected';
        if (rawId === targetMainMonitorId && (m.running === false || mainMonitorRejected)) {
          const retryMainMonitor = mainMonitorRejected && runningTaskIds.size > 0;
          clearTargetMainMonitorState();
          if (retryMainMonitor) queueTargetMainMonitorSync();
        }
        // The Go engine does not acknowledge start-tasks. Its first task status is the earliest
        // authoritative proof that this id was accepted (duplicates and invalid profiles can be
        // dropped silently), so only then should it consume dynamic cookie-bank capacity.
        if (id && m.running === true && runningTaskIds.has(id)) acceptTargetCookieTasks([{ id }]);
        if (m.running === false && id) {
          runningTaskIds.delete(id);
          engineTaskSites.remove(id);
          taskProfileById.delete(id);
          taskCheckoutConfigById.delete(id);
          taskAccountById.delete(id);
          releaseTargetCookieTask(id);
          releaseLoginHarvesterTask(id);
          taskActive = runningTaskIds.size > 0 || pokemonTaskIds.size > 0 || walmartTaskIds.size > 0;
          if (targetMainMonitorRunning || !runningTaskIds.size) reconcileTargetMainMonitor();
        }
        // The monitor re-emits Getting Product(s) / Rotating Proxy every few seconds forever. Its
        // state is already shown live next to "Engine Log", so logging it as well just buries the
        // checkout task's own lines. Failures still come through (KEEP_IN_QUIET).
        const monitorChatter = !id && !verboseLogs() && !KEEP_IN_QUIET.test(st);
        if (!monitorChatter) log(st, id);
      }
      break;
    // DEAD as of 2026-07-31, kept only so a future engine that does emit this outer type still has a
    // handler. The Go engine wraps notifications as "task-notification" with the kind in m.type, so
    // nothing has ever reached here — see the reporting + cap bookkeeping in that case above, which
    // is where a Target checkout actually lands.
    case 'product': {
      const m = items[0] || {};
      const id = m.taskID || '';
      status('Checked Out', '#34ca6e', 'order placed', id);
      log('CHECKED OUT: ' + JSON.stringify(m), id);
      // Report to the dashboard + global collector (tagged with the key owner's
      // Discord). The Go engine posts its own embed but can't know who is running
      // it, so the Buyer tagging has to happen here. Fire-and-forget by design:
      // a reporting failure must never affect the checkout itself.
      try {
        reporter.report({
          site: 'target',
          status: 'success',
          product: String(m.title || m.name || m.tcin || m.productId || '').slice(0, 200),
          price: Number(m.price || m.total || m.grandTotal || 0),
          account: taskAccountById.get(id) || '',
          order: String(m.orderNumber || m.order || '').slice(0, 60),
          qty: Number(m.qty || m.quantity || 1),
        });
      } catch (e) { log('[report] ' + e.message, id); }
      // Record the order so the 2-per-4h-per-account cap can see it. Done here rather than in the
      // UI because this is the only place a confirmed order is observed, and the cap must hold
      // even if the window is closed at the moment it lands.
      try {
        const acct = taskAccountById.get(id);
        const tcin = String(m.tcin || m.productId || m.id || '').trim();
        if (acct && tcin) {
          dm.recordTargetOrder(acct, tcin);
          const used = dm.recentTargetOrders(acct, tcin).length;
          log(`[limit] order recorded — ${used}/${dm.ORDER_LIMIT_MAX} for this account on ${tcin} in the last 4h`, id);
        }
      } catch (e) { log('[limit] record failed: ' + e.message, id); }
      break;
    }
    case 'monitor-bandwidth':
      for (const m of items) {
        try {
          const telemetry = engineContract.normalizeMonitorBandwidth(m);
          toRenderer('targetMonitorBandwidth', telemetry);
          const completedStop = trackTargetMonitorBandwidth(telemetry);
          if (completedStop) forcePendingTargetEngineStop(completedStop);
        } catch (_) {
          // Keep malformed native telemetry—and any sensitive unknown fields it may contain—out
          // of both the renderer and logs.
          vlog('[target] ignored invalid monitor bandwidth telemetry');
        }
      }
      break;
    case 'analytics-event':
      for (const m of items) {
        if (!analyticsRecorder.record(m)) log('[analytics] event was not recorded');
        const outcomeType = String((m && m.eventType) || '').toLowerCase();
        if (m && ['carted', 'checkout', 'decline'].includes(outcomeType)
          && engineTaskSites.resolve(m) === engineContract.SITES.TARGET) {
          toRenderer('targetOutcome', {
            eventId: m.eventId || '', eventType: outcomeType, taskId: m.taskId || '',
            occurredAt: m.occurredAt,
          });
        }
      }
      break;
    case 'task-telemetry':
      // Counters only (cart attempts, Shape blocks, ...). No product or account data.
      for (const m of items) {
        if (!m || typeof m !== 'object') continue;
        analyticsRecorder.recordTelemetry({ ...m, engineVersion: m.engineVersion || runningEngineVersion });
      }
      break;
    case 'task-notification':
      for (const m of items) {
        if (!m || typeof m === 'string') { log('[notify] ' + String(m || '')); continue; }
        const notificationTaskId = m.taskID || '';
        if (engineTaskSites.resolve(m) === POKEMON_SITE) {
          pokemonLog('[notify] ' + String(m.type || 'event') + (m.productName ? ': ' + m.productName : ''), notificationTaskId);
          if (m.type === 'checkout' || m.type === 'declined') {
            const ok = m.type === 'checkout';
            pokemonStatus(ok ? 'Successful' : 'Payment Declined', ok ? '#34ca6e' : '#fb5454', m.productName || '', notificationTaskId, ok ? 3 : 4);
            try {
              reporter.report({
                site: 'pokemoncenter', status: ok ? 'success' : 'failed',
                product: String(m.productName || '').slice(0, 200), price: Number(m.price) || 0,
                account: m.profileName || '', order: String(m.orderNumber || '').slice(0, 60), qty: 1,
                image: String(m.productImage || ''),
                size: String(m.size || ''),
              });
            } catch (e) { pokemonLog('[report] ' + e.message, notificationTaskId); }
          }
          continue;
        }
        if (engineTaskSites.resolve(m) === WALMART_SITE) {
          walmartLog('[notify] ' + String(m.type || 'event') + (m.productName ? ': ' + m.productName : ''), notificationTaskId);
          if (m.type === 'checkout' || m.type === 'declined') {
            const ok = m.type === 'checkout';
            walmartStatus(ok ? 'Successful' : 'Payment Declined', ok ? '#34ca6e' : '#fb5454', m.productName || '', notificationTaskId, ok ? 3 : 4);
            try {
              const cfg = walmartTaskConfigs.get(notificationTaskId) || {};
              reporter.report({
                site: 'walmart', status: ok ? 'success' : 'failed',
                product: String(m.productName || '').slice(0, 200), price: Number(m.price) || 0,
                account: taskAccountById.get(notificationTaskId) || m.profileName || '',
                order: String(m.orderNumber || '').slice(0, 60),
                qty: Number(cfg.quantity) || 1,
                sku: String(m.sku || ''),
                url: String(m.productLink || ''),
                image: String(m.productImage || ''),
              });
            } catch (e) { walmartLog('[report] ' + e.message, notificationTaskId); }
          }
          continue;
        }
        log('[notify] ' + JSON.stringify(m));
        // THIS is where a Target checkout actually arrives. The Go engine wraps every notification
        // as an outer "task-notification" and puts the real kind in m.type, so the `case 'product'`
        // below — which held the reporter call and the order-cap bookkeeping — never ran once.
        // Symptom: Bandai orders reached the collector webhook and Target orders silently did not,
        // and the per-account cap has never counted a single order.
        if (m.type !== 'checkout' && m.type !== 'declined') continue;
        const tid = m.taskID || '';
        const ok = m.type === 'checkout';
        try {
          reporter.report({
            site: 'target',
            status: ok ? 'success' : 'failed',
            product: String(m.productName || '').slice(0, 200),
            price: Number(m.price) || 0,
            account: taskAccountById.get(tid) || m.accountId || m.profileName || '',
            order: String(m.orderNumber || '').slice(0, 60),
            qty: Number((taskCheckoutConfigById.get(tid) || {}).qty) || 1,
            sku: String(m.sku || ''),
            url: m.sku ? `https://www.target.com/p/-/A-${m.sku}` : '',
            // Which harvester minted the Shape cookie this checkout actually used. Collector-only:
            // the per-browser yield line says which browser BANKS the most cookies, this says which
            // one converts. They are not the same question, and only the second one is worth money.
            source: String(m.source || ''),
            image: String(m.productImage || ''),
            size: String(m.size || ''),
          });
        } catch (e) { log('[report] ' + e.message, tid); }
        // The 2-per-4h-per-account cap only works if confirmed orders are counted, and this is the
        // one place a confirmed order is observed. Done here rather than in the UI so it holds even
        // with the window closed.
        if (ok) {
          try {
            const acct = taskAccountById.get(tid) || m.accountId || '';
            const tcin = String(m.sku || '').trim();
            // Both halves are required: the cap is keyed on (account, TCIN), so recording under a
            // product NAME would write a key targetOrderLimitReached() never reads — worse than not
            // recording, because it would look enforced while doing nothing.
            if (acct && tcin) dm.recordTargetOrder(acct, tcin);
            else log(`[cap] not counted — ${acct ? 'no TCIN on the notification' : 'no account for task ' + tid}`, tid);
            enforceTargetLoopCheckout(tid, acct, tcin);
          } catch (e) { log('[cap] ' + e.message, tid); }
        }
      }
      break;
    case 'update-input':
      for (const m of items) {
        if (!m || engineTaskSites.resolve(m) !== POKEMON_SITE) continue;
        toRenderer('pokemonInput', {
          taskId: m.taskID || '', productName: m.productName || '', productSize: m.productSize || '',
        });
      }
      break;
    case 'task-log':
      for (const m of items) {
        if (!m) continue;
        const decoded = decodeNativeTaskLog(m.data);
        if (!decoded) continue;
        const site = engineTaskSites.resolve(m);
        if (site === POKEMON_SITE) {
          const queueMonitorLog = decoded.startsWith('[queue-monitor]');
          pokemonLog(devLogs() || queueMonitorLog ? decoded : 'Pokemon Center returned an unexpected response; retrying', m.taskID || '');
          continue;
        }
        if (site === WALMART_SITE) {
          walmartLog(decoded, m.taskID || m.taskId || '');
          continue;
        }
        if (site === engineContract.SITES.TARGET) log(decoded, m.taskID || m.taskId || '');
      }
      break;
    case 'request-code':
      for (const m of items) {
        const email = (m && m.email) || '';
        const tid = (m && m.taskID) || '';
        // The native engine waits for this acknowledgement before it starts its own OTP timeout.
        // Acknowledge synchronously so mailbox latency cannot consume that readiness window.
        if (m && m.requestId) {
          sendToEngine({ type: 'code-watcher-ready', messages: [{ requestId: String(m.requestId) }] });
        }
        log('[otp] verification code needed for ' + email + ' — checking mailbox, or enter it above', tid);
        fetchOtpAndDeliver(email, tid);   // async: fetch via AYCD/IMAP, send received-code
      }
      break;
    case 'account-cookie':
      // Engine emitted the account's session cookie after login — persist it so future runs skip the
      // whole OTP login and just refresh the (long-lived) session.
      for (const m of items) {
        if (m && m.accountId && typeof m.cookie === 'string') {
          try {
            dm.setAccountCookie(m.accountId, m.cookie);
            log('[session] saved account session (' + m.cookie.length + ' chars) — future runs skip login');
            signalFarmerSessionReady();
            try { toRenderer('accountsUpdated', dm.getAccounts()); } catch {}
          } catch (e) { log('[session] save failed: ' + e.message); }
        }
      }
      break;
    case 'solve-captcha':
      // Isolated Pokemon Center hCaptcha window. AutoSolve classifies the first grid when a model
      // exists; a miss hands the next challenge to the user. The token returns on this engine connection.
      manualCaptchaManager.handleEnvelope(msg, {
        registry: engineTaskSites,
        send: sendToEngine,
        isActive: () => engineConn === connection,
        autosolveEnabled: () => {
          try { return (dm.getSettings() || {}).hcaptchaAutosolve !== false; }
          catch { return true; }
        },
        parent: win,
        logger: { warn: message => log(String(message)) },
      });
      break;
    case 'hyper-request':
      // The native process receives neither the license bearer nor the Hyper credential. Its
      // correlated request is resolved here through the main-process license authority.
      nativeHyperBroker.handleEnvelope(msg, {
        registry: engineTaskSites,
        send: sendToEngine,
        isActive: () => engineConn === connection,
        logger: { warn: message => log(String(message)) },
      });
      break;
    default:
      // stuckInCart / account-cookie / update-input / update-status variants: ignore for the UI
      break;
  }
}

// ── server lifecycle ─────────────────────────────────────────────────────────────
// ENGINE_PORT is a PREFERENCE, not a requirement. Nothing outside this app reads it — the only
// consumer is backend.exe, which we spawn ourselves and hand `-port` — so if something already holds
// it we can simply bind a free one instead of dying.
//
// The old version assigned `wss` before knowing whether the bind succeeded and never cleared it on
// error, so a single EADDRINUSE latched `if (wss) return` on forever: the bridge was dead, no engine
// ever connected, the pending Target queue was never flushed, and every task card sat on "Starting" for the rest
// of the session. Restarting the app hit the identical wall.
//
// onReady fires once the socket is actually listening — callers must sequence spawns behind it,
// because the port is not known until then.
function ensureServer(onReady) {
  if (wss && boundPort) { if (onReady) onReady(); return; }
  if (onReady) serverWaiters.push(onReady);
  if (wss) return;                       // a bind is already in flight; the waiter above covers us
  bindServer(ENGINE_PORT);
}

function bindServer(port) {
  // Cleared up front: a stale value from a previous bind would make the error handler below read a
  // fresh bind failure as "already listening" and skip the free-port fallback.
  boundPort = 0;
  let s;
  try {
    s = new WebSocket.Server({ host: '127.0.0.1', port });
  } catch (err) {
    log('engine server error: ' + err.message);
    serverWaiters.length = 0;
    failNativeEngineRuns('engine bridge: ' + (err.code || err.message), true);
    return;
  }
  wss = s;
  s.on('listening', () => {
    boundPort = s.address().port;
    if (boundPort !== ENGINE_PORT) log(`[target] engine bridge on port ${boundPort}`);
    const waiters = serverWaiters.splice(0);
    for (const cb of waiters) { try { cb(); } catch (e) { log('bridge ready callback: ' + e.message); } }
  });
  s.on('connection', (ws, req) => {
    // The engine now presents identity: the per-launch token, in a header only our own children can
    // read. Before this, the first process to open a socket on 127.0.0.1:8727 BECAME the engine and
    // flushStart() handed it the task payload — proxy pool, account password, card number and CVV.
    // The single-connection guard below never protected against that; it only stopped a second one
    // once a first had already won. Compared with timingSafeEqual so the check cannot be walked byte
    // by byte, and length-checked first because timingSafeEqual throws on a length mismatch.
    const sent = Buffer.from(String((req && req.headers && req.headers['x-zyn-token']) || ''), 'utf8');
    const want = Buffer.from(SHAPE_TOKEN, 'utf8');
    if (sent.length !== want.length || !crypto.timingSafeEqual(sent, want)) {
      log('[target] refused an unauthenticated connection to the engine bridge');
      try { ws.close(); } catch {}
      return;
    }
    // Refuse a second engine while one is already attached, so a Stop cannot be routed to the wrong
    // process — leaving the other one running tasks nobody can reach.
    if (engineConn && engineConn.readyState === WebSocket.OPEN) {
      log('[target] refused a second engine connection — one is already attached');
      try { ws.close(); } catch {}
      return;
    }
    engineConn = ws;
    vlog('engine connected');
    ws.on('message', data => handleEngineMessage(data, ws));
    ws.on('close', () => {
      if (engineConn === ws) {
        engineConn = null;
        nativeHyperBroker.cancelPending();
        manualCaptchaManager.cancelPending();
      }
    });
    ws.on('error', () => {});
    if (targetMainMonitorPendingStopIds.size) sendPendingTargetMainMonitorStop();
    let flushed = false;
    if (pendingTargetStarts.length) { flushStart(); flushed = true; }
    if (pendingPokemonStarts.length) { flushPokemonStarts(); flushed = true; }
    if (pendingWalmartStarts.length) { flushWalmartStarts(); flushed = true; }
    // An engine that reconnects — or a respawned one — comes up with empty profile/account/proxy
    // maps, because they live in that process and nothing on this side re-sent them. Any task still
    // running would fail its next rotation with "invalid group". Push what it should already have.
    if (!flushed && (Object.keys(sentConfigs.profiles).length || Object.keys(sentConfigs.proxies).length || Object.keys(sentConfigs.accounts).length)) {
      vlog('engine reconnected — re-sending configs');
      sendConfigs();
    }
    if (targetMainMonitorNeedsSync && runningTaskIds.size) reconcileTargetMainMonitor();
  });
  s.on('error', (err) => {
    if (boundPort) { log('engine server error: ' + err.message); return; }   // already listening: not a bind failure
    try { s.close(); } catch {}
    if (wss === s) wss = null;
    if (err.code === 'EADDRINUSE' && port !== 0) {
      log(`[target] port ${port} is busy — using a free port instead`);
      bindServer(0);                     // 0 = let the OS pick; backend.exe is told which one
      return;
    }
    log('engine server error: ' + err.message);
    serverWaiters.length = 0;            // nothing will ever be ready; don't leave spawns queued
    failNativeEngineRuns('engine bridge: ' + (err.code || err.message), true);
  });
}

function spawnEngine() {
  if (engineProc) return;
  const exe = enginePath();
  if (!fs.existsSync(exe)) {
    status('Error', '#fb5454', 'engine binary not found');
    log('ENGINE NOT FOUND: ' + exe + ` — build it with:  cd backend && go build -o ${plat.engineBin()} .`);
    failNativeEngineRuns('engine binary not found', true);
    return;
  }
  const engineVersion = exe === process.env.ZYN_ENGINE_PATH
    ? String(process.env.ZYN_ENGINE_VERSION || 'downloaded') : (bundledEngineVersion() || 'bundled');
  log('[target] starting native engine ' + engineVersion);
  try {
    engineProc = spawn(exe, ['-port', String(boundPort || ENGINE_PORT), '-key', 'local'], {
    cwd: path.dirname(exe),
    // stdin is a real pipe so the engine can watch it for EOF and exit when this process dies.
    // Without it a crash left backend.exe running with live task goroutines — and because it holds
    // no listening port, nothing here could find it; it just kept dialling and re-attached to the
    // NEXT launch's bridge, where it would receive profiles and cards and check out unsupervised.
    stdio: ['pipe', 'pipe', 'pipe'],
    // This process spawns BOTH the engine and the farmer, so it is the only place that can keep
    // them agreeing on the broker port. The engine used to hardcode its own copy, which meant
    // moving the farmer silently left the engine polling a dead port.
    env: { ...process.env, ZYN_SHAPE_PORT: String(SHAPE_PORT), ZYN_SHAPE_TOKEN: SHAPE_TOKEN, ZYN_PARENT_WATCH: '1' },
    // posix only: makes the engine a process-group leader so killTree can take down it AND anything
    // it spawned. No-op on Windows, where taskkill /T walks the tree instead. The stdin-EOF watchdog
    // above stays the backstop for a parent crash, which detaching would otherwise leave orphaned.
    ...plat.spawnOpts(),
    });
    runningEngineVersion = engineVersion;
  } catch (err) {
    engineProc = null;
    runningEngineVersion = '';
    log('engine spawn error: ' + err.message);
    failNativeEngineRuns('engine spawn error: ' + err.message, true);
    return;
  }
  const spawnedEngine = engineProc;
  // The engine prints a timestamped line for EVERY status change and request on every task and the
  // monitor. The same information already reaches the UI as structured update-status messages that
  // land on the right card, so relaying the raw stream too is pure duplication in quiet mode.
  const relay = (chunk) => {
    String(chunk).split(/\r?\n/).forEach((l) => {
      const t = l.trim();
      if (t && (verboseLogs() || KEEP_IN_QUIET.test(t))) log('[engine] ' + t);
    });
  };
  engineProc.stdout.on('data', relay);
  engineProc.stderr.on('data', relay);
  engineProc.on('error', (err) => {
    log('engine spawn error: ' + err.message);
    const ownsCurrentProcess = engineProc === spawnedEngine
      || (pendingTargetEngineStop && pendingTargetEngineStop.proc === spawnedEngine);
    if (!ownsCurrentProcess) return;
    if (engineProc === spawnedEngine) {
      engineProc = null;
      runningEngineVersion = '';
    }
    finishTargetEngineStop(spawnedEngine);
    failNativeEngineRuns('engine spawn error: ' + err.message, true);
  });
  engineProc.on('exit', (code) => {
    // Retire this process's socket before evaluating either graceful or unexpected cleanup.
    // Otherwise a start arriving between child exit and WebSocket close can flush into the dead
    // connection and the replacement can be rejected as a second engine.
    const ownsCurrentProcess = engineProc === spawnedEngine
      || (pendingTargetEngineStop && pendingTargetEngineStop.proc === spawnedEngine);
    if (!ownsCurrentProcess) return;
    const stoppedConnection = engineConn;
    engineConn = null;
    try { if (stoppedConnection) stoppedConnection.close(); } catch {}
    const gracefulStop = finishTargetEngineStop(spawnedEngine);
    if (engineProc === spawnedEngine) {
      engineProc = null;
      runningEngineVersion = '';
    }
    if (gracefulStop) {
      if (!quitting && (pendingTargetStarts.length || pendingPokemonStarts.length || pendingWalmartStarts.length)) {
        setImmediate(() => {
          if (!quitting && !engineProc && (pendingTargetStarts.length || pendingPokemonStarts.length || pendingWalmartStarts.length)) spawnEngine();
        });
      }
      return;
    }
    if (taskActive || runningTaskIds.size || pokemonTaskIds.size || walmartTaskIds.size || targetMainMonitorRunning
        || activeMonitorBandwidthRuns.size || pendingTargetStarts.length || pendingPokemonStarts.length || pendingWalmartStarts.length) {
      log('engine exited (code ' + code + ')');
      failNativeEngineRuns('Native engine exited', false);
    }
  });
}

// ── public API (called from electron.js IPC handlers) ────────────────────────────
// config: { tasks: [{ id, accountId, profileId, proxyListName }], skus: [...], qty }
function startTarget(config, mainWindow) {
  attachWindow(mainWindow);
  queueTargetStart(config);
  // A restarted task gets a fresh mailbox fetch, while additive starts must not cancel OTP polling
  // for sibling tasks that are already running.
  for (const t of (config.tasks || [])) cancelOtpForTask(t.id, 'Target task restarted');
  // Only the tasks in this start. A sibling already running may have a pending status in the
  // coalescer; dropping everyone would swallow that update on an additive Start.
  // Drop coalesced + last-seen keys only for this batch. Wiping every key made an additive
  // Start All re-paint cards that were already Waiting For Restock.
  forgetStatusKeys((config.tasks || []).map(task => task && task.id));
  for (const t of (config.tasks || [])) statusCoalescer.drop(t.id);
  // Paint Starting before proxy-list parsing. Resolving the same large list once per task was
  // enough to leave Start All blank for several seconds on Windows.
  const skuMeta = skuMetaFromItems(config.items);
  const skus = [...new Set((config.skus || []).map(sku => String(sku || '').trim()).filter(Boolean))];
  const qty = Math.max(1, parseInt(config.qty, 10) || 2);
  const ignoreLowStock = config.ignoreLowStock === true || config.stockConfidence === 'confirmed-10-plus';
  for (const t of (config.tasks || [])) {
    runningTaskIds.add(t.id);
    engineTaskSites.register(t.id, engineContract.SITES.TARGET);
    taskAccountById.set(t.id, t.accountId || '');
    taskProfileById.set(t.id, t.profileId || '');
    status('Starting', '#868686', 'launching engine', t.id, 1, true);
  }
  latchLoginHarvesterForTasks(config.tasks);
  flushStartingStatuses(statusCoalescer);
  const proxySourcesByRef = new Map();
  for (const t of (config.tasks || [])) {
    const proxyListName = String(t.proxyListName || '').trim();
    const proxyKey = proxyListName;
    if (!proxySourcesByRef.has(proxyKey)) proxySourcesByRef.set(proxyKey, sourceNamesFor(t.proxyListName));
    taskCheckoutConfigById.set(t.id, {
      skus,
      ...skuMeta,
      qty,
      proxyListName,
      proxySources: proxySourcesByRef.get(proxyKey),
      loopCheckout: (t.loopCheckout != null ? t.loopCheckout === true : t.repeatCheckout === true) || config.endless === true,
      ignoreLowStock,
    });
  }
  // Binding is asynchronous now (it may fall back to a free port), and the engine has to be told
  // which port it got — so the spawns move inside the ready callback. `seq` guards the gap: if the
  // user presses Stop while the socket is still binding, stopTarget bumps startSeq and this callback
  // becomes a no-op instead of spawning an engine into a run that no longer exists.
  const seq = ++startSeq;
  ensureServer(() => {
    if (seq !== startSeq) return;
    // The farmer takes the first task's proxy/account — it only needs SOME Target-capable proxy set
    // and one real account to log in with; the cookie pool it fills is shared by every task
    // regardless of whose proxy minted it. `sku` only feeds the farmer's --tcin fallback, which is
    // unused whenever --atcTcins is populated (it always is), but pass it so the flag isn't empty.
    const first = (config.tasks || [])[0] || {};
    // The farmer gets its OWN pool. It used to take tasks[0]'s, which meant the pool that minted
    // every cookie in the shared bank depended on task ordering — and if the first task happened to
    // be Local, every cookie was farmed on the operator's home IP and every other task then adopted
    // it at add-to-cart. Falls back to the old behaviour when unset so nothing changes for anyone
    // who never picks one.
    let harvesterPool = first.proxyListName || '';
    try {
      const hp = (dm.getSettings() || {}).targetHarvesterProxyList;
      if (typeof hp === 'string') harvesterPool = hp;
    } catch {}
    if (managedHarvesterMode()) {
      // Managed harvesters pre-farm independently. Starting checkout only reconciles them and the
      // shared broker; it does not create a task-owned producer.
      ensureHarvesterBroker();
    } else {
      startFarmer({
        proxyListName: harvesterPool,
        accountId: first.accountId || '',
        profileId: first.profileId || '',
        sku: (config.skus || [])[0] || '',
      });
    }
    spawnEngine();
    // If the engine is already connected from a previous run this session, go now.
    if (engineConn && engineConn.readyState === WebSocket.OPEN) flushStart();
  });
}

// Empty / omitted => stop everything (engine, farmer, monitor). A string or array of ids stops
// only those tasks in one engine message. Empty arrays are a no-op so a UI bug cannot tear down
// every running checkout.
function normalizeTargetStopIds(taskId) {
  if (taskId == null || taskId === '') return null;
  const raw = Array.isArray(taskId) ? taskId : [taskId];
  return [...new Set(raw.map(value => String(value || '')).filter(Boolean))];
}

function notifyTargetDone(ids) {
  if (!ids.length) return;
  if (ids.length === 1) toRenderer('targetDone', { taskId: ids[0] });
  else toRenderer('targetDone', { taskIds: ids });
}

function releaseStoppedTargetTask(id) {
  removePendingTargetStartTask(id);
  runningTaskIds.delete(id);
  releaseTargetCookieTask(id);
  engineTaskSites.remove(id);
  taskProfileById.delete(id);
  taskCheckoutConfigById.delete(id);
  taskAccountById.delete(id);
  cancelOtpForTask(id);
  manualCaptchaManager.cancelTask(id);
  statusCoalescer.drop(id);
  releaseLoginHarvesterTask(id);
}

function stopTarget(taskId) {
  const requested = normalizeTargetStopIds(taskId);
  if (Array.isArray(requested) && !requested.length) return;
  if (requested) {
    if (engineConn) sendToEngine({ type: 'stop-tasks', messages: requested.map(id => ({ id })) });
    for (const id of requested) releaseStoppedTargetTask(id);
    notifyTargetDone(requested);
    flushLogs();
    if (runningTaskIds.size) {
      if (targetMainMonitorRunning) reconcileTargetMainMonitor();
      return;
    }
  }

  startSeq += 1;
  farmerWanted = null;
  clearPendingTargetStarts();
  if (targetMainMonitorId) targetMainMonitorPendingStopIds.add(targetMainMonitorId);
  stopLiveEditMonitor();
  const mainMonitorIds = [...targetMainMonitorPendingStopIds];
  if (engineConn) {
    const ids = [...runningTaskIds].map(id => ({ id }));
    if (ids.length) sendToEngine({ type: 'stop-tasks', messages: ids });
    if (mainMonitorIds.length) sendToEngine({
      type: 'stop-tasks', messages: mainMonitorIds.map(id => ({ id })),
    });
  }
  clearTargetMainMonitorState();
  cancelAllOtpFetches();
  statusCoalescer.dropAll();
  flushLogs();
  for (const id of runningTaskIds) {
    engineTaskSites.remove(id);
    taskProfileById.delete(id);
    taskCheckoutConfigById.delete(id);
    taskAccountById.delete(id);
    manualCaptchaManager.cancelTask(id);
    toRenderer('targetDone', { taskId: id });
  }
  runningTaskIds.clear();
  loginLatchedTaskIds.clear();
  lastTargetTaskStatusText.clear();
  clearLoginHarvesterState();
  clearTargetCookieTasks();
  taskCheckoutConfigById.clear();
  toRenderer('targetDone', { taskId: '' });

  if (!managedHarvesterMode()) {
    const deadFarmerPid = farmerProc && farmerProc.pid;
    killTree(farmerProc);
    farmerProc = null;
    sweepOrphanHarvesters(deadFarmerPid);
    brokerOnly = false;
  }
  if (!quitting) ensureHarvesterBroker();
  if (pokemonTaskIds.size || walmartTaskIds.size) { taskActive = true; return; }

  targetMainMonitorPendingStopIds.clear();
  taskActive = false;
  nativeHyperBroker.cancelPending();
  manualCaptchaManager.cancelPending();
  beginTargetEngineStop(engineProc);
}

// Called from the app's quit handler. Sets the one-way quitting flag first so nothing queued can
// respawn behind us, then kills the children and closes the bridge socket. `wss` is created once
// behind `if (wss) return` and was never closed anywhere, so without this the listening socket
// outlived every task and only died with the process.
function shutdown() {
  quitting = true;
  try { stopWalmart(); } catch {}
  try { stopTarget(); } catch {}
  try { stopPokemonCenter(); } catch {}
  clearLoginHarvesterState();
  if (targetCookieDemandRetryTimer) clearTimeout(targetCookieDemandRetryTimer);
  targetCookieDemandRetryTimer = null;
  if (harvesterSyncTimer) clearInterval(harvesterSyncTimer);
  harvesterSyncTimer = null;
  for (const id of [...harvesterProcs.keys()]) stopHarvesterProducer(id);
  try { killTree(farmerProc); } catch {}
  farmerProc = null;
  brokerOnly = false;
  try { if (wss) wss.close(); } catch {}
  wss = null;
  boundPort = 0;
  engineConn = null;
  nativeHyperBroker.cancelPending();
  manualCaptchaManager.cancelPending();
}

// Cookie bank readout for the UI. The broker already reports its pool sizes on GET /status, so this
// is a straight passthrough rather than a second source of truth that could drift from it. Returns
// null when the broker isn't up, which the UI renders as "offline" instead of a misleading zero —
// an empty pool and no pool at all are very different problems.
// The upstream broker exposes aggregate health but not a success timestamp. The persisted bank already
// timestamps every signature, so expose only the newest timestamp; cookie headers and proxy values
// remain confined to the main process.
function latestBankedAt() {
  try {
    const saved = JSON.parse(fs.readFileSync(bankFile(), 'utf8'));
    let latest = 0;
    for (const type of ['login', 'atc']) {
      for (const entry of (saved.pool && saved.pool[type]) || []) {
        latest = Math.max(latest, Number(entry && entry.at) || 0);
      }
    }
    return latest;
  } catch { return 0; }
}

function getCookieBank() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: SHAPE_PORT, path: '/status', timeout: 1200 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          resolve({
            login: j.pools?.login || 0,
            atc: j.pools?.atc || 0,
            proxies: j.proxies || 0,
            harvesters: Array.isArray(j.harvesters) ? j.harvesters : [],
            sessionReady: j.sessionReady === true,
            inFlight: j.inFlight || { login: 0, atc: 0 },
            activity: j.activity || null,
            health: j.health || null,
            demand: j.demand || targetCookieDemand(),
            replay: j.replay || null,
            lastBankedAt: latestBankedAt(),
          });
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}


// A stock ping from the SHARED Discord monitor. Forwarded straight to the Go engine's monitor hub,
// which is the same place its own polling monitor publishes to — so a task waiting on stock cannot
// tell the two apart, and no engine code needed changing to accept it.
//
// The payload deliberately does not include a URL. Mega Notify's "Open In App" is a redirector, not
// a PDP, and the engine must never navigate somewhere a Discord embed chose.
function sendStockPing(p) {
  if (!p || !p.sku) return false;
  return sendToEngine({
    type: 'stock-ping',
    messages: [{
      site: p.site,
      productKey: String(p.sku),
      name: String(p.name || '').slice(0, 160),
      image: '',
      price: Number(String(p.price || '').replace(/[^0-9.]/g, '')) || 0,
      stockLevel: Number.isFinite(p.stock) ? p.stock : 0,
      inStock: true,
      from: String(p.from || 'discord-monitor').slice(0, 80),
    }],
  });
}

// How many Target tasks are live. Read by the license heartbeat so the operator's dashboard can
// show who is running what without having to ask anyone.
function isTaskRunning(taskId) { return runningTaskIds.has(String(taskId || '')); }
function runningCount() { return runningTaskIds.size; }

// Product names for the watch list, supplied by the ENGINE.
//
// There is no app-side lookup: redsky fingerprints the TLS handshake, so a plain request from here
// is answered with `403 {"captchaRelativeURL": ...}` whichever proxy carries it — verified against a
// clean residential exit, which was refused exactly like the home IP. The monitor already parses
// these titles out of every poll, so they arrive over the bridge instead (case 'product-titles').
function getSkuTitles() {
  try { return skuTitles.getTitles(); } catch { return {}; }
}

// Live proxy switch for one running task.
//
// Nothing between add-to-cart and check-order re-pins the connection, so a switch made during the
// checkout phase holds for the rest of the order — the point being to get off an IP that Target is
// throttling (DCO_RATE_LIMITED / 429) without losing the cart to a restart.
//
// Returns false when the engine is not connected, so the UI can tell "sent" from "the task will pick
// this up next time it starts" rather than reporting success either way.
function setTaskProxy(taskId, proxyListName) {
  if (!taskId) return false;
  if (!runningTaskIds.has(taskId)) return false;   // not running: the stored value is enough
  // Same mapping as start-tasks: the engine treats the empty string as a real group name and kills
  // the task with "Error Assigning Proxy", so "no proxy" has to travel as the literal "Local".
  const group = groupOf(proxyListName);
  const proxySources = sourceNamesFor(proxyListName);
  if (group !== 'Local') {
    Object.assign(sentConfigs.proxies, buildProxyMap(proxyListName));
    sendConfigs();
  }
  const existing = taskCheckoutConfigById.get(taskId) || {};
  taskCheckoutConfigById.set(taskId, { ...existing, proxyListName: String(proxyListName || '').trim(), proxySources });
  return sendToEngine({ type: 'set-task-proxy', messages: [{ id: taskId, proxyGroup: group, proxySources }] });
}

module.exports = { startTarget, stopTarget, editTargetTasks, startPokemonCenter, stopPokemonCenter, editPokemonCenter, setPokemonCenterTaskProxy, runningPokemonCenterCount, startWalmart, stopWalmart, editWalmart, setWalmartTaskProxy, setPokemonQueueStreamHealth, setSolverLucaKey, publishPokemonQueueProtection, shutdown, ensureHarvesterBroker, saveHarvesterCookie, syncTargetHarvesters, setTargetHarvestAuthorized, setTargetCookieStandbyTasks, syncTargetCookieBankDemand, targetCookieDemand, getCookieBank, submitOtpManually, sendStockPing, isTaskRunning, runningCount, setTaskProxy, getSkuTitles, getEngineInfo, logMonitorLine };
