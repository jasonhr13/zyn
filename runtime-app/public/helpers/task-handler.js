const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const plat = require('./platform');

// In Electron, process.execPath is the app binary — find a real node runtime.
const { nodeEnvironment, nodeExecutable } = require('./runtime-paths');
const findNodePath = nodeExecutable;

// taskId → childProcess
const running = {};

function parseLine(line, taskId, mainWindow) {
  mainWindow.webContents.send('taskLog', { taskId, threadId: 1, line });

  if (/ORDER CONFIRMED/i.test(line)) {
    mainWindow.webContents.send('taskThreadStatus', { taskId, threadId: 1, status: 'confirmed' });
  } else if (/declined|refused|payment.*(fail|declin)/i.test(line)) {
    mainWindow.webContents.send('taskThreadStatus', { taskId, threadId: 1, status: 'declined' });
  } else if (/MANUAL.*launch|launching manual|headed browser/i.test(line)) {
    mainWindow.webContents.send('taskThreadStatus', { taskId, threadId: 1, status: 'manual' });
  } else if (/ERROR:|FAILED:|FATAL/i.test(line)) {
    mainWindow.webContents.send('taskThreadStatus', { taskId, threadId: 1, status: 'error' });
  } else if (/queue.it validated|bypass|timer|checking out|navigat/i.test(line)) {
    mainWindow.webContents.send('taskThreadStatus', { taskId, threadId: 1, status: 'running' });
  }
}

function makeLineRelay(taskId, mainWindow) {
  let buf = '';
  return (chunk) => {
    buf += chunk.toString();
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();  // last element may be an incomplete line
    for (const raw of lines) {
      const line = raw.replace(/\x1b\[[0-9;]*[mGKHF]/g, '').trim();
      if (line) parseLine(line, taskId, mainWindow);
    }
  };
}

async function startTask(taskId, task, cartUrl, profiles, proxyLines, settings, mainWindow, pairedProxy) {
  // The engine is bundled in this repo at ./bot (self-contained). Prefer it AUTHORITATIVELY so a
  // stale settings.botScriptDir (e.g. a pre-move dev path) can't silently run an OLD copy of the
  // engine — that footgun made engine edits not take effect and broke fresh installs. Only fall back
  // to a configured botScriptDir if the bundled engine is somehow missing. __dirname = public/helpers.
  // In a packaged build __dirname is inside app.asar, and bot/ is shipped alongside it via
  // extraResources — NOT inside the archive. Resolving '../../bot' there pointed at
  // resources/app.asar/bot, which does not exist, so every packaged install failed with
  // "bot script not found" and Secret Lair could not run at all. Mirrors target-engine's botDirPath.
  const isPackaged = (() => { try { return require('electron').app.isPackaged; } catch { return false; } })();
  const bundledDir = isPackaged
    ? path.join(process.resourcesPath, 'bot')
    : path.join(__dirname, '..', '..', 'bot');
  const scriptDir = fs.existsSync(path.join(bundledDir, 'secret-lair-browserless.mjs'))
    ? bundledDir
    : (settings.botScriptDir || bundledDir);
  const script = path.join(scriptDir, 'secret-lair-browserless.mjs');

  if (!fs.existsSync(script)) {
    mainWindow.webContents.send('taskLog', {
      taskId, threadId: 1,
      line: `ERROR: bot script not found at ${script} — check Settings → Bot Script Dir`,
    });
    mainWindow.webContents.send('taskDone', { taskId });
    return;
  }

  // Resolve the single profile for this task
  const pid = task.profileId || (task.profileIds && task.profileIds[0]);
  const profile = pid
    ? profiles.find(p => p.id === pid)
    : profiles[0];

  if (!profile) {
    mainWindow.webContents.send('taskLog', { taskId, threadId: 1, line: 'ERROR: no profile assigned to this task — edit the task and select a profile' });
    mainWindow.webContents.send('taskDone', { taskId });
    return;
  }

  // Per-task isolation: each task writes its OWN config + proxy pool so parallel tasks can't clobber
  // each other. The old shared secret-lair-profiles.json / proxies.txt were last-write-wins, which is
  // why one task would run another's profile (e.g. "main copy" ran "test"). Mirrors P-Bandai's
  // per-instance pattern (pbandai-config.<id>.json). Both filename variants are gitignored.
  const safeTaskId  = String(taskId).replace(/[^a-zA-Z0-9_-]/g, '_');
  const configPath  = path.join(scriptDir, `secret-lair-profiles.${safeTaskId}.json`);
  const proxiesPath = path.join(scriptDir, `proxies.${safeTaskId}.txt`);

  const productUrl = task.productUrl || settings.defaultProductUrl || '';
  // Keep the profiling call's productId in sync with the actual product URL so a new drop needs no
  // code edit (the engine's SF.productId is only a fallback). userId/tokens stay the store's merchant
  // values. Explicit settings.drop / task.drop overrides win over the URL-derived id.
  const drop = { ...(settings.drop || {}), ...(task.drop || {}) };
  const pidFromUrl = productUrl.match(/\/product\/(\d+)/);
  if (pidFromUrl && !drop.productId) drop.productId = pidFromUrl[1];

  const profilesConfig = {
    productUrl,
    variant: task.variant || null,
    // Secret Lair checkout results go only to the webhook the user configured in Settings. The
    // recovered runtime carried a hardcoded collector credential inside the bot source.
    webhook: settings.discordWebhook || '',
    maxConcurrent: 1,
    profiles: [profile],
    ...(Object.keys(drop).length ? { drop } : {}),
  };

  try {
    fs.writeFileSync(configPath, JSON.stringify(profilesConfig, null, 2), 'utf8');
  } catch (err) {
    mainWindow.webContents.send('taskLog', { taskId, threadId: 1, line: `ERROR: cannot write profiles config — ${err.message}` });
    mainWindow.webContents.send('taskDone', { taskId });
    return;
  }

  // Per-task proxy pool (isolated file) — clears any stale proxies from previous runs
  fs.writeFileSync(proxiesPath, proxyLines.join('\n'), 'utf8');

  const qty = Math.max(1, parseInt(task.qty) || 1);
  const proxyOffset = Math.floor(Math.random() * 10000);
  // The paired proxy (from the queue pass) is the IP the token is bound to — it MUST win over
  // the task's proxy pool. Passed as --proxy=ip:port:user:pass; the bot prioritizes it.
  const args = [script, cartUrl, '1', String(qty), String(proxyOffset),
    `--config=${configPath}`, `--proxies=${proxiesPath}`,
    // The queue pass carries the proxy StellarAIO cleared the queue through, and Queue-It binds the
    // token to that IP — so normally it must win over the task's own pool. In practice those
    // credentials keep coming back 407 from a different machine (whether the value is mis-parsed or
    // the provider whitelists by source IP), which kills the run outright. useQueuePassProxy: false
    // ignores the paired proxy and uses the task's own group instead.
    ...(pairedProxy && settings.useQueuePassProxy !== false ? [`--proxy=${pairedProxy}`] : []),
    ...(task.browserMode === 'headed' ? ['--headed'] : []),
  ];

  const usingPaired = pairedProxy && settings.useQueuePassProxy !== false;
  const proxyNote = usingPaired
    ? ` · proxy ${pairedProxy.split(':')[0]} (paired)`
    : (pairedProxy ? ' · paired proxy ignored (useQueuePassProxy off)' : '');
  // Running with neither a paired proxy nor a pool means the checkout goes out on the machine's own
  // connection. Worth saying out loud rather than discovering it from a block.
  if (!usingPaired && !proxyLines.length) {
    mainWindow.webContents.send('taskLog', { taskId, threadId: 1,
      line: 'WARNING: no paired proxy and no proxies in this task\'s group — running on your own IP.' });
  }
  mainWindow.webContents.send('taskLog', { taskId, threadId: 1, line: `Starting: ${profile.profileName || profile.email} · qty ${qty}${proxyNote} · ${cartUrl.slice(0, 60)}…` });
  mainWindow.webContents.send('taskThreadStatus', { taskId, threadId: 1, status: 'running' });

  // Point Playwright at the browsers shipped in resources/vendor/ms-playwright. Without this the
  // packaged app looked in the user's ~/AppData/Local/ms-playwright, which is empty unless they
  // happen to be a Playwright developer — "Executable doesn't exist at ...chromium-1228". Every
  // other spawn site here already did this; the Secret Lair path was the one that didn't.
  const slEnv = nodeEnvironment({ FORCE_COLOR: '0' });

  const proc = spawn(findNodePath(), args, {
    cwd: scriptDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: slEnv,
    // posix only: process-group leader, so killTree reaches the Playwright Chromium grandchild the
    // same way taskkill /T does on Windows. No-op on Windows.
    ...plat.spawnOpts(),
  });

  const relay = makeLineRelay(taskId, mainWindow);
  proc.stdout.on('data', relay);
  proc.stderr.on('data', relay);

  proc.on('error', (err) => {
    mainWindow.webContents.send('taskLog', { taskId, threadId: 1, line: `FATAL: ${err.message}` });
    mainWindow.webContents.send('taskThreadStatus', { taskId, threadId: 1, status: 'error' });
  });

  proc.on('close', (code) => {
    delete running[taskId];
    const finalStatus = code === 0 ? 'done' : 'error';
    mainWindow.webContents.send('taskLog', { taskId, threadId: 1, line: `Process exited (code ${code})` });
    mainWindow.webContents.send('taskThreadStatus', { taskId, threadId: 1, status: finalStatus });
    mainWindow.webContents.send('taskDone', { taskId });
  });

  running[taskId] = proc;
}

// Kill the whole tree: proc is `node`, but its Playwright-spawned Chromium is a grandchild. A plain
// proc.kill() only signals node and orphans the browser window — so "Stop" appeared to do nothing.
// See platform.killTree: Windows uses taskkill /T, posix signals the process group.
const killTree = plat.killTree;

function stopTask(taskId) {
  const proc = running[taskId];
  if (!proc) return;
  killTree(proc);
  delete running[taskId];
}

// Every Secret Lair task child (and its Chromium tree). Needed before an update installs: a running
// child holds file handles inside resources/, and NSIS cannot replace a locked file, so the
// installer aborts and the app reopens on the old version with the update still pending.
function stopAllTasks() {
  for (const id of Object.keys(running)) stopTask(id);
}

// ── P-Bandai engine (separate Playwright script: bot/pbandai-buyer.mjs) ─────────
// Multi-account: one child per instance, keyed by instanceId (= the profile id), so
// N monitors run in parallel — mirrors the `running` map used for Secret Lair tasks.
const pbRunning = {}; // instanceId -> childProcess
const pbTokens  = {}; // instanceId -> unique token for the CURRENT child (identity across map mutations)
// Keep PBANDAI_VERSION in sync with VERSION in bot/pbandai-buyer.mjs.
const PBANDAI_VERSION = 'v1.6.20';

function startPbandai({ instanceId, mode, productCode, codes, interval, qty, area, profile, proxyPool, webhook, turbo, headless, login, dry, inHouse, inHousePool, rotate, buyerDiscord, dashboardKey, drop, proxyLabel }, mainWindow, callbacks = {}) {
  // callbacks.onStatus(state, detail) fires on each @@STATUS ('success' = order placed); callbacks.onExit(code)
  // fires when the child closes. Both are optional — used for last-order recording and Rotate Mode.
  const { onStatus, onExit, onCarted } = callbacks;
  const hasProxy = Array.isArray(proxyPool) && proxyPool.length > 0;
  const id = String(instanceId || (profile && profile.id) || 'default');
  const tag = (profile && (profile.profileName || profile.email)) || id;
  // Guard against the window being torn down while a child is still emitting: on app close the
  // webContents is destroyed but the Playwright child keeps logging, and send() would throw
  // "Object has been destroyed". Swallow once the window is gone.
  const alive = () => { try { return mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed(); } catch { return false; } };
  const send = (line) => { if (alive()) { try { mainWindow.webContents.send('pbandaiLog', { instanceId: id, tag, line }); } catch {} } };
  const done = () => { if (alive()) { try { mainWindow.webContents.send('pbandaiDone', { instanceId: id }); } catch {} } };
  const isMonitor = mode === 'monitor';
  const isCoupon = mode === 'coupon';   // no SKU/product — it just logs in and reads /mypage/coupon
  if (isMonitor) { if (!codes || !codes.length) { send('ERROR: monitor has no SKUs'); done(); return; } }
  else if (!isCoupon && !productCode) { send('ERROR: no product code'); done(); return; }

  // Packed builds ship the engine + a Node 20 runtime + Chromium under resources/ so friends
  // need nothing installed; dev runs from source with system Node + the global Playwright cache.
  let isPacked = false;
  try { isPacked = require('electron').app.isPackaged; } catch {}
  const botDir = isPacked ? path.join(process.resourcesPath, 'bot') : path.join(__dirname, '..', '..', 'bot');
  // Packed builds run the bytecode engine via its loader; dev runs the plaintext ESM source.
  const script = path.join(botDir, isPacked ? 'pbandai-buyer.loader.js' : 'pbandai-buyer.mjs');
  if (!fs.existsSync(script)) { send(`ERROR: engine not found at ${script}`); done(); return; }

  // Node runtime + writable/persistent data dir for per-account config + Chromium profiles.
  let nodeExe = findNodePath();
  const spawnEnv = nodeEnvironment({ FORCE_COLOR: '0' });
  // Auto-login credentials go via env ONLY. They must never be written into the config file
  // below (that lands on disk), which would defeat the safeStorage encryption at rest.
  if (login && login.email && login.password) {
    spawnEnv.PB_LOGIN_EMAIL = login.email;
    spawnEnv.PB_LOGIN_PASS  = login.password;
  }
  let dataDir = botDir;
  if (isPacked) {
    try { dataDir = path.join(require('electron').app.getPath('userData'), 'pbandai'); fs.mkdirSync(dataDir, { recursive: true }); } catch {}
  }

  const card = profile ? {
    number: profile.payment?.cardNumber || '',
    month:  profile.payment?.cardMonth || '',
    year:   profile.payment?.cardYear || '',
    cvv:    profile.payment?.cardCvv || '',
    name:   profile.payment?.cardName || `${profile.shipping?.firstName || ''} ${profile.shipping?.lastName || ''}`.trim(),
  } : { number: '', month: '', year: '', cvv: '', name: '' };

  // Per-instance config + Chromium profile dir so instances never clobber each other's
  // card/proxy/cookies (the shared single file was also a race even with one account).
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '_');
  const configPath = path.join(dataDir, `pbandai-config.${safeId}.json`);
  const profileDir = path.join(dataDir, `pbandai-profile-${safeId}`);
  // One-time migration: the first instance adopts the legacy single-profile login session.
  try {
    const legacyDir = path.join(dataDir, 'pbandai-profile');
    if (!fs.existsSync(profileDir) && fs.existsSync(legacyDir)) fs.renameSync(legacyDir, profileDir);
  } catch {}

  // inHouse: when the user has no personal proxies, let the engine decrypt the bundled pool itself.
  // The plaintext list is never written here — this config file lands on disk.
  // Shipping profile for the account's saved address (P-Bandai checkout uses the SAVED address, and
  // a fresh account has none). Location Name = the profile name; dialing code and area are fixed for
  // the US store. This lands in the config file, which already holds the card — same sensitivity.
  const shipping = profile ? {
    locationName: profile.profileName || `${profile.shipping?.firstName || ''} ${profile.shipping?.lastName || ''}`.trim() || 'Home',
    firstName: profile.shipping?.firstName || '',
    lastName:  profile.shipping?.lastName  || '',
    address:   profile.shipping?.address   || '',
    address2:  profile.shipping?.address2  || '',
    city:      profile.shipping?.city      || '',
    state:     profile.shipping?.state     || '',
    zip:       profile.shipping?.zipcode   || '',
    phone:     profile.phone               || '',
    dialCode:  '+1',
    area:      'USA',
  } : null;
  // account: the P-Bandai login email (falls back to the profile email/name) — for the webhook's
  // Account field only. Just an identifier; the config file already holds the card, so this adds no
  // new sensitivity. The password is NEVER written here (it goes via env).
  const account = (login && login.email) || (profile && profile.email) || tag;
  const cfg = { area: area || 'us', account, card, shipping, proxy: (hasProxy ? proxyPool[0] : ''), proxyPool: proxyPool || [], webhook: webhook || '', loginWaitMin: 4, inHouse: !!inHouse, inHousePool: inHousePool || '1', buyerDiscord: buyerDiscord || '', dashboardKey: dashboardKey || '', proxyLabel: proxyLabel || '' };
  try {
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');
  } catch (err) { send(`ERROR writing config: ${err.message}`); done(); return; }

  // Replace any existing run under this id (the same account can't run twice). killTree, not a plain
  // kill — on Windows a bare SIGTERM signals only node and orphans its Playwright Chromium grandchild.
  if (pbRunning[id]) { killTree(pbRunning[id]); delete pbRunning[id]; }

  const args = mode === 'coupon'
    // Coupon Mode: log in, read /mypage/coupon, emit @@STATUS coupon|has/none, exit. No card/SKU needed.
    ? [script, '--check-coupon', `--id=${id}`, `--config=${configPath}`, `--profile-dir=${profileDir}`, ...(headless ? ['--headless'] : [])]
    : isMonitor
    ? [script, '--monitor', `--codes=${codes.join(',')}`, `--interval=${interval || 15}`, String(qty || 1), `--id=${id}`, `--config=${configPath}`, `--profile-dir=${profileDir}`, ...(turbo ? ['--turbo'] : []), ...(headless ? ['--headless'] : []), ...(rotate ? ['--rotate'] : []), ...(drop ? ['--drop'] : [])]
    // --nopay = dry run: fills the card and stops BEFORE Pay, so nothing is ever purchased.
    : [script, productCode, String(qty || 1), `--id=${id}`, `--config=${configPath}`, `--profile-dir=${profileDir}`, ...(dry ? ['--nopay'] : []), ...(headless ? ['--headless'] : []), ...(drop ? ['--drop'] : [])];
  const proxyName = proxyLabel || 'VPN';   // the chosen proxy-list name (falls back to "VPN" for the in-house pool)
  // In a PACKAGED build the in-house pools ship encrypted (.enc) and the engine decrypts them itself, so
  // proxyPool is empty here even though a proxy IS used — treat inHouse as "using a proxy" so the banner
  // doesn't falsely read "no proxy". The IP count is only known when we actually hold the list (hasProxy).
  const usingProxy = hasProxy || inHouse;
  const ipCount = hasProxy ? ` (${proxyPool.length} IP${proxyPool.length > 1 ? 's' : ''})` : '';
  send(mode === 'coupon'
    ? `🎟 Coupon check${usingProxy ? ` · proxy ${proxyName}` : ' · no proxy'}`
    : isMonitor
    ? `Starting MONITOR ${PBANDAI_VERSION} · ${codes.length} SKU(s) every ${interval || 15}s${usingProxy ? ` · proxy ${proxyName}${ipCount}` : ' · no proxy'}${turbo ? ' · ⚡TURBO' : ''}`
    : `Starting ${PBANDAI_VERSION} · ${productCode} x${qty || 1}${dry ? ' · 🧪 TEST RUN (stops before Pay)' : ''}${usingProxy ? ` · proxy ${proxyName}` : ' · no proxy'}`);

  const proc = spawn(nodeExe, args, {
    cwd: botDir, stdio: ['pipe', 'pipe', 'pipe'], env: spawnEnv, ...plat.spawnOpts(),
  });
  pbRunning[id] = proc;
  const token = {};          // unique per spawn; identifies THIS child even after pbRunning[id] is deleted
  pbTokens[id] = token;

  let buf = '';
  const relay = (chunk) => {
    buf += chunk.toString();
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    for (const raw of lines) {
      const line = raw.replace(/\x1b\[[0-9;]*[mGKHF]/g, '').replace(/\s+$/, '');
      if (!line) continue;
      // Restock detected by this account → tell every OTHER running account to fire now.
      const rm = line.match(/^@@RESTOCK\s+(\S+)(?:\s+(\S+))?/);
      if (rm) {
        const cmd = `@@FIRE ${rm[1]}${rm[2] ? ' ' + rm[2] : ''}\n`;
        let n = 0;
        for (const otherId of Object.keys(pbRunning)) {
          if (otherId === id) continue;
          try { pbRunning[otherId].stdin.write(cmd); n++; } catch {}
        }
        send(`📡 restock ${rm[1]} → broadcast to ${n} other account(s)`);
        continue;
      }
      // Structured per-account status → drives the UI board (not shown as a log line).
      const sm = line.match(/^@@STATUS\s+([^|]*)\|?(.*)$/);
      if (sm) {
        const state = sm[1].trim(), detail = (sm[2] || '').trim();
        mainWindow.webContents.send('pbandaiStatus', { instanceId: id, tag, state, detail });
        if (onStatus) { try { onStatus(state, detail); } catch {} }
        continue;
      }
      // "This account got the item into its cart" — persisted by main for restart prioritisation.
      const cm = line.match(/^@@CARTED\s+(\S+)/);
      if (cm) { if (onCarted) { try { onCarted(cm[1]); } catch {} } continue; }
      send(line);
    }
  };
  proc.stdout.on('data', relay);
  proc.stderr.on('data', relay);
  proc.on('error', (err) => send(`FATAL: ${err.message}`));
  proc.on('close', (code) => {
    send(`Process exited (code ${code})`); done();
    if (pbRunning[id] === proc) delete pbRunning[id];
    // `own` is true only for the child that is still the CURRENT one for this id. It stays true after
    // stopPbandai (which deletes pbRunning[id] but not the token), so a deliberate stop-after-order
    // still rotates; it's false once a newer child replaced this id, so a stale close can't refill.
    const own = pbTokens[id] === token;
    if (own) { delete pbTokens[id]; if (onExit) { try { onExit(code); } catch {} } }
  });
}

// Manual FORCE from the UI: tell this account's engine to brute add-to-cart now.
function forcePbandai(instanceId) {
  const id = String(instanceId || 'default');
  const proc = pbRunning[id];
  if (proc) { try { proc.stdin.write('@@FORCE\n'); } catch {} }
}

// Manual proxy rotate from the UI: relaunch this account's browser on a different proxy.
function rotatePbandaiProxy(instanceId) {
  const id = String(instanceId || 'default');
  const proc = pbRunning[id];
  if (proc) { try { proc.stdin.write('@@ROTATE\n'); } catch {} }
}

// Manual resume from the UI: un-park an account that stopped on an unclear result / bank
// verification / dry run. The engine reloads the page and re-fires the checkout from there.
function resumePbandai(instanceId) {
  const id = String(instanceId || 'default');
  const proc = pbRunning[id];
  if (proc) { try { proc.stdin.write('@@RESUME\n'); } catch {} }
}

function pbandaiDataDir() {
  let isPacked = false; try { isPacked = require('electron').app.isPackaged; } catch {}
  if (isPacked) { try { return path.join(require('electron').app.getPath('userData'), 'pbandai'); } catch {} }
  return path.join(__dirname, '..', '..', 'bot');
}

// Wipe an account's Chromium profile so it next starts with a FRESH Shape/browser identity + a
// fresh login. A persistent HTTP 501 on ATC is a flagged SESSION/device (not the IP) — proven by
// fresh IPs not clearing it — so a clean profile is the actual fix. Stops the account first.
function resetPbandaiSession(instanceId, mainWindow) {
  const id = String(instanceId || 'default');
  const send = (line) => { try { mainWindow.webContents.send('pbandaiLog', { instanceId: id, tag: id, line }); } catch {} };
  if (pbRunning[id]) { killTree(pbRunning[id]); delete pbRunning[id]; }
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '_');
  const dir = path.join(pbandaiDataDir(), `pbandai-profile-${safeId}`);
  send('🧹 Reset session — wiping the browser profile for a fresh Shape identity (re-login on next Start)…');
  setTimeout(() => { // let the just-killed Chromium release its file locks
    if (!fs.existsSync(dir)) { send('✓ Already fresh (no saved profile). Start again and log in.'); return; }
    try { fs.rmSync(dir, { recursive: true, force: true }); send('✓ Session wiped. Start Monitor again and log in on the clean identity.'); }
    catch {
      try { fs.renameSync(dir, `${dir}.old-${Date.now()}`); send('✓ Session moved aside. Start Monitor again and log in.'); }
      catch (e2) { send(`⚠ Couldn't wipe the profile (browser may still be closing): ${e2.message}. Wait a few seconds and try Reset again.`); }
    }
  }, 2000);
}

// killTree, not proc.kill: a bare SIGTERM on Windows kills only node and orphans the Playwright
// Chromium grandchild — which in Rotate Mode would let browser windows pile up past the cap.
function stopPbandai(instanceId) {
  const id = String(instanceId || 'default');
  const proc = pbRunning[id];
  if (proc) { killTree(proc); delete pbRunning[id]; }
}

// ── Round1 / ShortStack registration (bot/round1-register.mjs) ──────────────────
// One child per profile, same shape as P-Bandai: N signups race the same form on their own proxies.
// Round1 needs far less than a checkout task — a name, an email and a pickup store, no card and no
// address — so the profile fields are read leniently rather than assuming a full checkout profile.
const r1Running = {};   // instanceId -> childProcess

function startRound1({ instanceId, profile, proxy, url, offscreen, giveUpHours, requestMode, solverProvider, solverKey, dryRun }, mainWindow, callbacks = {}) {
  const { onStatus, onExit } = callbacks;
  const id = String(instanceId || (profile && profile.id) || 'default');
  const tag = (profile && (profile.profileName || profile.email)) || id;
  const alive = () => { try { return mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed(); } catch { return false; } };
  const send = (line) => { if (alive()) { try { mainWindow.webContents.send('round1Log', { instanceId: id, tag, line }); } catch {} } };
  const done = (code) => { if (alive()) { try { mainWindow.webContents.send('round1Done', { instanceId: id, code }); } catch {} } };

  if (r1Running[id]) { send('already running for this profile'); return; }
  if (!url) { send('ERROR: no campaign URL'); done(1); return; }

  // Round1 profiles carry different fields from checkout profiles, and a signup with a blank name or
  // a missing store is a wasted entry rather than a visible failure — so refuse up front and say which.
  const p = profile || {};
  const fields = {
    first: p.first || p.firstName || p.shipping?.firstName || '',
    last: p.last || p.lastName || p.shipping?.lastName || '',
    email: p.email || p.login?.email || '',
    store: p.store || p.round1Store || '',
  };
  const missing = Object.entries(fields).filter(([, v]) => !String(v).trim()).map(([k]) => k);
  if (missing.length) { send(`ERROR: profile is missing ${missing.join(', ')}`); done(1); return; }

  let isPacked = false;
  try { isPacked = require('electron').app.isPackaged; } catch {}
  const botDir = isPacked ? path.join(process.resourcesPath, 'bot') : path.join(__dirname, '..', '..', 'bot');
  // REQUEST MODE spawns a different engine entirely: no Playwright, no window, and Turnstile solved
  // by a captcha service instead of a real browser. It is the same shape as the competing bot whose
  // log only ever says "Polling for captcha".
  //
  // Opt-in, and off by default, because the submit call is the one part of that flow never observed
  // against a live form -- everything upstream of it is verified, the POST itself is not.
  const useRequest = !!requestMode && !!solverKey;
  const script = path.join(botDir, useRequest ? 'round1-register-request.mjs' : 'round1-register.mjs');
  if (!fs.existsSync(script)) { send(`ERROR: engine not found at ${script}`); done(1); return; }

  let nodeExe = findNodePath();
  const spawnEnv = nodeEnvironment({ FORCE_COLOR: '0' });
  if (isPacked) {
  }

  const args = [script, `--url=${url}`,
    `--first=${fields.first}`, `--last=${fields.last}`, `--email=${fields.email}`, `--store=${fields.store}`,
    `--marketing=${p.marketing ? 'true' : 'false'}`,
    `--offscreen=${offscreen === false ? 'false' : 'true'}`,
    `--giveUpHours=${giveUpHours || 16}`];
  // Proxies go on the command line to match the other engines. Noted rather than hidden: every
  // process on the machine can read this, so a per-user credential belongs here, not a shared pool.
  if (proxy) args.push(`--proxy=${proxy}`);
  if (useRequest) {
    args.push(`--solver=${solverProvider || 'capsolver'}`, `--solverKey=${solverKey}`);
    if (dryRun) args.push('--dryRun=true');
  }

  let proc;
  try {
    proc = spawn(nodeExe, args, { cwd: botDir, stdio: ['pipe', 'pipe', 'pipe'], env: spawnEnv, ...plat.spawnOpts() });
  } catch (err) { send(`FATAL: could not start — ${err.message}`); done(1); return; }
  r1Running[id] = proc;
  send(`▶ Round1 — ${fields.first} ${fields.last} <${fields.email}> @ "${fields.store}"`);

  let buf = '';
  const relay = (chunk) => {
    buf += chunk.toString();
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const sm = line.match(/^@@STATUS\s+([^|]*)\|?(.*)$/);
      if (sm) {
        const state = sm[1].trim(), detail = (sm[2] || '').trim();
        if (alive()) { try { mainWindow.webContents.send('round1Status', { instanceId: id, tag, state, detail }); } catch {} }
        if (onStatus) { try { onStatus(state, detail); } catch {} }
        continue;
      }
      // Cloudflare state travels on its own channel. Folding it into @@STATUS would mean the board
      // could show "solving" or "watching" but never both, and which of the two is true matters.
      const cm = line.match(/^@@CF\s+([^|]*)\|?(.*)$/);
      if (cm) {
        if (alive()) {
          try { mainWindow.webContents.send('round1Cf', { instanceId: id, tag, cf: cm[1].trim(), detail: (cm[2] || '').trim() }); } catch {}
        }
        continue;
      }
      send(line);
    }
  };
  proc.stdout.on('data', relay);
  proc.stderr.on('data', relay);
  proc.on('error', (err) => send(`FATAL: ${err.message}`));
  proc.on('close', (code) => {
    if (r1Running[id] === proc) delete r1Running[id];
    send(`Process exited (code ${code})`);
    done(code);
    if (onExit) { try { onExit(code); } catch {} }
  });
}

function stopRound1(instanceId) {
  const id = String(instanceId || 'default');
  const proc = r1Running[id];
  if (proc) { killTree(proc); delete r1Running[id]; }
}

function stopAllRound1() {
  for (const id of Object.keys(r1Running)) { killTree(r1Running[id]); delete r1Running[id]; }
}

function stopAllPbandai() {
  for (const id of Object.keys(pbRunning)) { killTree(pbRunning[id]); delete pbRunning[id]; }
}

function isRunning(taskId) { return !!running[taskId]; }

// ── Generic bot-script runner (used by the Generate tab) ────────────────────────
// Mirrors startTask/startPbandai's spawn pattern (node resolution, log relay, killTree lifecycle)
// instead of a one-off child_process call, so it gets the same Windows-process-tree handling.
const genRunning = {}; // runId -> childProcess, so Stop can kill the CURRENT account's browser mid-run

function runBotScript(scriptName, args, mainWindow, runId) {
  return new Promise((resolve) => {
    // BUG FIX (reported live by a beta tester, 2026-07-18): this always resolved botDir from
    // __dirname, which inside a packaged build is resources/app.asar/public/helpers — but the
    // Generate-tab scripts are shipped as real files under resources/bot (via extraResources),
    // a SIBLING of app.asar, never inside it. Every packaged run failed with "Script not found"
    // for every module (Bandai/Target/Walmart/iCloud). Mirrors startPbandai's own isPacked
    // branching above, which already gets this right for the P-Bandai checkout engine.
    let isPacked = false;
    try { isPacked = require('electron').app.isPackaged; } catch {}
    const botDir = isPacked ? path.join(process.resourcesPath, 'bot') : path.join(__dirname, '..', '..', 'bot');
    const script = path.join(botDir, scriptName);
    if (!fs.existsSync(script)) {
      resolve({ success: false, error: `Script not found: ${script}` });
      return;
    }

    const alive = () => { try { return mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed(); } catch { return false; } };
    // runId tagged on every line so the renderer can attribute output when multiple bot scripts run
    // concurrently (up to 5 Generate-tab accounts at once) — previously untagged, so concurrent runs'
    // stdout would interleave into one indistinguishable stream.
    const send = (line) => { if (alive()) { try { mainWindow.webContents.send('botScriptLog', { runId, line }); } catch {} } };

    // Packaged builds reuse the signed Electron executable as native Node and point it at the
    // architecture-matched Playwright runtime through nodeEnvironment().
    let nodeExe = findNodePath();
    const spawnEnv = nodeEnvironment({ FORCE_COLOR: '0' });
    let dataDir = botDir;
    if (isPacked) {
      try { dataDir = path.join(require('electron').app.getPath('userData'), 'generate'); fs.mkdirSync(dataDir, { recursive: true }); } catch {}
    }
    const finalArgs = [script, ...args, ...(args.some(a => a.startsWith('--data-dir=')) ? [] : [`--data-dir=${dataDir}`])];

    const proc = spawn(nodeExe, finalArgs, {
      cwd: botDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: spawnEnv,
      ...plat.spawnOpts(),
    });
    if (runId) genRunning[runId] = proc;

    let buf = '';
    let lastErrLine = '';
    let stopped = false;
    const relay = (chunk) => {
      buf += chunk.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const raw of lines) {
        const line = raw.replace(/\x1b\[[0-9;]*[mGKHF]/g, '').trim();
        if (!line) continue;
        if (/^(ERROR|FAILED|FATAL):/i.test(line)) lastErrLine = line;
        send(line);
      }
    };
    proc.stdout.on('data', relay);
    proc.stderr.on('data', relay);

    proc.on('error', (err) => { if (runId) delete genRunning[runId]; resolve({ success: false, error: err.message }); });
    proc.on('close', (code) => {
      if (runId) delete genRunning[runId];
      if (stopped) { resolve({ success: false, error: 'Stopped by user', stopped: true }); return; }
      resolve(code === 0 ? { success: true } : { success: false, error: lastErrLine || `exited with code ${code}` });
    });

    // Exposed via stopBotScript(runId) — killTree not proc.kill, since a bare SIGTERM on Windows
    // only signals node and orphans the Playwright Chromium grandchild (same reasoning as killTree
    // everywhere else in this file).
    proc._markStopped = () => { stopped = true; };
  });
}

function stopBotScript(runId) {
  const proc = genRunning[runId];
  if (!proc) return false;
  proc._markStopped?.();
  killTree(proc);
  delete genRunning[runId];
  return true;
}

// Quit needs to stop these too, and until now it could not: genRunning is private and the only way
// to reach a child was stopBotScript(runId) with an id that exists solely in the renderer. So every
// Generate-tab run — node plus its whole Playwright/Chromium tree — survived closing the app.
function stopAllBotScripts() {
  for (const runId of Object.keys(genRunning)) stopBotScript(runId);
}

// ── Pokemon Center: single-session queue monitor ────────────────────────────────
// One instance = one browser, one proxy, one account. Scope is intentionally small right now:
// join the queue, report status, and accept a live SKU over stdin — no add-to-cart/checkout yet.
const pcRunning = {}; // instanceId -> childProcess

function startPokemonCenter({ instanceId, proxy, queueUrl, login }, mainWindow, callbacks = {}) {
  const { onStatus } = callbacks;
  const id = String(instanceId || 'default');
  const alive = () => { try { return mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed(); } catch { return false; } };
  const send = (line) => { if (alive()) { try { mainWindow.webContents.send('pokemonLog', { instanceId: id, line }); } catch {} } };
  const done = () => { if (alive()) { try { mainWindow.webContents.send('pokemonDone', { instanceId: id }); } catch {} } };

  let isPacked = false;
  try { isPacked = require('electron').app.isPackaged; } catch {}
  const botDir = isPacked ? path.join(process.resourcesPath, 'bot') : path.join(__dirname, '..', '..', 'bot');
  const script = path.join(botDir, 'pokemoncenter-monitor.mjs');
  if (!fs.existsSync(script)) { send(`ERROR: script not found at ${script}`); done(); return; }

  let nodeExe = findNodePath();
  const spawnEnv = nodeEnvironment({ FORCE_COLOR: '0' });
  // Login stays out of the config file (which lands on disk) — same convention as P-Bandai.
  if (login && login.email && login.password) {
    spawnEnv.PC_LOGIN_EMAIL = login.email;
    spawnEnv.PC_LOGIN_PASS = login.password;
  }
  let dataDir = botDir;
  if (isPacked) {
    try { dataDir = path.join(require('electron').app.getPath('userData'), 'pokemoncenter'); fs.mkdirSync(dataDir, { recursive: true }); } catch {}
  }

  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '_');
  const configPath = path.join(dataDir, `pokemoncenter-config.${safeId}.json`);
  const profileDir = path.join(dataDir, `pokemoncenter-profile-${safeId}`);
  const cfg = { proxy: proxy || '', queueUrl: queueUrl || 'https://www.pokemoncenter.com/', account: (login && login.email) || '' };
  try { fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8'); }
  catch (err) { send(`ERROR writing config: ${err.message}`); done(); return; }

  if (pcRunning[id]) { killTree(pcRunning[id]); delete pcRunning[id]; }

  const args = [script, `--id=${id}`, `--config=${configPath}`, `--profile-dir=${profileDir}`];
  send(`Starting queue monitor${proxy ? ` · proxy ${proxy.split(':')[0]}` : ' · no proxy'}${cfg.account ? ` · ${cfg.account}` : ''}`);

  const proc = spawn(nodeExe, args, { cwd: botDir, stdio: ['pipe', 'pipe', 'pipe'], env: spawnEnv, ...plat.spawnOpts() });
  pcRunning[id] = proc;

  let buf = '';
  const relay = (chunk) => {
    buf += chunk.toString();
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    for (const raw of lines) {
      const line = raw.replace(/\x1b\[[0-9;]*[mGKHF]/g, '').replace(/\s+$/, '');
      if (!line) continue;
      const sm = line.match(/^@@STATUS\s+([^|]*)\|?(.*)$/);
      if (sm) {
        const state = sm[1].trim(), detail = (sm[2] || '').trim();
        if (alive()) mainWindow.webContents.send('pokemonStatus', { instanceId: id, state, detail });
        if (onStatus) { try { onStatus(state, detail); } catch {} }
        continue;
      }
      send(line);
    }
  };
  proc.stdout.on('data', relay);
  proc.stderr.on('data', relay);
  proc.on('error', (err) => send(`FATAL: ${err.message}`));
  proc.on('close', (code) => {
    send(`Process exited (code ${code})`); done();
    if (pcRunning[id] === proc) delete pcRunning[id];
  });
}

// Live SKU push from the UI's "Set SKU" button — read by the running child via stdin.
function setPokemonSku(instanceId, sku) {
  const proc = pcRunning[String(instanceId || 'default')];
  if (proc && sku) { try { proc.stdin.write(`@@SETSKU ${sku}\n`); } catch {} }
}

function stopPokemonCenter(instanceId) {
  const id = String(instanceId || 'default');
  const proc = pcRunning[id];
  if (proc) { killTree(proc); delete pcRunning[id]; }
}

function stopAllPokemonCenter() {
  for (const id of Object.keys(pcRunning)) { killTree(pcRunning[id]); delete pcRunning[id]; }
}

// Live Round1 signups, for the same heartbeat.
function runningRound1Count() { return Object.keys(r1Running).length; }

module.exports = { runningRound1Count, startTask, stopTask, isRunning, startRound1, stopRound1, stopAllRound1, startPbandai, forcePbandai, rotatePbandaiProxy, resumePbandai, resetPbandaiSession, stopPbandai, stopAllPbandai, runBotScript, stopBotScript, stopAllBotScripts, startPokemonCenter, setPokemonSku, stopPokemonCenter, stopAllPokemonCenter, stopAllTasks };
