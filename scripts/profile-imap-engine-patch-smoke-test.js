#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync, spawnSync } = require('child_process');

const project = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zyn-imap-engines-'));
for (const filename of ['target-engine.js', 'walmart-engine.js', 'plain-log.js']) {
  fs.copyFileSync(path.join(project, 'extracted', 'asar', 'public', 'helpers', filename), path.join(directory, filename));
}

execFileSync(process.execPath, [path.join(__dirname, 'patch-profile-imap-engines.js'), directory], { stdio: 'inherit' });
const target = fs.readFileSync(path.join(directory, 'target-engine.js'), 'utf8');
const walmart = fs.readFileSync(path.join(directory, 'walmart-engine.js'), 'utf8');
const plainLog = fs.readFileSync(path.join(directory, 'plain-log.js'), 'utf8');
const nativeEngineContract = path.join(directory, 'native-engine-contract.js');
const nativeHyperBroker = path.join(directory, 'native-hyper-broker.js');
const manualCaptchaManager = path.join(directory, 'manual-captcha-manager.js');
const analyticsRecorder = path.join(directory, 'analytics-recorder.js');
assert.equal(fs.existsSync(nativeEngineContract), true, 'shared native-engine contract was not staged');
assert.equal(fs.existsSync(nativeHyperBroker), true, 'native Hyper broker was not staged');
assert.equal(fs.existsSync(manualCaptchaManager), true, 'manual captcha manager was not staged');
assert.equal(fs.existsSync(analyticsRecorder), true, 'analytics recorder was not staged');
assert.match(target, /require\('\.\/native-engine-contract'\)/);
assert.match(target, /require\('\.\/native-hyper-broker'\)/);
assert.match(target, /require\('\.\/manual-captcha-manager'\)/);
assert.match(target, /require\('\.\/analytics-recorder'\)/);
assert.match(target, /case 'analytics-event':/);
assert.match(target, /analyticsRecorder\.record\(m\)/);
assert.match(target, /toRenderer\('targetOutcome'/,
  'Target analytics outcomes are not forwarded to the renderer checkout counter');
assert.match(target, /toRenderer\('targetRunStarted'/,
  'accepted Target starts do not reset their per-run checkout counter');
assert.match(target, /m\.running === true && runningTaskIds\.has\(id\)\) acceptTargetCookieTasks\(\[\{ id \}\]\)/,
  'only an explicitly running native Target status may increase dynamic cookie demand');
assert.doesNotMatch(target, /m\.running !== false && runningTaskIds\.has\(id\)/,
  'a Target rejection with an omitted running flag must not increase dynamic cookie demand');
assert.match(target, /releaseTargetCookieTask\(id\)/,
  'terminal Target statuses do not reduce dynamic cookie demand');
assert.match(target, /clearTargetCookieTasks\(\)/,
  'full Target shutdown does not clear dynamic cookie demand');
assert.match(target, /pendingStart\.tasks\.filter\(task => String\(task && task\.id \|\| ''\) !== requestedId\)/,
  'stopping a queued task does not remove it from the pending native start envelope');
assert.match(target, /path: '\/demand'/,
  'Target bridge does not publish dynamic demand to the broker');
assert.match(target, /setTargetCookieStandbyTasks/,
  'Target bridge does not expose standby prefill demand');
assert.match(target, /setTargetHarvestAuthorized/,
  'Target bridge does not expose the reversible license gate');
assert.match(target, /if \(!targetHarvestAuthorized\) return;/,
  'Target broker startup is not gated on license authorization');
assert.match(target,
  /if \(quitting \|\| !targetHarvestAuthorized \|\| !mine\) \{ brokerPending = false; return; \}/,
  'a broker port reclaim already in flight can outlive license authorization');
assert.match(target,
  /brokerPending = false;\s+if \(quitting \|\| !targetHarvestAuthorized\) return;/,
  'a broker port-free callback can spawn after license authorization is revoked');
assert.match(target,
  /function spawnHarvesterBroker\(script, botDir, env\) \{\s+if \(!targetHarvestAuthorized\) return;/,
  'the final broker spawn boundary is not fail-closed');
assert.match(target,
  /if \(next && targetHarvestAuthorized && !quitting && !farmerProc\) startFarmer\(next\)/,
  'a queued real farmer can be handed off after license revocation');
assert.equal((target.match(/quitting \|\| !targetHarvestAuthorized \|\| seq !== startSeq/g) || []).length, 2,
  'both asynchronous real-farmer port callbacks must recheck license authorization');
assert.match(target,
  /function startFarmer\(config\) \{\s+if \(!targetHarvestAuthorized\) return;/,
  'the real-farmer entry point is not fail-closed');
assert.match(target,
  /function spawnFarmer\(config\) \{\s+if \(!targetHarvestAuthorized\) return;/,
  'the final real-farmer spawn boundary is not fail-closed');
assert.match(target, /startSeq \+= 1;\s+farmerWanted = null;\s+pendingStart = null;/,
  'full Target stop does not discard queued real-farmer work');
assert.match(target, /demand: j\.demand \|\| targetCookieDemand\(\)/,
  'Target bank UI does not receive broker demand');
assert.match(target, /function saveHarvesterCookie\(cookie\)/,
  'Target bridge does not expose a narrow authenticated extension-save capability');
assert.match(target, /Number\(listenerPid\(SHAPE_PORT\)\) !== Number\(farmerProc\.pid\)/,
  'extension saves do not verify that Zyn still owns the cookie-broker listener');
assert.match(target, /'x-zyn-token': SHAPE_TOKEN/,
  'authenticated extension saves omit the per-launch cookie-broker token');
assert.match(target, /module\.exports = \{[^}]*saveHarvesterCookie/,
  'authenticated extension saves are not exported to the launcher');
assert.doesNotMatch(target, /harvesterBrokerToken/,
  'Target bridge exports the raw cookie-broker secret instead of a narrow save capability');
assert.match(target, /taskState \+ '\|' \+ running/,
  'Target status dedupe omits liveness changes');
assert.match(target, /status\('Limit Reached',[\s\S]{0,120}undefined, false\)/,
  'order-cap refusal does not publish a terminal task status');
assert.match(target, /new engineContract\.TaskSiteRegistry\(\)/);
assert.match(target, /engineContract\.parseEnvelope\(obj\)/);
assert.match(target, /engineContract\.parseEnvelope\(data\)/);
assert.match(target, /engineTaskSites\.register\(t\.id, engineContract\.SITES\.TARGET\)/);
assert.match(target, /engineTaskSites\.remove\((?:taskId|requestedId)\)/);
assert.match(target, /engineTaskSites\.clear\(\)/);
assert.match(target, /case 'hyper-request'/);
assert.match(target, /nativeHyperBroker\.handleEnvelope\(msg/);
assert.match(target, /isActive: \(\) => engineConn === connection/);
assert.match(target, /nativeHyperBroker\.cancelPending\(\)/);
assert.match(target, /case 'solve-captcha'/);
assert.match(target, /manualCaptchaManager\.handleEnvelope\(msg/);
assert.match(target, /manualCaptchaManager\.cancelTask\((?:taskId|requestedId|id)\)/);
assert.match(target, /manualCaptchaManager\.cancelPending\(\)/);
assert.match(target, /dm\.getProfileImap\(profileId, email\)/);
assert.match(target, /'--headless=true'/);
assert.doesNotMatch(target, /'--headless=false'/);
assert.match(target, /`--capturesPerLoad=\$\{capturesPerLoad\}`/);
assert.match(target, /`--loadsPerBrowser=\$\{loadsPerBrowser\}`/);
assert.match(target, /`--blockHeavyResources=\$\{blockHeavyResources\}`/);
assert.match(target, /`--browsers=auto`/);
assert.match(target, /`--sessionReady=\$\{hasSession\}`/);
assert.match(target, /nodeEnvironment/);
assert.match(target, /const findNodeExe = nodeExecutable/);
assert.match(target, /signalFarmerSessionReady\(\)/);
assert.match(target, /health: j\.health \|\| null/);
assert.match(target, /function latestBankedAt\(\)/);
assert.match(target, /lastBankedAt: latestBankedAt\(\)/);
assert.match(target, /taskProfileById\.set\(t\.id, t\.profileId/);
assert.match(target, /useOtpLogin: otpEnabled\(t\.profileId\)/);
assert.match(target, /loopCheckout: \(t\.loopCheckout != null/,
  'Target task payload does not carry the loop-checkout contract flag');
assert.match(target, /endless: \(t\.loopCheckout != null/,
  'Target task payload does not activate the native Target checkout loop');
assert.match(target, /function enforceTargetLoopCheckout\(/,
  'Target looping tasks can bypass the per-account order cap');
assert.match(target, /type: 'edit-tasks',[\s\S]{0,220}monitorItems: items/,
  'Target looping tasks do not remove capped SKUs');
assert.match(target, /taskCheckoutConfigById\.delete\(/,
  'Target loop launch state is not released when a task stops');
assert.match(target, /qty: Number\(\(taskCheckoutConfigById\.get\(tid\)/,
  'Target loop checkout reports do not preserve the configured quantity');

const loopStart = target.indexOf('function enforceTargetLoopCheckout(');
const loopEnd = target.indexOf('\nfunction sendStart(config)', loopStart);
assert.ok(loopStart >= 0 && loopEnd > loopStart, 'could not isolate Target loop enforcement for behavior testing');

const statusStart = target.indexOf('let lastStatusKeys = {};');
const statusEnd = target.indexOf('\n// ── engine binary path', statusStart);
assert.ok(statusStart >= 0 && statusEnd > statusStart, 'could not isolate Target status dedupe for behavior testing');
const statusEvents = [];
const statusContext = { toRenderer: (...args) => statusEvents.push(args) };
vm.runInNewContext(`${target.slice(statusStart, statusEnd)}\nglobalThis.emitTargetStatus = status;`, statusContext);
statusContext.emitTargetStatus('Successful', '#34ca6e', '', 'task-1', 3, true);
statusContext.emitTargetStatus('Successful', '#34ca6e', '', 'task-1', 3, false);
statusContext.emitTargetStatus('Successful', '#34ca6e', '', 'task-1', 3, false);
assert.equal(statusEvents.length, 2,
  'an identical terminal status must pass once when running changes true to false, then dedupe');

const ensureBrokerStart = target.indexOf('function ensureHarvesterBroker()');
const ensureBrokerEnd = target.indexOf('\nfunction spawnHarvesterBroker(', ensureBrokerStart);
assert.ok(ensureBrokerStart >= 0 && ensureBrokerEnd > ensureBrokerStart,
  'could not isolate Target broker startup for authorization race testing');
let reclaimCallback = null;
let portFreeCallback = null;
let brokerSpawns = 0;
const brokerContext = {
  quitting: false,
  targetHarvestAuthorized: true,
  managedHarvesterConfigs: () => [],
  armHarvesterScheduleSync() {},
  syncHarvesterProducers() {},
  farmerProc: null,
  brokerOnly: false,
  farmerPending: false,
  shapeMethodSetting: () => '',
  botDirPath: () => '/tmp',
  path: { join: (...parts) => parts.join('/') },
  fs: { existsSync: () => true },
  nodeEnvironment: value => value,
  SHAPE_PORT: 4727,
  SHAPE_TOKEN: 'test-token',
  process: { pid: 1 },
  brokerPending: false,
  reclaimBrokerPort: callback => { reclaimCallback = callback; },
  whenPortFree: (_port, callback) => { portFreeCallback = callback; },
  spawnHarvesterBroker: () => { brokerSpawns += 1; },
  killTree() {},
  sweepOrphanHarvesters() {},
  log() {},
};
vm.runInNewContext(
  `${target.slice(ensureBrokerStart, ensureBrokerEnd)}\nglobalThis.runEnsureHarvesterBroker = ensureHarvesterBroker;`,
  brokerContext,
);

brokerContext.runEnsureHarvesterBroker();
assert.equal(typeof reclaimCallback, 'function');
brokerContext.targetHarvestAuthorized = false;
reclaimCallback(true);
assert.equal(brokerSpawns, 0, 'revocation during broker reclaim spawned a new broker');
assert.equal(brokerContext.brokerPending, false, 'revocation left broker startup permanently pending');

brokerContext.targetHarvestAuthorized = true;
brokerContext.runEnsureHarvesterBroker();
reclaimCallback(true);
assert.equal(typeof portFreeCallback, 'function');
brokerContext.targetHarvestAuthorized = false;
portFreeCallback(true);
assert.equal(brokerSpawns, 0, 'revocation during broker port probing spawned a new broker');
assert.equal(brokerContext.brokerPending, false, 'revocation left the port probe permanently pending');

const farmerChainStart = target.indexOf('function farmerChainDone()');
const farmerChainClose = target.indexOf('\n}\n', farmerChainStart);
const farmerChainEnd = farmerChainClose < 0 ? -1 : farmerChainClose + 2;
assert.ok(farmerChainStart >= 0 && farmerChainEnd > farmerChainStart,
  'could not isolate queued real-farmer handoff for authorization testing');
let queuedFarmerStarts = 0;
const farmerChainContext = {
  farmerPending: true,
  farmerWanted: { id: 'queued-before-revoke' },
  targetHarvestAuthorized: false,
  quitting: false,
  farmerProc: null,
  startFarmer: () => { queuedFarmerStarts += 1; },
};
vm.runInNewContext(
  `${target.slice(farmerChainStart, farmerChainEnd)}\nglobalThis.finishFarmerChain = farmerChainDone;`,
  farmerChainContext,
);
farmerChainContext.finishFarmerChain();
assert.equal(queuedFarmerStarts, 0, 'revocation resurrected a queued real farmer');
assert.equal(farmerChainContext.farmerWanted, null, 'revocation did not discard queued real-farmer work');
assert.equal(farmerChainContext.farmerPending, false, 'revocation left real-farmer startup pending');

farmerChainContext.targetHarvestAuthorized = true;
farmerChainContext.farmerPending = true;
farmerChainContext.farmerWanted = { id: 'queued-after-reauthorize' };
farmerChainContext.finishFarmerChain();
assert.equal(queuedFarmerStarts, 1, 'reauthorization did not restore queued real-farmer handoff');

const loopEvents = { logs: [], sent: [], stopped: [], statuses: [] };
const loopOrders = { '11111111': 1, '22222222': 0 };
const loopContext = {
  taskCheckoutConfigById: new Map([['loop-task', {
    skus: ['11111111', '22222222'], qty: 2, loopCheckout: true,
  }]]),
  dm: {
    ORDER_LIMIT_MAX: 2,
    targetOrderLimitReached: (_accountId, sku) => loopOrders[sku] >= 2,
    recentTargetOrders: (_accountId, sku) => Array.from({ length: loopOrders[sku] || 0 }),
  },
  log: (...args) => loopEvents.logs.push(args),
  sendToEngine: envelope => { loopEvents.sent.push(envelope); return true; },
  status: (...args) => loopEvents.statuses.push(args),
  stopTarget: taskId => loopEvents.stopped.push(taskId),
};
vm.runInNewContext(`${target.slice(loopStart, loopEnd)}\nglobalThis.runTargetLoopCheck = enforceTargetLoopCheckout;`, loopContext);

loopContext.runTargetLoopCheck('loop-task', 'account-1', '11111111');
assert.equal(loopEvents.sent.length, 0, 'looping task edited its watch list before a SKU reached the cap');
assert.equal(loopEvents.stopped.length, 0, 'looping task stopped after its first permitted order');

loopOrders['11111111'] = 2;
loopContext.runTargetLoopCheck('loop-task', 'account-1', '11111111');
assert.equal(loopEvents.sent.length, 1, 'looping task did not remove a newly capped SKU');
assert.deepEqual(
  JSON.parse(JSON.stringify(loopEvents.sent[0].messages[0].monitorItems.map(item => item.monitorInput))),
  ['22222222'],
);
assert.equal(loopEvents.stopped.length, 0, 'looping task stopped while another watched SKU remained eligible');

loopOrders['22222222'] = 2;
loopContext.runTargetLoopCheck('loop-task', 'account-1', '22222222');
assert.deepEqual(loopEvents.stopped, ['loop-task'], 'looping task did not stop after every watched SKU reached the cap');
assert.equal(loopEvents.statuses.length, 1, 'looping task did not publish its terminal order-limit status');
assert.match(target, /const b = p\.billingSameShipping === false \? \(p\.billing \|\| \{\}\) : s/);
assert.match(target, /billingFirstName: billingFirst, billingLastName: billingLast/);
assert.match(target, /billingAddress1: b\.address/);
assert.match(target, /profileId: first\.profileId/);
assert.match(target, /const otpFetches = new Map\(\)/);
assert.match(target, /receivedAfter/);
assert.match(target, /cancelOtpForTask\((?:taskId|requestedId)\)/);
assert.match(target, /cancelAllOtpFetches\('(?:Target|Native) engine exited'\)/);
assert.match(target, /type: 'code-watcher-ready'/,
  'Target bridge does not acknowledge native OTP watcher readiness');
assert.match(target, /onLog: \(line\) => log\(String\(line\), taskId\)/);
assert.match(target, /Object\.assign\(sentConfigs\.proxies, buildProxyMap\(group\)\)/);
assert.match(target, /buildProxyMap\(group\)\);\s+sendConfigs\(\);\s+}\s+return sendToEngine\(\{ type: 'set-task-proxy'/,
  'live proxy edits must configure the selected group before switching');
assert.match(target, /function editTargetTasks\(config = \{\}\)/,
  'Target bridge omits live task watch-list editing');
assert.match(target, /type: 'edit-tasks', messages/,
  'Target bridge does not use the native runtime-edit protocol');
assert.match(target, /MONITOR_ID \+ '-edit-'/,
  'shared-monitor mode does not scan newly edited SKUs locally');
assert.match(target, /startsWith\(MONITOR_ID\)/,
  'live-edit monitor status is not routed to the module log');
assert.match(target, /startTarget, stopTarget, editTargetTasks/,
  'live task editor is not exported to Electron');
assert.match(target, /function startPokemonCenter\(config = \{\}, mainWindow\)/);
assert.match(target, /function validatePokemonProducts\(/);
assert.match(target, /quantity: product\.quantity/);
assert.match(target, /function editPokemonCenter\(config = \{\}\)/);
assert.match(target, /function stopPokemonCenter\(taskId\)/);
assert.match(target, /engineTaskSites\.register\(id, POKEMON_SITE\)/);
assert.match(target, /type: 'start-tasks', messages: valid/);
assert.match(target, /type: 'edit-tasks', messages/);
assert.match(target, /toRenderer\('pokemonStatus'/);
assert.match(target, /toRenderer\('pokemonInput'/);
assert.match(target, /toRenderer\('pokemonDone'/);
assert.match(target, /const queueMonitorLog = decoded\.startsWith\('\[queue-monitor\]'\)/);
assert.match(target, /startPokemonCenter, stopPokemonCenter, editPokemonCenter/);
assert.match(target, /setPokemonQueueStreamHealth, publishPokemonQueueProtection/);
assert.match(target, /from: String\(p\.from \|\| 'discord-monitor'\)/);
assert.doesNotMatch(target, /const otpInFlight = new Set\(\)/);
assert.doesNotMatch(target, /log\(`\[otp\] code \$\{code\}/);
assert.doesNotMatch(target, /function getImapConfig\(\) \{/);
assert.match(walmart, /dm\.getProfileImap\(activeConfig && activeConfig\.profileId, addr\)/);
assert.match(walmart, /activeConfig = config/);
assert.match(walmart, /dm\.getProfileImap\(config\.profileId, ''\)/);
assert.doesNotMatch(walmart, /useOtpLogin: false/);
assert.match(plainLog, /Mailbox connected — waiting for the email code/);
assert.match(plainLog, /Email code found — submitting/);
assert.match(plainLog, /Could not find the new email code — enter it manually/);

for (const filename of ['target-engine.js', 'walmart-engine.js', 'plain-log.js']) {
  execFileSync(process.execPath, ['--check', path.join(directory, filename)]);
}
execFileSync(process.execPath, ['--check', nativeEngineContract]);
execFileSync(process.execPath, ['--check', nativeHyperBroker]);
execFileSync(process.execPath, ['--check', manualCaptchaManager]);
execFileSync(process.execPath, ['--check', analyticsRecorder]);
const repeat = spawnSync(process.execPath, [path.join(__dirname, 'patch-profile-imap-engines.js'), directory], { encoding: 'utf8' });
assert.notEqual(repeat.status, 0, 'hash gate accepted an already-modified engine');
assert.match(`${repeat.stdout}${repeat.stderr}`, /does not match the reviewed R5 source/);

console.log(JSON.stringify({
  ok: true,
  hashGated: true,
  targetProfileRouting: true,
  targetLiveSkuEditing: true,
  sharedNativeEngineContract: true,
  accountBoundAnalytics: true,
  walmartProfileRouting: true,
}, null, 2));
