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
  'walmart-engine.js': '2fe7f711b28f97317ca5de6940f045c8255b0ada383e32d991274c388672429e',
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
// backend.exe resolves through the launcher, including the verified on-demand runtime path.
const { nodeEnvironment, nodeExecutable } = require('./runtime-paths');`, 'Target native farmer runtime import');

  source = replaceOnce(source, `function enginePath() {
  const packed = process.resourcesPath && path.join(process.resourcesPath, 'engine', plat.engineBin());
  if (packed && fs.existsSync(packed)) return packed;
  return path.join(__dirname, '..', '..', 'backend', plat.engineBin());
}`, `function enginePath() {
  const downloaded = process.env.ZYN_ENGINE_PATH;
  if (downloaded && fs.existsSync(downloaded)) return downloaded;
  const packed = process.resourcesPath && path.join(process.resourcesPath, 'engine', plat.engineBin());
  if (packed && fs.existsSync(packed)) return packed;
  return path.join(__dirname, '..', '..', 'backend', plat.engineBin());
}`, 'Target downloaded engine path');

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
  if (isPackaged()) env.PLAYWRIGHT_BROWSERS_PATH = path.join(process.resourcesPath, 'vendor', 'ms-playwright');`, `  const env = nodeEnvironment({ FORCE_COLOR: '0', HOPE_SHAPE_PORT: String(SHAPE_PORT), HOPE_SHAPE_TOKEN: SHAPE_TOKEN,
    // The farmer watches its stdin for EOF and exits when it closes — the only parent-death
    // signal that survives a crash or an End Task, neither of which runs a quit handler.
    HOPE_PARENT_WATCH: '1', HOPE_OWNER_PID: String(process.pid) });`, 2, 'Target native farmer environment');

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
            lastBankedAt: latestBankedAt(),
          });`, 'Target broker health passthrough');

  source = replaceOnce(source, `// Two acceptable proofs. \`app\` is the explicit marker current builds send; the legacy branch`, `// A cold account initially farms login with one safe lane. Once the
// engine persists its new account session, unlock the staggered ATC lanes in the native farmer.
function signalFarmerSessionReady() {
  const req = http.request({
    host: '127.0.0.1', port: SHAPE_PORT, path: '/session-ready', method: 'POST', timeout: 1200,
    headers: { 'x-hope-token': SHAPE_TOKEN },
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
const taskProfileById = new Map();`, 'Target task/profile map declaration');

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

  source = replaceOnce(source, `      taskActive = false;
      // The engine dying takes every task with it, so clear them all rather than a single id.`, `      taskActive = false;
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

  source = replaceOnce(source, `      runningTaskIds.delete(t.id);
      status('Limit Reached'`, `      runningTaskIds.delete(t.id);
      taskProfileById.delete(t.id);
      status('Limit Reached'`, 'Target capped task cleanup');
  source = replaceOnce(source, `      runningTaskIds.clear();
      toRenderer('targetDone'`, `      runningTaskIds.clear();
      taskProfileById.clear();
      toRenderer('targetDone'`, 'Target exit task cleanup');
  source = replaceOnce(source, `    runningTaskIds.add(t.id);
    taskAccountById.set(t.id, t.accountId || '');`, `    runningTaskIds.add(t.id);
    taskAccountById.set(t.id, t.accountId || '');
    taskProfileById.set(t.id, t.profileId || '');`, 'Target task/profile association');
  source = replaceOnce(source, `      accountId: first.accountId || '',
      sku:`, `      accountId: first.accountId || '',
      profileId: first.profileId || '',
      sku:`, 'Target farmer profile association');
  source = replaceOnce(source, `    runningTaskIds.delete(taskId);
    toRenderer('targetDone'`, `    runningTaskIds.delete(taskId);
    taskProfileById.delete(taskId);
    cancelOtpForTask(taskId);
    toRenderer('targetDone'`, 'Target stopped task cleanup');
  source = replaceOnce(source, `  runningTaskIds.clear();
  toRenderer('targetDone'`, `  runningTaskIds.clear();
  taskProfileById.clear();
  toRenderer('targetDone'`, 'Target full task cleanup');

  // A single broker owns :4727 and the shared bank. Every saved harvester runs as a producer-only
  // child, so browser, route, worker count, schedule, type, and lifecycle remain independent.
  source = replaceOnce(source, `let farmerProc = null;  // the Shape cookie farmer/broker (node bot/shape-farmer.mjs, port 4727)`, `let farmerProc = null;  // the Shape cookie farmer/broker (node bot/shape-farmer.mjs, port 4727)
// Managed harvesters are isolated producer processes. They never bind :4727; each posts signed
// cookies into the single broker above, so one route/browser can be stopped or crash without
// interrupting the shared bank or another harvester.
const harvesterProcs = new Map(); // id -> { proc, fingerprint }
let harvesterSyncTimer = null;`, 'Target managed harvester process state');

  const harvesterConfig = fs.readFileSync(path.join(__dirname, 'target-multi-harvester-config.fragment.js'), 'utf8').trimEnd();
  source = replaceOnce(source, `function botDirPath() {
  return isPackaged() ? path.join(process.resourcesPath, 'bot') : path.join(__dirname, '..', '..', 'bot');
}`, `function botDirPath() {
  return isPackaged() ? path.join(process.resourcesPath, 'bot') : path.join(__dirname, '..', '..', 'bot');
}

${harvesterConfig}`, 'Target managed harvester config');

  source = replaceOnce(source, `function ensureHarvesterBroker() {
  if (quitting) return;                         // never resurrect the broker while shutting down
  if (farmerProc) return;                       // a task's farmer already provides the broker
  if (farmerPending) return;                    // a real farmer is mid-spawn — it wins, it can farm
  if (shapeMethodSetting() !== 'Harvester') return;`, `function ensureHarvesterBroker() {
  if (quitting) return;                         // never resurrect the broker while shutting down
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

  source = replaceOnce(source, `function spawnHarvesterBroker(script, botDir, env) {
  let proc;
  try {
    proc = spawn(findNodeExe(), [script, '--noFarm=true', \`--bankFile=\${bankFile()}\`], { cwd: botDir, stdio: ['pipe', 'pipe', 'pipe'], env, ...plat.spawnOpts() });`, `function spawnHarvesterBroker(script, botDir, env) {
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

  source = replaceOnce(source, `  proc.on('exit', () => { if (farmerProc === proc) { farmerProc = null; brokerOnly = false; } });`, `  proc.on('exit', () => {
    if (farmerProc === proc) { farmerProc = null; brokerOnly = false; }
    if (!quitting && managedHarvesterMode()) setTimeout(ensureHarvesterBroker, 1000);
  });`, 'Target managed broker restart');

  const harvesterProducers = fs.readFileSync(path.join(__dirname, 'target-multi-harvester-producers.fragment.js'), 'utf8').trimEnd();
  source = replaceOnce(source, `// ── config translation: data-manager shapes -> engine JSON ───────────────────────`, `${harvesterProducers}

// ── config translation: data-manager shapes -> engine JSON ───────────────────────`, 'Target managed harvester producers');

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

  source = replaceOnce(source, `module.exports = { startTarget, stopTarget, shutdown, ensureHarvesterBroker, getCookieBank, submitOtpManually, sendStockPing, runningCount, setTaskProxy, getSkuTitles };`, `module.exports = { startTarget, stopTarget, shutdown, ensureHarvesterBroker, syncTargetHarvesters, getCookieBank, submitOtpManually, sendStockPing, runningCount, setTaskProxy, getSkuTitles };`, 'Target managed harvester export');

  opened.source = source;
  saveSource(opened);
}

function patchWalmart() {
  const opened = openSource('walmart-engine.js');
  let source = opened.source;

  source = replaceOnce(source, `// WaitForCode until we send \`received-code {email, code}\`. We fetch the code from the catch-all
// IMAP mailbox (Settings → Email / OTP) using the same proven client the register bots use.`, `// WaitForCode until we send \`received-code {email, code}\`. We fetch from the mailbox stored on the
// profile selected for this Walmart task, so two accounts can poll different inboxes concurrently.`, 'Walmart mailbox ownership comment');
  source = replaceOnce(source, `const otpInFlight = new Set();   // emails we're already fetching, so a repeated request-code is a no-op`, `const otpInFlight = new Set();   // emails we're already fetching, so a repeated request-code is a no-op
let activeConfig = null;`, 'Walmart active profile state');
  source = replaceOnce(source, `  try {
    let s = {};
    try { s = dm.getSettings() || {}; } catch {}
    if (!s.imapHost || !s.imapUser || !s.imapPass) {
      log('[otp] no IMAP mailbox configured — set it in Settings → Email / OTP to auto-solve the login code.');
      return;
    }`, `  try {
    const c = dm.getProfileImap(activeConfig && activeConfig.profileId, addr);
    if (!c.host || !c.user || !c.password) {
      log('[otp] no IMAP mailbox configured on the selected profile — edit that profile to auto-solve login codes.');
      return;
    }`, 'Walmart task mailbox lookup');
  source = replaceOnce(source, `    log('[otp] fetching Walmart login code for ' + addr + ' …');
    const { fetchAuthCode } = await import(pathToFileURL(script).href);
    const imapConfig = { host: s.imapHost, port: Number(s.imapPort) || 993, user: s.imapUser, password: s.imapPass };`, `    log('[otp] fetching Walmart login code for ' + addr + ' from profile mailbox ' + c.user + ' …');
    const { fetchAuthCode } = await import(pathToFileURL(script).href);
    const imapConfig = { host: c.host, port: Number(c.port) || 993, user: c.user, password: c.password };`, 'Walmart profile mailbox client');
  source = replaceOnce(source, `    useOtpLogin: false, startSchedule: '', stopSchedule: '', ignoreLowStock: false,`, `    useOtpLogin: (() => {
      const c = dm.getProfileImap(config.profileId, '');
      return !!(c.host && c.user && c.password);
    })(), startSchedule: '', stopSchedule: '', ignoreLowStock: false,`, 'Walmart task OTP mode');
  source = replaceOnce(source, `function startWalmart(config, mainWindow) {
  win = mainWindow;`, `function startWalmart(config, mainWindow) {
  win = mainWindow;
  activeConfig = config;`, 'Walmart active profile assignment');
  source = replaceOnce(source, `  engineProc = null;
  toRenderer('walmartDone'`, `  engineProc = null;
  activeConfig = null;
  toRenderer('walmartDone'`, 'Walmart active profile cleanup');

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
  patchTarget();
  patchWalmart();
  patchPlainLog();
  console.log(`Patched profile-owned IMAP routing in ${helperDirectory}`);
} catch (error) {
  console.error(`Profile IMAP engine patch failed: ${error.message}`);
  process.exit(1);
}
