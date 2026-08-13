#!/usr/bin/env node
'use strict';

// R6 keeps the recovered R5 engines as the source of truth. These narrow replacements route OTP
// reads through the profile-owned mailbox API and opt the Target farmer
// into New Headless. Refuse unknown inputs so a future engine update cannot be silently rewritten
// with stale assumptions.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const helperDirectory = path.resolve(process.argv[2] || '');
if (!helperDirectory || !fs.existsSync(helperDirectory)) {
  console.error('Usage: patch-profile-imap-engines.js <public/helpers directory>');
  process.exit(2);
}

const SOURCES = Object.freeze({
  'target-engine.js': 'f43ff08d23fa8f4db55f8b1d2f12b76017f671eb5c33a785dc7110c9a075426d',
  'plain-log.js': '519f4e8034889a6887e31272ed14cb01dd5ae752075e675cd2a22582970c43fd',
});

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function openSource(filename) {
  const file = path.join(helperDirectory, filename);
  const raw = fs.readFileSync(file);
  const actual = sha256(raw);
  if (actual !== SOURCES[filename]) {
    throw new Error(`${filename} source hash ${actual} does not match the reviewed R5 source ${SOURCES[filename]}`);
  }
  return { file, newline: raw.includes(Buffer.from('\r\n')) ? '\r\n' : '\n', source: raw.toString('utf8').replace(/\r\n/g, '\n') };
}

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first === -1) throw new Error(`Could not find ${label}`);
  if (source.indexOf(before, first + before.length) !== -1) throw new Error(`Found ${label} more than once`);
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function replaceCount(source, before, after, expected, label) {
  const count = source.split(before).length - 1;
  if (count !== expected) throw new Error(`Expected ${expected} ${label} occurrence(s), found ${count}`);
  return source.split(before).join(after);
}

function replaceSection(source, start, end, replacement, label) {
  const first = source.indexOf(start);
  if (first === -1) throw new Error(`Could not find start of ${label}`);
  const last = source.indexOf(end, first + start.length);
  if (last === -1) throw new Error(`Could not find end of ${label}`);
  if (source.indexOf(start, first + start.length) !== -1) throw new Error(`Found start of ${label} more than once`);
  return source.slice(0, first) + replacement + source.slice(last);
}

function saveSource(opened) {
  const output = opened.newline === '\r\n' ? opened.source.replace(/\n/g, '\r\n') : opened.source;
  fs.writeFileSync(opened.file, output, 'utf8');
}

function patchTarget() {
  const opened = openSource('target-engine.js');
  let source = opened.source;

  // The packaged farmer defaults to New Headless too, but pass it explicitly from Zyn
  // so the selected display mode is unambiguous in the spawned process command line.
  source = replaceOnce(source, `'--headless=false'`, `'--headless=true'`, 'Target farmer New Headless mode');

  source = replaceOnce(source, `const plat = require('./platform');`, `const plat = require('./platform');
// Packaged bot scripts reuse Electron as native Node.
const { nodeEnvironment, nodeExecutable } = require('./runtime-paths');`, 'Target native farmer runtime import');

  source = replaceOnce(source, `function enginePath() {
  const packed = process.resourcesPath && path.join(process.resourcesPath, 'engine', plat.engineBin());
  if (packed && fs.existsSync(packed)) return packed;
  return path.join(__dirname, '..', '..', 'backend', plat.engineBin());
}`, `function enginePath() {
  // The runtime manager installs engines side by side and changes this pointer only for future
  // spawns. A child that already owns tasks keeps its original executable and process image.
  const downloaded = String(process.env.ZYN_ENGINE_PATH || '');
  if (downloaded && fs.existsSync(downloaded)) return downloaded;
  const packed = process.resourcesPath && path.join(process.resourcesPath, 'engine', plat.engineBin());
  if (packed && fs.existsSync(packed)) return packed;
  return path.join(__dirname, '..', '..', 'backend', plat.engineBin());
}`, 'versioned native engine path');

  source = replaceOnce(source, `const skuTitles = require('./sku-titles');`, `const skuTitles = require('./sku-titles');
const engineContract = require('./native-engine-contract');
const nativeHyperBroker = require('./native-hyper-broker');
const manualCaptchaManager = require('./manual-captcha-manager');
const analyticsRecorder = require('./analytics-recorder');`, 'shared native-engine contract import');

  source = replaceOnce(source, `let pendingStart = null; // config queued until the engine connects`, `// Starts are additive, so a single pending slot is lossy while the engine is connecting or finishing
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
}`, 'lossless pending Target start queue');

  source = replaceOnce(source,
    `// ever connected, pendingStart was never flushed, and every task card sat on "Starting" for the rest`,
    `// ever connected, the pending Target queue was never flushed, and every task card sat on "Starting" for the rest`,
    'Target pending-start queue comment');

  source = replaceOnce(source, `const killTree = plat.killTree;`, `const killTree = plat.killTree;

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
}`, 'Target native monitor graceful-stop lifecycle');

  source = replaceOnce(
    source,
    `      from: 'discord-monitor',`,
    `      from: String(p.from || 'discord-monitor').slice(0, 80),`,
    'native stock-ping source label',
  );

  source = replaceOnce(source, `        const tid = (m && m.taskID) || '';
        log('[otp] verification code needed for ' + email + ' — checking mailbox, or enter it above', tid);`, `        const tid = (m && m.taskID) || '';
        // The native engine waits for this acknowledgement before it starts its own OTP timeout.
        // Acknowledge synchronously so mailbox latency cannot consume that readiness window.
        if (m && m.requestId) {
          sendToEngine({ type: 'code-watcher-ready', messages: [{ requestId: String(m.requestId) }] });
        }
        log('[otp] verification code needed for ' + email + ' — checking mailbox, or enter it above', tid);`, 'Target OTP watcher readiness acknowledgement');

  source = replaceOnce(source, `function findNodeExe() {
  if (isPackaged()) {
    const bundled = path.join(process.resourcesPath, 'vendor', plat.nodeBin());
    if (fs.existsSync(bundled)) return bundled;
  }
  const found = plat.whichNode();
  if (found && fs.existsSync(found)) return found;
  return 'node';
}`, `const findNodeExe = nodeExecutable;`, 'Target native farmer executable');

  source = replaceCount(source, `  const env = { ...process.env, FORCE_COLOR: '0', HOPE_SHAPE_PORT: String(SHAPE_PORT), HOPE_SHAPE_TOKEN: SHAPE_TOKEN,
    // The farmer watches its stdin for EOF and exits when it closes — the only parent-death
    // signal that survives a crash or an End Task, neither of which runs a quit handler.
    HOPE_PARENT_WATCH: '1', HOPE_OWNER_PID: String(process.pid) };
  if (isPackaged()) env.PLAYWRIGHT_BROWSERS_PATH = path.join(process.resourcesPath, 'vendor', 'ms-playwright');`, `  const env = nodeEnvironment({ FORCE_COLOR: '0', ZYN_SHAPE_PORT: String(SHAPE_PORT), ZYN_SHAPE_TOKEN: SHAPE_TOKEN,
    // The farmer watches its stdin for EOF and exits when it closes — the only parent-death
    // signal that survives a crash or an End Task, neither of which runs a quit handler.
    ZYN_PARENT_WATCH: '1', ZYN_OWNER_PID: String(process.pid) });`, 2, 'Target native farmer environment');

  source = replaceOnce(source, `  let workers = 0;
  // How long a banked Shape cookie stays usable.`, `  let workers = 0;
  // Collect conservatively by default, but let operators amortise a
  // Chromium launch across fresh contexts and opt into multiple signatures from one page.
  let capturesPerLoad = 1;
  let loadsPerBrowser = 3;
  // Abort bulk assets through the harvest proxy. Shape's documents, stylesheets, scripts and XHR
  // remain available; the UI can disable this immediately if live yield ever regresses.
  let blockHeavyResources = true;
  // How long a banked Shape cookie stays usable.`, 'Target farmer control defaults');

  source = replaceOnce(source, `    workers = parseInt(s.targetHarvestWorkers, 10) > 0 ? parseInt(s.targetHarvestWorkers, 10) : workers;
    cookieTtlSec = parseInt(s.targetCookieTtlSec, 10) > 0 ? parseInt(s.targetCookieTtlSec, 10) : cookieTtlSec;`, `    workers = parseInt(s.targetHarvestWorkers, 10) > 0 ? parseInt(s.targetHarvestWorkers, 10) : workers;
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
    }`, 'Target farmer saved controls');

  source = replaceOnce(source, `  vlog('[target] cookie bank: ' + (poolSize > 0 ? poolSize + ' per type' : 'uncapped') + ', ' + (workers > 0 ? workers : 'auto')
    + ' worker(s), ttl ' + cookieTtlSec + 's, harvesting ATC from ' + atcTcins.split(',').length + ' product(s)');`, `  vlog('[target] cookie bank: ' + (poolSize > 0 ? poolSize + ' per type' : 'uncapped') + ', ' + (workers > 0 ? workers : 'auto')
    + ' worker(s), ttl ' + cookieTtlSec + 's, harvesting ATC from ' + atcTcins.split(',').length + ' product(s)');
  vlog(\`[target] farmer throughput: up to \${capturesPerLoad} cookie(s) per page load, random 1–\${loadsPerBrowser} page load(s) per browser launch, heavy assets \${blockHeavyResources ? 'blocked (images/media/fonts)' : 'allowed'}\`);`, 'Target farmer control log');

  source = replaceOnce(source, `    \`--atcTcins=\${atcTcins}\`, \`--poolSize=\${poolSize}\`, ...(workers > 0 ? [\`--workers=\${workers}\`] : []),`, `    \`--atcTcins=\${atcTcins}\`, \`--poolSize=\${poolSize}\`, ...(workers > 0 ? [\`--workers=\${workers}\`] : []),
    \`--capturesPerLoad=\${capturesPerLoad}\`, \`--loadsPerBrowser=\${loadsPerBrowser}\`,
    \`--blockHeavyResources=\${blockHeavyResources}\`, \`--browsers=auto\`,
    \`--sessionReady=\${hasSession}\`,`, 'Target farmer control arguments');

  source = replaceOnce(source, `function getCookieBank() {`, `// The upstream broker exposes aggregate health but not a success timestamp. The persisted bank already
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

function getCookieBank() {`, 'Target last bank success timestamp');

  source = replaceOnce(source, `          resolve({ login: j.pools?.login || 0, atc: j.pools?.atc || 0, proxies: j.proxies || 0 });`, `          resolve({
            login: j.pools?.login || 0,
            atc: j.pools?.atc || 0,
            proxies: j.proxies || 0,
            harvesters: Array.isArray(j.harvesters) ? j.harvesters : [],
            sessionReady: j.sessionReady === true,
            inFlight: j.inFlight || { login: 0, atc: 0 },
            activity: j.activity || null,
            health: j.health || null,
            demand: j.demand || targetCookieDemand(),
            lastBankedAt: latestBankedAt(),
          });`, 'Target broker health passthrough');

  source = replaceOnce(source, `// Two acceptable proofs. \`app\` is the explicit marker current builds send; the legacy branch`, `// A cold account initially farms login with one safe lane. Once the
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

// Two acceptable proofs. \`app\` is the explicit marker current builds send; the legacy branch`, 'Target farmer session-ready signal');

  source = replaceOnce(source, `          try { dm.setAccountCookie(m.accountId, m.cookie); log('[session] saved account session (' + m.cookie.length + ' chars) — future runs skip login'); } catch (e) { log('[session] save failed: ' + e.message); }`, `          try {
            dm.setAccountCookie(m.accountId, m.cookie);
            log('[session] saved account session (' + m.cookie.length + ' chars) — future runs skip login');
            signalFarmerSessionReady();
          } catch (e) { log('[session] save failed: ' + e.message); }`, 'Target farmer session-ready handoff');

  source = replaceOnce(source, `    if (!plat.isNodeImage(image)) {                 // the farmer runs as node, packaged or not`, `    if (!plat.isNodeImage(image) && image !== 'zyn') { // native packaged farmer reuses Zyn in Node mode`, 'Target native broker owner recognition');

  source = replaceOnce(source, `// IMAP config for OTP login. Prefer the top-level Settings → Email / OTP fields, but fall back to the
// Generate tab's config (settings.generate.*) so an existing email-auth-code setup works for Target
// with no re-entry. Generate's host can be a preset (imapHost) or a custom value (imapHostCustom).
function getImapConfig() {
  let s = {};
  try { s = dm.getSettings() || {}; } catch {}
  const g = s.generate || {};
  return {
    host: (s.imapHost || g.imapHostCustom || g.imapHost || '').trim(),
    user: (s.imapUser || g.imapUser || '').trim(),
    password: s.imapPass || g.imapPass || '',
    port: Number(s.imapPort || g.imapPort || 993) || 993,
  };
}`, `// IMAP belongs to the profile selected for this task. request-code normally carries taskID; email
// matching remains a fallback for older engine messages that only identify the account address.
function getImapConfig(profileId, email) {
  try { return dm.getProfileImap(profileId, email); }
  catch { return { host: '', port: 993, user: '', password: '' }; }
}`, 'Target global IMAP resolver');

  source = replaceOnce(source, `function otpEnabled() {
  if (getAycdKey()) return true;
  const c = getImapConfig();
  return !!(c.host && c.user && c.password);
}`, `function otpEnabled(profileId, email) {
  if (getAycdKey()) return true;
  const c = getImapConfig(profileId, email);
  return !!(c.host && c.user && c.password);
}`, 'Target OTP availability resolver');

  source = replaceOnce(source, 'const taskAccountById = new Map();', `const taskAccountById = new Map();
// taskId -> profileId, retained for request-code messages that arrive after startTarget returned.
const taskProfileById = new Map();
// Target's native implementation names continuous checkout Endless, while the public task
// contract calls it loopCheckout. Retain each launch so confirmed orders can prune capped SKUs.
const taskCheckoutConfigById = new Map(); // taskId -> { skus, qty, loopCheckout }
// Site ownership belongs to the shared transport. Pokemon Center registers into this same map and
// process later; legacy taskID/taskId/id spellings remain unchanged on the wire.
const engineTaskSites = new engineContract.TaskSiteRegistry();`, 'Target task/profile map declaration');

  source = replaceOnce(source, `function sendToEngine(obj) {
  try {`, `function sendToEngine(obj) {
  let envelope;
  try { envelope = engineContract.parseEnvelope(obj); }
  catch (e) { log('[target] invalid engine message: ' + e.message); return false; }
  try {`, 'native-engine outbound envelope validation');
  source = replaceOnce(source, `      engineConn.send(JSON.stringify(obj));`, `      engineConn.send(JSON.stringify(envelope));`, 'native-engine outbound envelope serialization');
  source = replaceOnce(source, `  log(\`[target] engine not connected — dropped "\${obj && obj.type}"\`);`, `  log(\`[target] engine not connected — dropped "\${envelope.type}"\`);`, 'native-engine dropped-message type');
  source = replaceOnce(source, `function handleEngineMessage(data) {
  let msg;
  try { msg = JSON.parse(data.toString()); } catch { return; }
  const items = Array.isArray(msg.messages) ? msg.messages : [];`, `function handleEngineMessage(data) {
  let msg;
  try { msg = engineContract.parseEnvelope(data); } catch { return; }
  const items = msg.messages;`, 'native-engine inbound envelope validation');

  source = replaceOnce(source, `function handleEngineMessage(data) {`, `function handleEngineMessage(data, connection) {`, 'native-engine connection-scoped message handler');
  source = replaceOnce(source, `function handleEngineMessage(data, connection) {
  let msg;`, `function handleEngineMessage(data, connection) {
  // A closing or replaced socket may still have buffered messages. Only the currently owned native
  // connection may mutate task state or acknowledge a monitor shutdown.
  if (!connection || engineConn !== connection) return;
  let msg;`, 'native-engine inbound connection ownership');

  source = replaceOnce(source,
    `  sendToEngine({ type: 'send-configs', messages: [{`,
    `  return sendToEngine({ type: 'send-configs', messages: [{`,
    'native-engine config delivery receipt');

  source = replaceOnce(source,
    `  const key = state + '|' + (color || '') + '|' + (detail || '') + '|' + taskState;`,
    `  const key = state + '|' + (color || '') + '|' + (detail || '') + '|' + taskState + '|' + running;`,
    'Target status liveness dedupe');

  source = replaceOnce(source, `    default:
      // stuckInCart / account-cookie / update-input / update-status variants: ignore for the UI`, `    case 'solve-captcha':
      // Manual-only solver: Electron owns the isolated Pokemon Center window and returns the
      // completed token over this same authenticated engine connection.
      manualCaptchaManager.handleEnvelope(msg, {
        registry: engineTaskSites,
        send: sendToEngine,
        isActive: () => engineConn === connection,
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
      // stuckInCart / account-cookie / update-input / update-status variants: ignore for the UI`, 'native Hyper request routing');

  source = replaceOnce(source, `    ws.on('message', handleEngineMessage);
    ws.on('close', () => { if (engineConn === ws) engineConn = null; });`, `    ws.on('message', data => handleEngineMessage(data, ws));
    ws.on('close', () => {
      if (engineConn === ws) {
        engineConn = null;
        nativeHyperBroker.cancelPending();
        manualCaptchaManager.cancelPending();
      }
    });`, 'native engine connection-scoped broker lifecycle');

  source = replaceOnce(source, `  engineConn = null;
}`, `  engineConn = null;
  nativeHyperBroker.cancelPending();
  manualCaptchaManager.cancelPending();
}`, 'native broker shutdown cancellation');

  source = replaceOnce(source, `  const addr = String(email || '').trim();
  if (!addr) return;
  const key = addr.toLowerCase();`, `  const addr = String(email || '').trim();
  if (!addr) return;
  const profileId = taskProfileById.get(taskId) || '';
  const c = getImapConfig(profileId, addr);
  const key = addr.toLowerCase();`, 'Target task mailbox lookup');

  source = replaceOnce(source, `          log('[otp] AYCD returned no code' + (otpEnabled() && getImapConfig().host ? ' — trying IMAP' : ''));`, `          log('[otp] AYCD returned no code' + (otpEnabled(profileId, addr) && c.host ? ' — trying IMAP' : ''));`, 'Target AYCD empty fallback');
  source = replaceOnce(source, `      } catch (e) { log('[otp] AYCD failed: ' + ((e && e.message) || e) + (getImapConfig().host ? ' — falling back to IMAP' : '')); }`, `      } catch (e) { log('[otp] AYCD failed: ' + ((e && e.message) || e) + (c.host ? ' — falling back to IMAP' : '')); }`, 'Target AYCD error fallback');
  source = replaceOnce(source, `    const c = getImapConfig();
    if (!c.host || !c.user || !c.password) { if (!aycdKey) log('[otp] no OTP source configured — set an AYCD key or IMAP mailbox in Settings → Email / OTP'); return; }`, `    if (!c.host || !c.user || !c.password) { if (!aycdKey) log('[otp] no OTP source configured — add an AYCD key or configure the selected profile mailbox'); return; }`, 'Target profile mailbox requirement');
  source = replaceOnce(source, `    log('[otp] fetching Target login code via IMAP for ' + addr + ' — polling mailbox ' + c.user + ' …');`, `    log('[otp] fetching Target login code via IMAP for ' + addr + ' — polling profile mailbox ' + c.user + ' …');`, 'Target mailbox log');

  // Hope's current mailbox flow replaces the older server-side IMAP SEARCH implementation. Keep
  // the reviewed bridge as a fragment so it can be tested on its own and copied without escaping a
  // large JavaScript program inside another JavaScript template literal.
  const otpBridge = fs.readFileSync(path.join(__dirname, 'target-otp-bridge.fragment.js'), 'utf8').trimEnd();
  source = replaceSection(
    source,
    '// Engine emits `request-code {email}` and blocks in WaitForCode until we send `received-code`.',
    '// ── Log verbosity',
    `${otpBridge}\n\n`,
    'Target OTP bridge',
  );

  source = replaceOnce(source, `  // A code fetch runs for up to 240s. Without clearing this, restarting inside that window makes the
  // new run's request-code hit the in-flight guard and get dropped silently — the task then waits for
  // a code that nobody is fetching. A new run always gets a fresh fetch (and fresh IMAP settings).
  otpInFlight.clear();`, `  // A restarted task gets a fresh mailbox fetch, while additive starts must not cancel OTP polling
  // for sibling tasks that are already running.
  for (const t of (config.tasks || [])) cancelOtpForTask(t.id, 'Target task restarted');`, 'Target OTP restart cancellation');

  source = replaceOnce(source, `  taskActive = false;
  otpInFlight.clear();
  // The engine that asked for these is being killed, so a lingering prompt would deliver a code
  // nobody is waiting for.
  otpPending.clear();
  emitOtpPending();`, `  taskActive = false;
  stopLiveEditMonitor();
  // The engine that asked for these is being killed. Abort the actual mailbox operations as well as
  // clearing the prompt so neither a socket timeout nor a late code can leak into a future run.
  cancelAllOtpFetches();`, 'Target full OTP cancellation');

  // A live selector can name a group no task used at launch. The engine replaces its proxy map on
  // send-configs, so load/refresh the chosen list before asking SwapProxy to use it; otherwise the
  // edit reaches the task correctly but fails with "Could Not Switch To …" / "invalid group".
  source = replaceOnce(source, `  const group = String(proxyListName || '').trim() || 'Local';
  return sendToEngine({ type: 'set-task-proxy', messages: [{ id: taskId, proxyGroup: group }] });`, `  const group = String(proxyListName || '').trim() || 'Local';
  if (group !== 'Local') {
    Object.assign(sentConfigs.proxies, buildProxyMap(group));
    sendConfigs();
  }
  return sendToEngine({ type: 'set-task-proxy', messages: [{ id: taskId, proxyGroup: group }] });`, 'Target live proxy config refresh');

  source = replaceOnce(source, `function sendStart(config) {`, `let liveEditMonitorId = '';
let liveEditMonitorTimer = null;
let liveEditMonitorSequence = 0;
let liveEditStoppedMainMonitor = false;

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

// A group edit changes the restock inputs in-place. Checkout tasks drain runtime edits only at safe
// step boundaries, so a task already carting or submitting keeps its selected TCIN; the new watch
// list is used the next time it returns to restock selection.
function editTargetTasks(config = {}) {
  const skus = [...new Set((Array.isArray(config.skus) ? config.skus : [])
    .map(value => String(value || '').trim())
    .filter(value => /^\\d{6,}$/.test(value)))];
  const qty = Math.max(1, parseInt(config.qty, 10) || 1);
  const selected = (Array.isArray(config.tasks) ? config.tasks : [])
    .filter(task => task && task.id && runningTaskIds.has(task.id));
  if (!selected.length) return { ok: false, updated: 0, watched: 0, cappedTasks: 0, error: 'No selected Target tasks are running.' };

  const makeItems = list => list.map(sku => ({
    id: sku, monitorInput: sku, quantity: String(qty), color: '', sizes: [], maxPrice: '',
  }));
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
    return { id: task.id, type: 'Target', site: 'Target', item: items, monitorItems: items };
  });

  const sent = sendToEngine({ type: 'edit-tasks', messages });
  if (!sent) return { ok: false, updated: 0, watched: 0, cappedTasks, error: 'The native Target engine is not connected.' };

  messages.forEach((message, index) => {
    const existing = taskCheckoutConfigById.get(message.id) || {};
    const selectedTask = selected[index] || {};
    taskCheckoutConfigById.set(message.id, {
      ...existing,
      skus: message.monitorItems.map(item => item.monitorInput),
      qty,
      proxyListName: selectedTask.proxyListName || existing.proxyListName || '',
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
      proxyGroup: String(first.proxyListName || '').trim() || 'Local',
      monitorDelay: '4000',
      items: watched.map(sku => ({ monitorInput: sku, quantity: String(qty), maxPrice: '' })),
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

function sendStart(config) {
  liveEditStoppedMainMonitor = false;`, 'Target live task watch-list editing');

  source = replaceOnce(source, `let liveEditStoppedMainMonitor = false;`, `let liveEditStoppedMainMonitor = false;

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
  let proxyGroup = 'Local';
  for (const id of runningTaskIds) {
    const config = taskCheckoutConfigById.get(id);
    if (!config) continue;
    if (proxyGroup === 'Local') proxyGroup = String(config.proxyListName || '').trim() || 'Local';
    const qty = Math.max(1, parseInt(config.qty, 10) || 1);
    for (const rawSku of (config.skus || [])) {
      const sku = String(rawSku || '').trim();
      if (!sku) continue;
      const previous = quantities.get(sku);
      quantities.set(sku, previous == null ? qty : Math.min(previous, qty));
    }
  }
  const items = [...quantities.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([monitorInput, quantity]) => ({ monitorInput, quantity: String(quantity), maxPrice: '' }));
  return { items, proxyGroup };
}

function editTargetMainMonitor(spec, monitorId = targetMainMonitorId) {
  if (!monitorId) return false;
  const monitorItems = spec.items.map(item => ({
    id: item.monitorInput,
    monitorInput: item.monitorInput,
    quantity: item.quantity,
    color: '',
    sizes: [],
    maxPrice: '',
  }));
  return sendToEngine({
    type: 'edit-tasks',
    messages: [{
      id: monitorId,
      type: 'Target',
      site: 'Target',
      proxyGroup: spec.proxyGroup,
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
      monitorDelay: '4000',
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
}`, 'single Target monitor union lifecycle');

  source = replaceOnce(source, `function sendStart(config) {
  liveEditStoppedMainMonitor = false;`, `// Continue a looping Target task only while this account still has an eligible watched SKU.
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

  const items = eligible.map(sku => ({
    id: sku, monitorInput: sku, quantity: String(config.qty), color: '', sizes: [], maxPrice: '',
  }));
  if (!sendToEngine({
    type: 'edit-tasks',
    messages: [{ id: taskId, type: 'Target', site: 'Target', item: items, monitorItems: items }],
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
  liveEditStoppedMainMonitor = false;`, 'Target looping order-cap enforcement');

  source = replaceSection(source, `function flushStart() {`, `function handleEngineMessage(data, connection) {`, `function flushStart() {
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
    log(\`\${started} task(s) started on \${(config.skus || []).length} SKU(s)\`);
  }
  if (startedTotal) reconcileTargetMainMonitor();
  return startedTotal;
}

`, 'lossless pending Target start flush');

  source = replaceOnce(source, `  pendingStart = config;`, `  queueTargetStart(config);`,
    'Target start FIFO enqueue');

  source = replaceOnce(source,
    `            qty: 1,
            sku: String(m.sku || ''),`,
    `            qty: Number((taskCheckoutConfigById.get(tid) || {}).qty) || 1,
            sku: String(m.sku || ''),`,
    'Target checkout report quantity');
  source = replaceOnce(source,
    `            if (acct && tcin) dm.recordTargetOrder(acct, tcin);
            else log(\`[cap] not counted — \${acct ? 'no TCIN on the notification' : 'no account for task ' + tid}\`, tid);`,
    `            if (acct && tcin) dm.recordTargetOrder(acct, tcin);
            else log(\`[cap] not counted — \${acct ? 'no TCIN on the notification' : 'no account for task ' + tid}\`, tid);
            enforceTargetLoopCheckout(tid, acct, tcin);`,
    'Target loop-checkout result enforcement');

  source = replaceOnce(source, `const id = m.taskID === MONITOR_ID ? '' : (m.taskID || '');`, `const id = String(m.taskID || '').startsWith(MONITOR_ID) ? '' : (m.taskID || '');`, 'Target live-edit monitor status routing');

  source = replaceOnce(source,
    `  sendToEngine({ type: 'start-tasks', messages });`,
    `  if (!sendToEngine({ type: 'start-tasks', messages })) return -1;
  toRenderer('targetRunStarted', { taskIds: tasks.map(task => task.id), startedAt: Date.now() });`,
    'Target per-run outcome reset');

  source = replaceOnce(source,
    `  const watched = [...new Set(tasks.flatMap(t => t.skus))];`,
    `  for (const task of tasks) {
    const existing = taskCheckoutConfigById.get(task.id) || {};
    taskCheckoutConfigById.set(task.id, {
      ...existing,
      skus: task.skus.slice(),
      proxyListName: task.proxyListName || existing.proxyListName || '',
    });
  }
  const watched = [...new Set(tasks.flatMap(t => t.skus))];`,
    'Target eligible monitor-union state');

  source = replaceSection(source,
    `  // ONE monitor for the whole module, watching every SKU, publishing to the hub that all the`,
    `  const grp = groupOf(tasks[0] && tasks[0].proxyListName);`,
    `  // flushStart reconciles the one native monitor after every pending checkout batch has been
  // delivered, so additive configs cannot race duplicate starts for the same monitor ID.
`,
    'Target per-config monitor startup');

  source = replaceOnce(source, `      taskActive = false;
      // The engine dying takes every task with it, so clear them all rather than a single id.`, `      taskActive = false;
      stopLiveEditMonitor();
      cancelAllOtpFetches('Target engine exited');
      // The engine dying takes every task with it, so clear them all rather than a single id.`, 'Target engine-exit OTP cancellation');

  source = replaceOnce(source, `  let hasSession = false;
  try {
    const creds = config.accountId ? dm.getAccountCreds(config.accountId) : null;
    if (creds) {
      env.SHAPE_ACCT_EMAIL = creds.email || '';
      env.SHAPE_ACCT_PASS = creds.password || '';
      hasSession = !!creds.cookie;
    }
  } catch {}`, `  let hasSession = false;
  let accountEmail = '';
  try {
    const creds = config.accountId ? dm.getAccountCreds(config.accountId) : null;
    if (creds) {
      accountEmail = creds.email || '';
      env.SHAPE_ACCT_EMAIL = accountEmail;
      env.SHAPE_ACCT_PASS = creds.password || '';
      hasSession = !!creds.cookie;
    }
  } catch {}`, 'Target farmer account email');
  source = replaceOnce(source, `  const loginMode = otpEnabled() ? 'otp' : 'password';`, `  const loginMode = otpEnabled(config.profileId, accountEmail) ? 'otp' : 'password';`, 'Target farmer login mode');
  source = replaceOnce(source, `    useOtpLogin: otpEnabled(), startSchedule: '', stopSchedule: '', ignoreLowStock: false,`, `    useOtpLogin: otpEnabled(t.profileId), startSchedule: '', stopSchedule: '', ignoreLowStock: false,`, 'Target task OTP mode');

  source = replaceOnce(source,
    `    loopCheckout: false, waitForQueue: false, QueueEntryDelay: '0',`,
    `    loopCheckout: (t.loopCheckout != null ? t.loopCheckout === true : t.repeatCheckout === true) || config.endless === true, waitForQueue: false, QueueEntryDelay: '0',`,
    'Target loop-checkout contract flag');
  source = replaceOnce(source,
    `    endless: !!config.endless, useFillerItem: !!config.useFillerItem,`,
    `    // Target currently reads Endless for repeat behavior. Send both fields so a native update
    // can adopt LoopCheckout without changing the app-side contract again.
    endless: (t.loopCheckout != null ? t.loopCheckout === true : t.repeatCheckout === true) || config.endless === true, useFillerItem: !!config.useFillerItem,`,
    'Target loop-checkout implementation flag');
  source = replaceOnce(source,
    `  // Enforced here rather than after checkout because endless is off: a task stops the moment it
  // checks out, so the only way to exceed the cap is to start again — which is exactly this path.`,
    `  // Enforced here before the first order. Looping tasks also re-check after every confirmed
  // checkout, remove newly capped SKUs, and stop when no eligible watched SKU remains.`,
    'Target looping order-cap comment');

  source = replaceOnce(source, `      runningTaskIds.delete(t.id);
      status('Limit Reached'`, `      runningTaskIds.delete(t.id);
      engineTaskSites.remove(t.id);
      taskProfileById.delete(t.id);
      taskCheckoutConfigById.delete(t.id);
      status('Limit Reached'`, 'Target capped task cleanup');
  source = replaceOnce(source,
    `      status('Limit Reached', '#f59e0b', \`\${dm.ORDER_LIMIT_MAX} orders in the last 4h\`, t.id);`,
    `      status('Limit Reached', '#f59e0b', \`\${dm.ORDER_LIMIT_MAX} orders in the last 4h\`, t.id, undefined, false);`,
    'Target capped task terminal status');
  source = replaceOnce(source, `      runningTaskIds.clear();
      toRenderer('targetDone'`, `      runningTaskIds.clear();
      engineTaskSites.clear();
      taskProfileById.clear();
      taskCheckoutConfigById.clear();
      manualCaptchaManager.cancelPending();
      toRenderer('targetDone'`, 'Target exit task cleanup');
  source = replaceOnce(source, `    runningTaskIds.add(t.id);
    taskAccountById.set(t.id, t.accountId || '');`, `    runningTaskIds.add(t.id);
    engineTaskSites.register(t.id, engineContract.SITES.TARGET);
    taskAccountById.set(t.id, t.accountId || '');
    taskProfileById.set(t.id, t.profileId || '');
    taskCheckoutConfigById.set(t.id, {
      skus: [...new Set((config.skus || []).map(sku => String(sku || '').trim()).filter(Boolean))],
      qty: Math.max(1, parseInt(config.qty, 10) || 2),
      proxyListName: String(t.proxyListName || '').trim(),
      loopCheckout: (t.loopCheckout != null ? t.loopCheckout === true : t.repeatCheckout === true) || config.endless === true,
    });`, 'Target task/profile association');
  source = replaceOnce(source, `      accountId: first.accountId || '',
      sku:`, `      accountId: first.accountId || '',
      profileId: first.profileId || '',
      sku:`, 'Target farmer profile association');
  source = replaceOnce(source, `    runningTaskIds.delete(taskId);
    toRenderer('targetDone'`, `    runningTaskIds.delete(taskId);
    engineTaskSites.remove(taskId);
    taskProfileById.delete(taskId);
    taskCheckoutConfigById.delete(taskId);
    cancelOtpForTask(taskId);
    manualCaptchaManager.cancelTask(taskId);
    toRenderer('targetDone'`, 'Target stopped task cleanup');
  source = replaceOnce(source, `  runningTaskIds.clear();
  toRenderer('targetDone'`, `  runningTaskIds.clear();
  engineTaskSites.clear();
  taskProfileById.clear();
  taskCheckoutConfigById.clear();
  manualCaptchaManager.cancelPending();
  toRenderer('targetDone'`, 'Target full task cleanup');

  source = replaceOnce(source,
    `function runningCount() { return runningTaskIds.size; }`,
    `function isTaskRunning(taskId) { return runningTaskIds.has(String(taskId || '')); }
function runningCount() { return runningTaskIds.size; }`,
    'Target scheduled task running-state export');

  // A single broker owns :4727 and the shared bank. Every saved harvester runs as a producer-only
  // child, so browser, route, worker count, schedule, type, and lifecycle remain independent.
  source = replaceOnce(source, `let farmerProc = null;  // the Shape cookie farmer/broker (node bot/shape-farmer.mjs, port 4727)`, `let farmerProc = null;  // the Shape cookie farmer/broker (node bot/shape-farmer.mjs, port 4727)
// Managed harvesters are isolated producer processes. They never bind :4727; each posts signed
// cookies into the single broker above, so one route/browser can be stopped or crash without
// interrupting the shared bank or another harvester.
const harvesterProcs = new Map(); // id -> { proc, fingerprint }
const harvesterStartFailures = new Map(); // id -> failure key, suppresses repeated reconciliation logs
let harvesterSyncTimer = null;`, 'Target managed harvester process state');

  const harvesterConfig = fs.readFileSync(path.join(__dirname, 'target-multi-harvester-config.fragment.js'), 'utf8').trimEnd();
  source = replaceOnce(source, `function botDirPath() {
  return isPackaged() ? path.join(process.resourcesPath, 'bot') : path.join(__dirname, '..', '..', 'bot');
}`, `function botDirPath() {
  return isPackaged() ? path.join(process.resourcesPath, 'bot') : path.join(__dirname, '..', '..', 'bot');
}

${harvesterConfig}`, 'Target managed harvester config');

  const cookieDemand = fs.readFileSync(path.join(__dirname, 'target-cookie-demand.fragment.js'), 'utf8').trimEnd();
  source = replaceOnce(source, `function ensureHarvesterBroker() {`,
    `${cookieDemand}

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
          reject(new Error(\`cookie broker returned \${res.statusCode}\`));
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

function ensureHarvesterBroker() {`, 'Target dynamic cookie-bank demand');

  source = replaceOnce(source,
    `// Where Target's Shape cookies come from: 'In Bot' (bundled Playwright farmer) or 'Harvester' (the
// browser extension posting to the broker). Drives both how the farmer is launched and what the
// checkout webhook reports, so a failure can be attributed to the right source.`,
    `// Where Target's Shape cookies come from: 'In Bot' (bundled Playwright farmer) or 'Harvester'
// (external Chrome through Zyn's filtered, authenticated compatibility bridge). Drives both how the
// farmer is launched and what the checkout webhook reports, so failures retain their source.`,
    'Target external harvester source comment');
  source = replaceOnce(source,
    `// Standalone broker for Harvester mode. The broker lives inside the farmer process, so previously
// it only existed while a checkout task was running — which made pre-farming impossible: the whole
// point is to bank cookies for HOURS before a drop, with no task running. The extension would
// intercept correctly and then have nowhere to POST, silently banking nothing.
//
// This starts the same process with no farming workers, so :4727 is up and accepting /saveCookies
// as soon as the app is. A task starting later reuses it rather than spawning a second one.`,
    `// Standalone broker for Harvester mode. The broker lives inside the farmer process, so it must be
// present before an external Chrome capture reaches Zyn's port-4312 compatibility bridge.
//
// This starts the same process with no farming workers. The main process filters the capture, then
// asks this module to authenticate one /saveCookies write to the tracked broker on :4727.`,
    'Target authenticated standalone broker comment');
  source = replaceOnce(source,
    '  log(`[target] harvester broker listening on 127.0.0.1:${SHAPE_PORT} — extension can bank cookies now`);',
    '  log(`[target] harvester broker listening on 127.0.0.1:${SHAPE_PORT} — authenticated extension bridge is ready`);',
    'Target authenticated broker log');
  source = replaceOnce(source,
    `// The broker port is the one port that cannot move: the browser extension hardcodes
// 127.0.0.1:4727 (harvester-extension/background.js), so a dynamic port would silently zero out
// extension harvesting. Instead of fleeing a squatted port we take it back — but ONLY from our own
// orphan, identified by a live protocol handshake, never by process name.`,
    `// The broker port is fixed by the native engine contract and the main-process compatibility
// bridge. Instead of fleeing a squatted port we take it back — but ONLY from our own orphan,
// identified by a live protocol handshake, never by process name.`,
    'Target broker ownership comment');
  source = replaceOnce(source,
    `  // Shape Method = Harvester ADDS the browser extension as a cookie source; it does not replace
  // in-bot farming. The broker's POST /saveCookies stays open whether or not the farmer is running,
  // so both feed the same pool and the engine takes whichever cookie is available first.`,
    `  // Shape Method = Harvester adds external Chrome as a cookie source; it does not replace in-bot
  // farming. Chrome talks only to the filtered port-4312 bridge, which authenticates accepted saves
  // to this process, so both sources feed the same bank without exposing the broker token.`,
    'Target authenticated external harvester comment');
  source = replaceOnce(source,
    '  if (harvesterMode) vlog(`[target] Shape Method: Harvester — in-bot farming ON, extension may also bank cookies to 127.0.0.1:${SHAPE_PORT}`);',
    '  if (harvesterMode) vlog(`[target] Shape Method: Harvester — in-bot farming ON, external Chrome bridge on 127.0.0.1:4312`);',
    'Target external harvester mode log');

  source = replaceOnce(source,
    `  if (next && !quitting && !farmerProc) startFarmer(next);`,
    `  if (next && targetHarvestAuthorized && !quitting && !farmerProc) startFarmer(next);`,
    'Target queued farmer authorization');

  source = replaceOnce(source, `function ensureHarvesterBroker() {
  if (quitting) return;                         // never resurrect the broker while shutting down
  if (farmerProc) return;                       // a task's farmer already provides the broker
  if (farmerPending) return;                    // a real farmer is mid-spawn — it wins, it can farm
  if (shapeMethodSetting() !== 'Harvester') return;`, `function ensureHarvesterBroker() {
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
  if (!managed && shapeMethodSetting() !== 'Harvester') return;`, 'Target managed broker reconciliation');

  source = replaceOnce(source, `  reclaimBrokerPort((mine) => {
    if (quitting || !mine) { brokerPending = false; return; }
    whenPortFree(SHAPE_PORT, (free) => {
      brokerPending = false;
      if (quitting) return;   // armed before the quit, resolving after it — the entry guard cannot catch this`, `  reclaimBrokerPort((mine) => {
    if (quitting || !targetHarvestAuthorized || !mine) { brokerPending = false; return; }
    whenPortFree(SHAPE_PORT, (free) => {
      brokerPending = false;
      if (quitting || !targetHarvestAuthorized) return; // authorization may close while the port probe is pending`,
  'Target pending broker authorization');

  source = replaceOnce(source, `function spawnHarvesterBroker(script, botDir, env) {
  let proc;
  try {
    proc = spawn(findNodeExe(), [script, '--noFarm=true', \`--bankFile=\${bankFile()}\`], { cwd: botDir, stdio: ['pipe', 'pipe', 'pipe'], env, ...plat.spawnOpts() });`, `function spawnHarvesterBroker(script, botDir, env) {
  if (!targetHarvestAuthorized) return;
  let settings = {};
  try { settings = dm.getSettings() || {}; } catch {}
  const poolSize = parseInt(settings.targetCookieBank, 10) > 0 ? parseInt(settings.targetCookieBank, 10) : 0;
  const cookieTtlSec = parseInt(settings.targetCookieTtlSec, 10) > 0 ? parseInt(settings.targetCookieTtlSec, 10) : 600;
  const maxDrainPerMin = parseInt(settings.targetCookieDrainPerMin, 10) > 0 ? parseInt(settings.targetCookieDrainPerMin, 10) : 0;
  let proc;
  try {
    proc = spawn(findNodeExe(), [script, '--noFarm=true', \`--bankFile=\${bankFile()}\`,
      \`--poolSize=\${poolSize}\`, \`--cookieTtlMs=\${cookieTtlSec * 1000}\`,
      \`--maxDrainPerMin=\${maxDrainPerMin}\`], { cwd: botDir, stdio: ['pipe', 'pipe', 'pipe'], env, ...plat.spawnOpts() });`, 'Target managed broker controls');

  source = replaceOnce(source, `function startFarmer(config) {`, `function startFarmer(config) {
  if (!targetHarvestAuthorized) return;`, 'Target farmer authorization entry');
  source = replaceCount(source,
    `if (quitting || seq !== startSeq) { farmerChainDone(); return; }`,
    `if (quitting || !targetHarvestAuthorized || seq !== startSeq) { farmerChainDone(); return; }`,
    2,
    'Target pending farmer authorization');
  source = replaceOnce(source, `function spawnFarmer(config) {`, `function spawnFarmer(config) {
  if (!targetHarvestAuthorized) return;`, 'Target farmer authorization boundary');

  source = replaceOnce(source, `    farmerProc = proc;
    brokerOnly = true;`, `    farmerProc = proc;
    brokerOnly = true;
    // A replacement broker starts with only its legacy CLI cap. Republish the live/standby demand
    // once it begins listening; the retry loop covers the short spawn-to-listen gap.
    proc.once('spawn', () => {
      lastTargetCookieDemandKey = '';
      setTimeout(syncTargetCookieBankDemand, 150);
    });`,
  'Target broker demand restoration');

  source = replaceOnce(source, `  proc.on('exit', () => { if (farmerProc === proc) { farmerProc = null; brokerOnly = false; } });`, `  proc.on('exit', () => {
    if (farmerProc === proc) { farmerProc = null; brokerOnly = false; lastTargetCookieDemandKey = ''; }
    if (!quitting && managedHarvesterMode()) setTimeout(ensureHarvesterBroker, 1000);
  });`, 'Target managed broker restart');

  const harvesterProducers = fs.readFileSync(path.join(__dirname, 'target-multi-harvester-producers.fragment.js'), 'utf8').trimEnd();
  source = replaceOnce(source, `// ── config translation: data-manager shapes -> engine JSON ───────────────────────`, `${harvesterProducers}

// ── config translation: data-manager shapes -> engine JSON ───────────────────────`, 'Target managed harvester producers');

  source = replaceOnce(source, `  const s = p.shipping || {};
  const pay = p.payment || {};
  const country = normalizeCountry(s.country);
  const first = s.firstName || '';
  const last = s.lastName || '';
  const zip = s.zipcode || s.zip || '';
  const state = normalizeState(s.state);`, `  const s = p.shipping || {};
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
  const billingState = normalizeState(b.state);`, 'separate profile billing address preparation');

  source = replaceOnce(source, `    billingFirstName: first, billingLastName: last,
    billingAddress1: s.address || '', billingAddress2: s.address2 || '',
    billingCity: s.city || '', billingState: state, billingZip: zip, billingCountry: country,`, `    billingFirstName: billingFirst, billingLastName: billingLast,
    billingAddress1: b.address || '', billingAddress2: b.address2 || '',
    billingCity: b.city || '', billingState, billingZip, billingCountry,`, 'separate profile billing address mapping');

  source = replaceOnce(source, `    startFarmer({
      proxyListName: harvesterPool,
      accountId: first.accountId || '',
      profileId: first.profileId || '',
      sku: (config.skus || [])[0] || '',
    });`, `    if (managedHarvesterMode()) {
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
    }`, 'Target checkout managed harvester start');

  source = replaceOnce(source, `  const deadFarmerPid = farmerProc && farmerProc.pid;
  killTree(farmerProc);
  farmerProc = null;
  sweepOrphanHarvesters(deadFarmerPid);
  brokerOnly = false;`, `  if (!managedHarvesterMode()) {
    const deadFarmerPid = farmerProc && farmerProc.pid;
    killTree(farmerProc);
    farmerProc = null;
    sweepOrphanHarvesters(deadFarmerPid);
    brokerOnly = false;
  }`, 'Target checkout managed harvester stop');

  source = replaceOnce(source, `function shutdown() {
  quitting = true;
  try { stopTarget(); } catch {}
  try { if (wss) wss.close(); } catch {}`, `function shutdown() {
  quitting = true;
  try { stopTarget(); } catch {}
  if (harvesterSyncTimer) clearInterval(harvesterSyncTimer);
  harvesterSyncTimer = null;
  for (const id of [...harvesterProcs.keys()]) stopHarvesterProducer(id);
  try { killTree(farmerProc); } catch {}
  farmerProc = null;
  brokerOnly = false;
  try { if (wss) wss.close(); } catch {}`, 'Target managed harvester shutdown');

  source = replaceOnce(source, `module.exports = { startTarget, stopTarget, shutdown, ensureHarvesterBroker, getCookieBank, submitOtpManually, sendStockPing, runningCount, setTaskProxy, getSkuTitles };`, `module.exports = { startTarget, stopTarget, editTargetTasks, shutdown, ensureHarvesterBroker, saveHarvesterCookie, syncTargetHarvesters, setTargetHarvestAuthorized, setTargetCookieStandbyTasks, syncTargetCookieBankDemand, targetCookieDemand, getCookieBank, submitOtpManually, sendStockPing, isTaskRunning, runningCount, setTaskProxy, getSkuTitles };`, 'Target managed harvester export');

  // Pokemon Center uses the same authenticated WebSocket and Go process as Target. Keep its adapter
  // in a standalone fragment so the reviewed recovered engine remains hash-gated and the added code
  // can be syntax-checked directly.
  const pokemonBridge = fs.readFileSync(path.join(__dirname, 'pokemon-center-engine-bridge.fragment.js'), 'utf8').trimEnd();
  source = replaceOnce(
    source,
    `    profileGroup: p.group || '',`,
    `    profileGroup: p.group || (Array.isArray(p.groups) ? p.groups[0] : '') || '',`,
    'native profile-group mapping',
  );
  source = replaceOnce(
    source,
    `function handleEngineMessage(data, connection) {`,
    `${pokemonBridge}\n\nfunction handleEngineMessage(data, connection) {`,
    'Pokemon Center native bridge',
  );

  source = replaceOnce(source, `  const die = () => { rendererDead = true; try { if (taskActive || engineProc || farmerProc) stopTarget(); } catch {} };`, `  const die = () => {
    rendererDead = true;
    try { if (taskActive || engineProc || farmerProc) stopTarget(); } catch {}
    try { if (pokemonTaskIds.size) stopPokemonCenter(); } catch {}
  };`, 'shared native window teardown');

  source = replaceOnce(source, `        const id = String(m.taskID || '').startsWith(MONITOR_ID) ? '' : (m.taskID || '');
        status(st, m.color, '', id, m.state, m.running);
        // The monitor re-emits Getting Product(s) / Rotating Proxy every few seconds forever. Its
        // state is already shown live next to "Engine Log", so logging it as well just buries the
        // checkout task's own lines. Failures still come through (KEEP_IN_QUIET).
        const monitorChatter = !id && !verboseLogs() && !KEEP_IN_QUIET.test(st);
        if (!monitorChatter) log(st, id);`, `        const rawId = m.taskID || '';
        const id = String(rawId).startsWith(MONITOR_ID) ? '' : rawId;
        if (engineTaskSites.resolve(m) === POKEMON_SITE) {
          pokemonStatus(st, m.color, '', id, m.state, m.running);
          pokemonLog(st, id);
          if (m.running === false && id) {
            pokemonTaskIds.delete(id);
            pokemonTaskConfigs.delete(id);
            engineTaskSites.remove(id);
            manualCaptchaManager.cancelTask(id);
            taskActive = runningTaskIds.size > 0 || pokemonTaskIds.size > 0;
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
          taskActive = runningTaskIds.size > 0 || pokemonTaskIds.size > 0;
          if (targetMainMonitorRunning || !runningTaskIds.size) reconcileTargetMainMonitor();
        }
        // The monitor re-emits Getting Product(s) / Rotating Proxy every few seconds forever. Its
        // state is already shown live next to "Engine Log", so logging it as well just buries the
        // checkout task's own lines. Failures still come through (KEEP_IN_QUIET).
        const monitorChatter = !id && !verboseLogs() && !KEEP_IN_QUIET.test(st);
        if (!monitorChatter) log(st, id);`, 'site-aware native status routing');

  source = replaceOnce(source, `    case 'task-notification':
      for (const m of items) {
        log('[notify] ' + (typeof m === 'string' ? m : JSON.stringify(m)));
        if (!m || typeof m === 'string') continue;`, `    case 'task-notification':
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
              });
            } catch (e) { pokemonLog('[report] ' + e.message, notificationTaskId); }
          }
          continue;
        }
        log('[notify] ' + JSON.stringify(m));`, 'site-aware native notification routing');

  source = replaceOnce(source, `    case 'task-notification':`, `    case 'monitor-bandwidth':
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
        if (m && ['checkout', 'decline'].includes(outcomeType)
          && engineTaskSites.resolve(m) === engineContract.SITES.TARGET) {
          toRenderer('targetOutcome', {
            eventId: m.eventId || '', eventType: outcomeType, taskId: m.taskId || '',
            occurredAt: m.occurredAt,
          });
        }
      }
      break;
    case 'task-notification':`, 'native analytics event routing');

  source = replaceOnce(source, `    case 'request-code':`, `    case 'update-input':
      for (const m of items) {
        if (!m || engineTaskSites.resolve(m) !== POKEMON_SITE) continue;
        toRenderer('pokemonInput', {
          taskId: m.taskID || '', productName: m.productName || '', productSize: m.productSize || '',
        });
      }
      break;
    case 'task-log':
      for (const m of items) {
        if (!m || engineTaskSites.resolve(m) !== POKEMON_SITE) continue;
        const decoded = decodeNativeTaskLog(m.data);
        const queueMonitorLog = decoded.startsWith('[queue-monitor]');
        pokemonLog(devLogs() || queueMonitorLog ? decoded : 'Pokemon Center returned an unexpected response; retrying', m.taskID || '');
      }
      break;
    case 'request-code':`, 'Pokemon Center input and diagnostic routing');

  source = replaceOnce(source, `    if (pendingStart) flushStart();
    // An engine that reconnects — or a respawned one — comes up with empty profile/account/proxy
    // maps, because they live in that process and nothing on this side re-sent them. Any task still
    // running would fail its next rotation with "invalid group". Push what it should already have.
    else if (Object.keys(sentConfigs.proxies).length || Object.keys(sentConfigs.accounts).length) {
      vlog('engine reconnected — re-sending configs');
      sendConfigs();
    }`, `    if (targetMainMonitorPendingStopIds.size) sendPendingTargetMainMonitorStop();
    let flushed = false;
    if (pendingTargetStarts.length) { flushStart(); flushed = true; }
    if (pendingPokemonStarts.length) { flushPokemonStarts(); flushed = true; }
    // An engine that reconnects — or a respawned one — comes up with empty profile/account/proxy
    // maps, because they live in that process and nothing on this side re-sent them. Any task still
    // running would fail its next rotation with "invalid group". Push what it should already have.
    if (!flushed && (Object.keys(sentConfigs.profiles).length || Object.keys(sentConfigs.proxies).length || Object.keys(sentConfigs.accounts).length)) {
      vlog('engine reconnected — re-sending configs');
      sendConfigs();
    }
    if (targetMainMonitorNeedsSync && runningTaskIds.size) reconcileTargetMainMonitor();`, 'shared native pending-start flush');

  source = replaceOnce(source, `    for (const id of runningTaskIds) status('Error', '#fb5454', 'engine bridge: ' + err.code, id);
    status('Error', '#fb5454', 'ws server: ' + err.code);`, `    for (const id of runningTaskIds) status('Error', '#fb5454', 'engine bridge: ' + err.code, id);
    for (const id of pokemonTaskIds) pokemonStatus('Error', '#fb5454', 'engine bridge: ' + err.code, id, 0, false);
    status('Error', '#fb5454', 'ws server: ' + err.code);`, 'shared native bridge errors');

  source = replaceOnce(source,
    `  const s = new WebSocket.Server({ host: '127.0.0.1', port });
  wss = s;`,
    `  let s;
  try {
    s = new WebSocket.Server({ host: '127.0.0.1', port });
  } catch (err) {
    log('engine server error: ' + err.message);
    serverWaiters.length = 0;
    failNativeEngineRuns('engine bridge: ' + (err.code || err.message), true);
    return;
  }
  wss = s;`,
    'synchronous native bridge bind cleanup');
  source = replaceOnce(source,
    `    log('engine server error: ' + err.message);
    serverWaiters.length = 0;            // nothing will ever be ready; don't leave spawns queued
    for (const id of runningTaskIds) status('Error', '#fb5454', 'engine bridge: ' + err.code, id);
    for (const id of pokemonTaskIds) pokemonStatus('Error', '#fb5454', 'engine bridge: ' + err.code, id, 0, false);
    status('Error', '#fb5454', 'ws server: ' + err.code);`,
    `    log('engine server error: ' + err.message);
    serverWaiters.length = 0;            // nothing will ever be ready; don't leave spawns queued
    failNativeEngineRuns('engine bridge: ' + (err.code || err.message), true);`,
    'fatal native bridge bind cleanup');

  source = replaceOnce(source,
    "    log('ENGINE NOT FOUND: ' + exe + ` — build it with:  cd backend && go build -o ${plat.engineBin()} .`);\n    return;\n  }\n  engineProc = spawn(",
    "    log('ENGINE NOT FOUND: ' + exe + ` — build it with:  cd backend && go build -o ${plat.engineBin()} .`);\n    failNativeEngineRuns('engine binary not found', true);\n    return;\n  }\n  const engineVersion = exe === process.env.ZYN_ENGINE_PATH\n    ? String(process.env.ZYN_ENGINE_VERSION || 'downloaded') : 'bundled';\n  log('[target] starting native engine ' + engineVersion);\n  try {\n    engineProc = spawn(",
    'missing native engine failure cleanup');
  source = replaceOnce(source,
    `    ...plat.spawnOpts(),
  });
  // The engine prints a timestamped line for EVERY status change and request on every task and the`,
    `    ...plat.spawnOpts(),
    });
  } catch (err) {
    engineProc = null;
    log('engine spawn error: ' + err.message);
    failNativeEngineRuns('engine spawn error: ' + err.message, true);
    return;
  }
  // The engine prints a timestamped line for EVERY status change and request on every task and the`,
    'synchronous native engine spawn cleanup');

  source = replaceOnce(source,
    `  // The engine prints a timestamped line for EVERY status change and request on every task and the`,
    `  const spawnedEngine = engineProc;
  // The engine prints a timestamped line for EVERY status change and request on every task and the`,
    'native engine process identity');
  source = replaceOnce(source,
    `  engineProc.on('error', (err) => { log('engine spawn error: ' + err.message); engineProc = null; });`,
    `  engineProc.on('error', (err) => {
    log('engine spawn error: ' + err.message);
    const ownsCurrentProcess = engineProc === spawnedEngine
      || (pendingTargetEngineStop && pendingTargetEngineStop.proc === spawnedEngine);
    if (!ownsCurrentProcess) return;
    if (engineProc === spawnedEngine) engineProc = null;
    finishTargetEngineStop(spawnedEngine);
    failNativeEngineRuns('engine spawn error: ' + err.message, true);
  });`,
    'native engine process-scoped spawn error');
  source = replaceOnce(source,
    `  engineProc.on('exit', (code) => {
    engineProc = null;`,
    `  engineProc.on('exit', (code) => {
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
    if (engineProc === spawnedEngine) engineProc = null;
    if (gracefulStop) {
      if (!quitting && (pendingTargetStarts.length || pendingPokemonStarts.length)) {
        setImmediate(() => {
          if (!quitting && !engineProc && (pendingTargetStarts.length || pendingPokemonStarts.length)) spawnEngine();
        });
      }
      return;
    }`,
    'native engine graceful-exit lifecycle');

  source = replaceOnce(source, `    if (taskActive) {
      log('engine exited (code ' + code + ')');
      taskActive = false;
      stopLiveEditMonitor();
      cancelAllOtpFetches('Target engine exited');
      // The engine dying takes every task with it, so clear them all rather than a single id.
      for (const id of runningTaskIds) toRenderer('targetDone', { taskId: id });
      runningTaskIds.clear();
      engineTaskSites.clear();
      taskProfileById.clear();
      taskCheckoutConfigById.clear();
      manualCaptchaManager.cancelPending();
      toRenderer('targetDone', { taskId: '' });
    }`, `    if (taskActive || runningTaskIds.size || pokemonTaskIds.size || targetMainMonitorRunning
        || activeMonitorBandwidthRuns.size || pendingTargetStarts.length || pendingPokemonStarts.length) {
      log('engine exited (code ' + code + ')');
      failNativeEngineRuns('Native engine exited', false);
    }`, 'shared native engine-exit cleanup');

  const sharedStopTarget = `function stopTarget(taskId) {
  const requestedId = String(taskId || '');
  if (requestedId) {
    // A start can be queued while the native WebSocket is still connecting. Remove a stopped task
    // from every queued config before the early return below, or flushStart() can resurrect it later.
    removePendingTargetStartTask(requestedId);
    if (engineConn) sendToEngine({ type: 'stop-tasks', messages: [{ id: requestedId }] });
    runningTaskIds.delete(requestedId);
    releaseTargetCookieTask(requestedId);
    engineTaskSites.remove(requestedId);
    taskProfileById.delete(requestedId);
    taskCheckoutConfigById.delete(requestedId);
    taskAccountById.delete(requestedId);
    cancelOtpForTask(requestedId);
    manualCaptchaManager.cancelTask(requestedId);
    toRenderer('targetDone', { taskId: requestedId });
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
  if (pokemonTaskIds.size) { taskActive = true; return; }

  targetMainMonitorPendingStopIds.clear();
  taskActive = false;
  nativeHyperBroker.cancelPending();
  manualCaptchaManager.cancelPending();
  beginTargetEngineStop(engineProc);
}`;
  source = replaceSection(
    source,
    `function stopTarget(taskId) {`,
    `// Called from the app's quit handler.`,
    `${sharedStopTarget}\n\n`,
    'shared native Target stop lifecycle',
  );

  source = replaceOnce(source, `  try { stopTarget(); } catch {}
  if (harvesterSyncTimer)`, `  try { stopTarget(); } catch {}
  try { stopPokemonCenter(); } catch {}
  if (targetCookieDemandRetryTimer) clearTimeout(targetCookieDemandRetryTimer);
  targetCookieDemandRetryTimer = null;
  if (harvesterSyncTimer)`, 'shared native shutdown');

  source = replaceOnce(source,
    `module.exports = { startTarget, stopTarget, editTargetTasks, shutdown, ensureHarvesterBroker, saveHarvesterCookie, syncTargetHarvesters, setTargetHarvestAuthorized, setTargetCookieStandbyTasks, syncTargetCookieBankDemand, targetCookieDemand, getCookieBank, submitOtpManually, sendStockPing, isTaskRunning, runningCount, setTaskProxy, getSkuTitles };`,
    `module.exports = { startTarget, stopTarget, editTargetTasks, startPokemonCenter, stopPokemonCenter, editPokemonCenter, setPokemonCenterTaskProxy, runningPokemonCenterCount, setPokemonQueueStreamHealth, publishPokemonQueueProtection, shutdown, ensureHarvesterBroker, saveHarvesterCookie, syncTargetHarvesters, setTargetHarvestAuthorized, setTargetCookieStandbyTasks, syncTargetCookieBankDemand, targetCookieDemand, getCookieBank, submitOtpManually, sendStockPing, isTaskRunning, runningCount, setTaskProxy, getSkuTitles };`,
    'Pokemon Center native exports');

  opened.source = source;
  saveSource(opened);
}

function patchPlainLog() {
  const opened = openSource('plain-log.js');
  opened.source = replaceOnce(opened.source, `  [/bank: login=\\d+ atc=(\\d+)/i, (m) => \`Security cookies ready: \${m[1]}\`],
  [/signing in|logging in|login success/i, () => 'Signing in'],`, `  [/bank: login=\\d+ atc=(\\d+)/i, (m) => \`Security cookies ready: \${m[1]}\`],
  [/\\[IMAP\\] Connected/i, () => 'Mailbox connected — waiting for the email code'],
  [/\\[IMAP\\] Ignoring stale/i, () => 'Ignoring an older email — waiting for the new code'],
  [/checking the selected profile mailbox/i, () => 'Checking the profile mailbox'],
  [/checking AYCD Inbox/i, () => 'Checking AYCD Inbox for the email code'],
  [/code found .*submitting/i, () => 'Email code found — submitting'],
  [/mailbox fetch failed|Auth code not found|no new Target code/i, () => 'Could not find the new email code — enter it manually'],
  [/no OTP source configured|mailbox reader is missing/i, () => 'Automatic email codes are unavailable — enter it manually'],
  [/signing in|logging in|login success/i, () => 'Signing in'],`, 'Target OTP plain-log rules');
  saveSource(opened);
}

try {
  for (const filename of ['native-engine-contract.js', 'native-hyper-broker.js', 'manual-captcha-manager.js', 'analytics-recorder.js']) {
    fs.copyFileSync(
      path.join(__dirname, '..', 'launcher', filename),
      path.join(helperDirectory, filename),
    );
  }
  patchTarget();
  patchPlainLog();
  console.log(`Patched profile-owned IMAP routing in ${helperDirectory}`);
} catch (error) {
  console.error(`Profile IMAP engine patch failed: ${error.message}`);
  process.exit(1);
}
