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
for (const filename of ['target-engine.js', 'plain-log.js']) {
  fs.copyFileSync(path.join(project, 'extracted', 'asar', 'public', 'helpers', filename), path.join(directory, filename));
}

execFileSync(process.execPath, [path.join(__dirname, 'patch-profile-imap-engines.js'), directory], { stdio: 'inherit' });
const target = fs.readFileSync(path.join(directory, 'target-engine.js'), 'utf8');
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
assert.match(target, /case 'monitor-bandwidth':/);
assert.match(target,
  /const telemetry = engineContract\.normalizeMonitorBandwidth\(m\)/,
  'native monitor bandwidth is not normalized before crossing into the renderer');
assert.match(target, /toRenderer\('targetMonitorBandwidth', telemetry\)/,
  'normalized native monitor bandwidth is not forwarded to the renderer');
assert.match(target, /ignored invalid monitor bandwidth telemetry/,
  'invalid native monitor bandwidth is not rejected without including its payload in logs');
assert.match(target, /const TARGET_ENGINE_STOP_GRACE_MS = 1500/,
  'Target shutdown does not bound the wait for an exact terminal bandwidth sample');
assert.match(target, /const activeMonitorBandwidthRuns = new Map\(\)/,
  'Target shutdown does not track the active monitor runs awaiting terminal samples');
assert.match(target, /const pendingTargetStarts = \[\]/,
  'additive Target starts do not have a lossless pending FIFO');
assert.doesNotMatch(target, /\bpendingStart\b/,
  'the lossy single-slot Target start queue remains in generated code');
assert.match(target, /queueTargetStart\(config\)/,
  'Target starts bypass the pending FIFO');
assert.match(target, /while \(pendingTargetStarts\.length\)[\s\S]{0,100}const config = pendingTargetStarts\[0\]/,
  'pending Target starts are not flushed in FIFO order');
assert.match(target, /if \(!sendConfigs\(config\)\) break;/,
  'a failed Target config send permanently drops its queued start');
assert.match(target, /if \(started < 0\) break;\s+pendingTargetStarts\.shift\(\)/,
  'a failed Target task send permanently drops its queued start');
assert.match(target, /if \(pendingTargetEngineStop \|\| !pendingTargetStarts\.length\) return 0;/,
  'a queued Target start can race an engine that is still stopping');
assert.match(target, /function flushPokemonStarts\(\) \{\s+if \(pendingTargetEngineStop \|\|/,
  'a queued Pokemon Center start can race an engine that is still stopping');
assert.match(target, /const gracefulStop = finishTargetEngineStop\(spawnedEngine\)/,
  'the engine exit path does not finish the bounded monitor stop lifecycle');
assert.match(target,
  /const ownsCurrentProcess = engineProc === spawnedEngine[\s\S]{0,260}engineConn = null;[\s\S]{0,160}stoppedConnection\.close\(\)[\s\S]{0,220}finishTargetEngineStop\(spawnedEngine\)/,
  'child exit clears the stop gate before retiring its owned stale WebSocket');
assert.match(target, /if \(!connection \|\| engineConn !== connection\) return;/,
  'messages from a stale native socket are not rejected at the handler boundary');
assert.match(target, /function failNativeEngineRuns\(reason, publishError = false\)/,
  'native crashes and spawn failures do not share deterministic queue cleanup');
assert.match(target, /failNativeEngineRuns\('engine spawn error: ' \+ err\.message, true\)/,
  'a spawn failure can leave optimistic native starts queued forever');
assert.match(target, /failNativeEngineRuns\('Native engine exited', false\)/,
  'an unexpected engine exit can leave queued starts latent for later resurrection');
assert.match(target, /failNativeEngineRuns\('engine binary not found', true\)/,
  'a missing native executable can leave optimistic starts queued forever');
assert.match(target, /const downloaded = String\(process\.env\.ZYN_ENGINE_PATH \|\| ''\)/,
  'Target does not resolve the side-by-side downloaded engine before its bundled fallback');
assert.match(target, /log\('\[target\] starting native engine ' \+ engineVersion\)/,
  'Target does not record which pinned engine version owns a run');
assert.match(target, /function reconcileTargetMainMonitor\(\)/,
  'additive Target starts do not reconcile one monitor over the active SKU union');
assert.match(target, /if \(startedTotal\) reconcileTargetMainMonitor\(\)/,
  'the pending Target FIFO does not reconcile its monitor after all batches are delivered');
assert.match(target, /proxyGroup: spec\.proxyGroup/,
  'shared Target monitor edits do not follow the selected active proxy route');
assert.match(target, /if \(!sharedMonitorOnly\(\)\) \{\s+monitorRefreshed = reconcileTargetMainMonitor\(\)/,
  'a live edit can overwrite the shared Target monitor with only one selected group');
assert.match(target, /MONITOR_ID \+ '-main-' \+ \(\+\+targetMainMonitorSequence\)/,
  'shared Target monitor restarts reuse one native ID and can race an older stop');
assert.match(target, /if \(!wasRunning && liveEditMonitorId\) stopLiveEditMonitor\(\)/,
  'a new main monitor generation can overlap an older live-edit monitor');
assert.match(target, /rawId === targetMainMonitorId && \(m\.running === false \|\| mainMonitorRejected\)/,
  'a terminal native monitor status leaves the launcher believing the monitor is still running');
assert.match(target, /if \(targetMainMonitorNeedsSync && runningTaskIds\.size\) reconcileTargetMainMonitor\(\)/,
  'a failed monitor reconciliation is not retried when the owned socket reconnects');
assert.match(target, /if \(targetMainMonitorPendingStopIds\.size\) sendPendingTargetMainMonitorStop\(\)/,
  'a failed one-time scan stop is not retried when the owned socket reconnects');
assert.match(target, /if \(id\) queueTargetMonitorStop\(id\)/,
  'stopping a live-edit monitor does not retain its generation for reconnect');
assert.match(target, /if \(finishedId\) queueTargetMonitorStop\(finishedId\)/,
  'the live-edit timeout can lose its stop while the native socket is unavailable');
assert.match(target, /targetMainMonitorPendingStopIds\.has\(rawId\) && st === 'Idle'/,
  'a retried stop for an already-absent monitor can remain pending forever');
assert.match(target, /if \(m\.running === false\) acknowledgeLiveEditMonitorStop\(rawId\)/,
  'a rejected live-edit monitor leaves its timeout armed and later queues a stale stop');
assert.match(target, /if \(targetMainMonitorRunning \|\| !runningTaskIds\.size\) reconcileTargetMainMonitor\(\)/,
  'terminal checkout tasks do not remove their SKUs from the shared monitor union');
assert.match(target, /if \(!ownsCurrentProcess\) return;/,
  'stale child events can tear down the current native engine owner');
assert.match(target, /failNativeEngineRuns\('engine bridge: ' \+ \(err\.code \|\| err\.message\), true\)/,
  'fatal native bridge bind failures leave optimistic starts queued');
assert.equal((target.match(/beginTargetEngineStop\(engineProc\)/g) || []).length, 2,
  'both shared Target and Pokemon Center stop paths must use the monitor stop grace');
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
assert.match(target, /removePendingTargetStartTask\(requestedId\)/,
  'stopping a queued task does not remove it from every pending native start config');
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
assert.match(target, /startSeq \+= 1;\s+farmerWanted = null;\s+clearPendingTargetStarts\(\);/,
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

const mainMonitorStart = target.indexOf('const TARGET_MAIN_MONITOR_SYNC_MS = 100;');
const mainMonitorEnd = target.indexOf('\nfunction stopLiveEditMonitor()', mainMonitorStart);
assert.ok(mainMonitorStart >= 0 && mainMonitorEnd > mainMonitorStart,
  'could not isolate the shared Target monitor union lifecycle for behavior testing');
const mainMonitorMessages = [];
const mainMonitorTimers = [];
const cancelledMainMonitorTimers = new Set();
let mainMonitorSendAllowed = true;
let mainMonitorLiveEditStops = 0;
const mainMonitorContext = vm.createContext({
  MONITOR_ID: 'target-monitor',
  runningTaskIds: new Set(['target-a', 'target-b']),
  taskCheckoutConfigById: new Map([
    ['target-a', { skus: ['11111111', '22222222'], qty: 3, proxyListName: '' }],
    ['target-b', { skus: ['22222222', '33333333'], qty: 1, proxyListName: 'Residential' }],
  ]),
  engineConn: { readyState: 1 },
  liveEditMonitorId: '',
  stopLiveEditMonitor: () => {
    mainMonitorLiveEditStops += 1;
    mainMonitorContext.liveEditMonitorId = '';
  },
  sendToEngine: envelope => {
    mainMonitorMessages.push(JSON.parse(JSON.stringify(envelope)));
    return mainMonitorSendAllowed;
  },
  sharedMonitorOnly: () => true,
  setTimeout: (callback, ms) => {
    const timer = { callback, ms, unref() {} };
    mainMonitorTimers.push(timer);
    return timer;
  },
  clearTimeout: timer => cancelledMainMonitorTimers.add(timer),
  log() {},
});
vm.runInContext(`${target.slice(mainMonitorStart, mainMonitorEnd)}
globalThis.mainMonitor = {
  reconcile: reconcileTargetMainMonitor,
  spec: targetMainMonitorSpec,
  clear: clearTargetMainMonitorState,
  running: () => targetMainMonitorRunning,
  id: () => targetMainMonitorId,
  needsSync: () => targetMainMonitorNeedsSync,
  pendingStop: () => [...targetMainMonitorPendingStopIds],
  flushPendingStop: sendPendingTargetMainMonitorStop,
  queueStop: queueTargetMonitorStop,
  ackStop: id => targetMainMonitorPendingStopIds.delete(id),
};`, mainMonitorContext);
assert.equal(mainMonitorContext.mainMonitor.reconcile(), true);
assert.equal(mainMonitorMessages[0].type, 'start-monitors');
const firstMainMonitorId = mainMonitorMessages[0].messages[0].id;
assert.match(firstMainMonitorId, /^target-monitor-main-\d+$/,
  'the shared Target monitor did not use a generation-specific native ID');
assert.deepEqual(
  mainMonitorMessages[0].messages[0].items,
  [
    { monitorInput: '11111111', quantity: '3', maxPrice: '' },
    { monitorInput: '22222222', quantity: '1', maxPrice: '' },
    { monitorInput: '33333333', quantity: '1', maxPrice: '' },
  ],
  'the shared Target monitor did not start with the active task SKU union and least restrictive quantity',
);
mainMonitorContext.runningTaskIds.add('target-c');
mainMonitorContext.taskCheckoutConfigById.set('target-c', {
  skus: ['44444444'], qty: 2, proxyListName: 'Residential',
});
assert.equal(mainMonitorContext.mainMonitor.reconcile(), true);
assert.equal(mainMonitorMessages.filter(message => message.type === 'start-monitors').length, 1,
  'an additive Target batch started a duplicate native monitor ID');
const unionEdit = mainMonitorMessages.findLast(message => message.type === 'edit-tasks');
assert.equal(unionEdit.messages[0].proxyGroup, 'Residential',
  'the shared Target monitor union edit did not apply its active proxy route');
assert.deepEqual(
  unionEdit.messages[0].monitorItems.map(item => item.monitorInput),
  ['11111111', '22222222', '33333333', '44444444'],
  'an additive Target batch did not update the existing monitor to the full SKU union',
);
const initialSyncTimer = mainMonitorTimers.find(timer => timer.ms === 100);
assert.ok(initialSyncTimer, 'the first native monitor start did not schedule a post-registration union sync');
initialSyncTimer.callback();
assert.deepEqual(
  mainMonitorMessages.at(-1).messages[0].monitorItems.map(item => item.monitorInput),
  ['11111111', '22222222', '33333333', '44444444'],
  'the post-registration monitor sync used a stale pre-additive watch list',
);
const firstScanTimer = mainMonitorTimers.findLast(timer => timer.ms === 20000
  && !cancelledMainMonitorTimers.has(timer));
assert.ok(firstScanTimer, 'the shared monitor did not retain one active scan timer');
mainMonitorSendAllowed = false;
firstScanTimer.callback();
assert.equal(mainMonitorContext.mainMonitor.running(), false);
assert.equal(mainMonitorContext.mainMonitor.id(), '');
assert.equal(JSON.stringify(mainMonitorContext.mainMonitor.pendingStop()), JSON.stringify([firstMainMonitorId]),
  'a failed one-time scan stop was not retained for reconnect');
mainMonitorSendAllowed = true;
assert.equal(mainMonitorContext.mainMonitor.flushPendingStop(), true,
  'a retained one-time scan stop was not delivered after reconnect');
assert.equal(mainMonitorMessages.at(-1).messages[0].id, firstMainMonitorId);
mainMonitorContext.mainMonitor.ackStop(firstMainMonitorId);

mainMonitorSendAllowed = false;
assert.equal(mainMonitorContext.mainMonitor.queueStop('target-monitor-edit-7'), false,
  'a disconnected live-edit stop was reported as delivered');
assert.equal(JSON.stringify(mainMonitorContext.mainMonitor.pendingStop()), JSON.stringify(['target-monitor-edit-7']),
  'a disconnected live-edit stop was not retained for reconnect');
mainMonitorSendAllowed = true;
assert.equal(mainMonitorContext.mainMonitor.flushPendingStop(), true,
  'a retained live-edit stop was not delivered after reconnect');
assert.equal(mainMonitorMessages.at(-1).messages[0].id, 'target-monitor-edit-7');
mainMonitorContext.mainMonitor.ackStop('target-monitor-edit-7');

mainMonitorContext.liveEditMonitorId = 'target-monitor-edit-old-generation';
mainMonitorSendAllowed = false;
assert.equal(mainMonitorContext.mainMonitor.reconcile(), false,
  'a failed native monitor start was reported as delivered');
assert.equal(mainMonitorLiveEditStops, 1,
  'a replacement main monitor did not retire the older live-edit generation');
assert.equal(mainMonitorContext.mainMonitor.needsSync(), true,
  'a failed native monitor start was not retained for retry');
const retryTimer = mainMonitorTimers.findLast(timer => timer.ms === 5000
  && !cancelledMainMonitorTimers.has(timer));
assert.ok(retryTimer, 'a failed native monitor start did not schedule a bounded retry');
mainMonitorSendAllowed = true;
retryTimer.callback();
assert.equal(mainMonitorContext.mainMonitor.needsSync(), false,
  'a retained native monitor start did not clear after retry success');
assert.notEqual(mainMonitorContext.mainMonitor.id(), firstMainMonitorId,
  'a stopped Target monitor generation was reused by its replacement');

const liveEditStopStart = target.indexOf('function acknowledgeLiveEditMonitorStop(');
const liveEditStopEnd = target.indexOf('\n// A group edit changes', liveEditStopStart);
assert.ok(liveEditStopStart >= 0 && liveEditStopEnd > liveEditStopStart,
  'could not isolate the live-edit monitor stop lifecycle for behavior testing');
const queuedLiveEditStops = [];
const clearedLiveEditTimers = [];
const liveEditStopContext = vm.createContext({
  clearTimeout: timer => { timer.cleared = true; clearedLiveEditTimers.push(timer); },
  queueTargetMonitorStop: id => { queuedLiveEditStops.push(id); return false; },
});
vm.runInContext(`let liveEditMonitorId = '';
let liveEditMonitorTimer = null;
${target.slice(liveEditStopStart, liveEditStopEnd)}
globalThis.liveEditStop = {
  begin(id, timer) { liveEditMonitorId = id; liveEditMonitorTimer = timer; },
  acknowledge: acknowledgeLiveEditMonitorStop,
  stop: stopLiveEditMonitor,
  id: () => liveEditMonitorId,
  timer: () => liveEditMonitorTimer,
};`, liveEditStopContext);
const rejectedLiveEditTimer = { cleared: false };
liveEditStopContext.liveEditStop.begin('target-monitor-edit-rejected', rejectedLiveEditTimer);
assert.equal(liveEditStopContext.liveEditStop.acknowledge('another-monitor'), false);
assert.equal(liveEditStopContext.liveEditStop.acknowledge('target-monitor-edit-rejected'), true);
assert.equal(rejectedLiveEditTimer.cleared, true,
  'a rejected live-edit monitor left its delayed stop armed');
assert.equal(liveEditStopContext.liveEditStop.id(), '');
assert.equal(liveEditStopContext.liveEditStop.timer(), null);
assert.deepEqual(queuedLiveEditStops, [],
  'acknowledging a rejected live-edit monitor queued an unnecessary stop');
const disconnectedLiveEditTimer = { cleared: false };
liveEditStopContext.liveEditStop.begin('target-monitor-edit-disconnected', disconnectedLiveEditTimer);
liveEditStopContext.liveEditStop.stop();
assert.equal(disconnectedLiveEditTimer.cleared, true);
assert.deepEqual(queuedLiveEditStops, ['target-monitor-edit-disconnected'],
  'an explicit live-edit stop was not retained after a disconnected send');

const pendingQueueStart = target.indexOf('const pendingTargetStarts = [];');
const pendingQueueEnd = target.indexOf('\nlet taskActive = false;', pendingQueueStart);
const flushQueueStart = target.indexOf('function flushStart() {');
const flushQueueEnd = target.indexOf('\n// ── Pokemon Center US:', flushQueueStart);
assert.ok(pendingQueueStart >= 0 && pendingQueueEnd > pendingQueueStart,
  'could not isolate the pending Target FIFO for behavior testing');
assert.ok(flushQueueStart >= 0 && flushQueueEnd > flushQueueStart,
  'could not isolate the pending Target FIFO flush for behavior testing');
const queuedConfigs = [];
const startedConfigs = [];
let monitorReconciles = 0;
const queueContext = vm.createContext({
  pendingTargetEngineStop: null,
  taskActive: false,
  sendConfigs: config => queuedConfigs.push(JSON.parse(JSON.stringify(config))),
  sendStart: config => {
    startedConfigs.push(JSON.parse(JSON.stringify(config)));
    return config.tasks.length;
  },
  reconcileTargetMainMonitor: () => { monitorReconciles += 1; return true; },
  log() {},
});
vm.runInContext(`${target.slice(pendingQueueStart, pendingQueueEnd)}
${target.slice(flushQueueStart, flushQueueEnd)}
globalThis.targetStartQueue = {
  queue: queueTargetStart,
  removeTask: removePendingTargetStartTask,
  clear: clearPendingTargetStarts,
  flush: flushStart,
  snapshot: () => pendingTargetStarts,
};`, queueContext);

const firstQueuedConfig = {
  tasks: [{ id: 'shared-stop' }, { id: 'first-only' }], skus: ['11111111'], qty: 1,
};
const secondQueuedConfig = {
  tasks: [{ id: 'shared-stop' }, { id: 'second-only' }], skus: ['22222222', '33333333'], qty: 3,
};
queueContext.targetStartQueue.queue(firstQueuedConfig);
queueContext.targetStartQueue.queue(secondQueuedConfig);
queueContext.targetStartQueue.removeTask('shared-stop');
assert.deepEqual(
  JSON.parse(JSON.stringify(queueContext.targetStartQueue.snapshot())),
  [
    { tasks: [{ id: 'first-only' }], skus: ['11111111'], qty: 1 },
    { tasks: [{ id: 'second-only' }], skus: ['22222222', '33333333'], qty: 3 },
  ],
  'stopping a task did not remove it from every queued config while preserving config fields',
);
queueContext.pendingTargetEngineStop = { proc: { pid: 1 } };
assert.equal(queueContext.targetStartQueue.flush(), 0,
  'pending Target configs flushed into an engine that was still stopping');
assert.equal(queueContext.targetStartQueue.snapshot().length, 2,
  'stop-grace gating discarded pending Target configs');
queueContext.pendingTargetEngineStop = null;
assert.equal(queueContext.targetStartQueue.flush(), 2,
  'the pending Target FIFO did not start every queued task');
assert.equal(monitorReconciles, 1,
  'one FIFO flush reconciled the shared Target monitor more than once');
assert.deepEqual(startedConfigs.map(config => ({
  ids: config.tasks.map(task => task.id), skus: config.skus, qty: config.qty,
})), [
  { ids: ['first-only'], skus: ['11111111'], qty: 1 },
  { ids: ['second-only'], skus: ['22222222', '33333333'], qty: 3 },
], 'two additive pending Target configs lost FIFO order or per-config SKU/quantity fields');
assert.deepEqual(queuedConfigs, startedConfigs,
  'send-configs and start-tasks observed different pending Target configs');
assert.equal(queueContext.targetStartQueue.snapshot().length, 0,
  'the pending Target FIFO was not empty after a successful flush');

const retryQueuedConfig = { tasks: [{ id: 'retry-only' }], skus: ['55555555'], qty: 4 };
queueContext.targetStartQueue.queue(retryQueuedConfig);
const startsBeforeRetry = startedConfigs.length;
queueContext.sendConfigs = () => false;
assert.equal(queueContext.targetStartQueue.flush(), 0);
assert.equal(queueContext.targetStartQueue.snapshot().length, 1,
  'a failed send-configs delivery removed the pending Target config');
assert.equal(startedConfigs.length, startsBeforeRetry,
  'Target tasks were sent after their config delivery failed');
queueContext.sendConfigs = config => queuedConfigs.push(JSON.parse(JSON.stringify(config)));
queueContext.sendStart = () => -1;
assert.equal(queueContext.targetStartQueue.flush(), 0);
assert.equal(queueContext.targetStartQueue.snapshot().length, 1,
  'a failed start-tasks delivery removed the pending Target config');
queueContext.sendStart = config => {
  startedConfigs.push(JSON.parse(JSON.stringify(config)));
  return config.tasks.length;
};
assert.equal(queueContext.targetStartQueue.flush(), 1,
  'a retained Target config was not delivered after the connection recovered');
assert.equal(queueContext.targetStartQueue.snapshot().length, 0);

queueContext.targetStartQueue.queue(firstQueuedConfig);
queueContext.targetStartQueue.clear();
assert.equal(queueContext.targetStartQueue.snapshot().length, 0,
  'full Target stop did not clear the pending FIFO');

const pokemonFlushStart = target.indexOf('function flushPokemonStarts() {');
const pokemonFlushEnd = target.indexOf('\nfunction startPokemonCenter(', pokemonFlushStart);
assert.ok(pokemonFlushStart >= 0 && pokemonFlushEnd > pokemonFlushStart,
  'could not isolate the pending Pokemon Center FIFO for behavior testing');
const pokemonPending = [{ tasks: [{ id: 'pc-retry', profileId: 'profile-1' }] }];
const pokemonFlushContext = vm.createContext({
  pendingTargetEngineStop: null,
  engineConn: { readyState: 1 },
  WebSocket: { OPEN: 1 },
  pendingPokemonStarts: pokemonPending,
  pokemonTaskIds: new Set(['pc-retry']),
  pokemonTaskConfigs: new Map(),
  engineTaskSites: { remove() {} },
  runningTaskIds: new Set(),
  taskActive: false,
  addPokemonRotationProfiles() {},
  sendConfigs: () => false,
  pokemonMessage: task => ({ id: task.id, profileId: task.profileId, item: [{ monitorInput: 'sku' }] }),
  pokemonStatus() {},
  pokemonDone() {},
  pokemonLog() {},
  pokemonQueueStreamLine: () => 'queue status',
  sendToEngine: () => true,
});
vm.runInContext(`${target.slice(pokemonFlushStart, pokemonFlushEnd)}
globalThis.flushPokemonQueue = flushPokemonStarts;`, pokemonFlushContext);
assert.equal(pokemonFlushContext.flushPokemonQueue(), 0);
assert.equal(pokemonPending.length, 1,
  'a failed Pokemon Center config delivery removed its pending start');
pokemonFlushContext.sendConfigs = () => true;
pokemonFlushContext.sendToEngine = () => false;
assert.equal(pokemonFlushContext.flushPokemonQueue(), 0);
assert.equal(pokemonPending.length, 1,
  'a failed Pokemon Center task delivery removed its pending start');
pokemonFlushContext.sendToEngine = () => true;
assert.equal(pokemonFlushContext.flushPokemonQueue(), 1);
assert.equal(pokemonPending.length, 0,
  'a retained Pokemon Center start was not delivered after the connection recovered');

const failureHelperStart = target.indexOf('function failNativeEngineRuns(');
const failureHelperEnd = target.indexOf('\nfunction pokemonQueueStreamLine(', failureHelperStart);
assert.ok(failureHelperStart >= 0 && failureHelperEnd > failureHelperStart,
  'could not isolate native crash cleanup for behavior testing');
const failureEvents = { statuses: [], pokemonStatuses: [], done: [], pokemonDone: [], cancelled: 0, monitorCleared: 0 };
const targetPendingOnFailure = [{ tasks: [{ id: 'target-pending' }] }];
const pokemonPendingOnFailure = [{ tasks: [{ id: 'pokemon-pending' }] }];
const failedSocket = { closed: false, close() { this.closed = true; } };
const failureContext = vm.createContext({
  engineConn: failedSocket,
  taskActive: true,
  activeMonitorBandwidthRuns: new Map([['target-monitor', 'failed-run']]),
  targetMainMonitorPendingStopIds: new Set(['target-monitor-main-old']),
  clearTargetMainMonitorState: () => { failureEvents.monitorCleared += 1; },
  stopLiveEditMonitor() {},
  cancelAllOtpFetches() {},
  runningTaskIds: new Set(['target-pending']),
  pokemonTaskIds: new Set(['pokemon-pending']),
  status: (...args) => failureEvents.statuses.push(args),
  pokemonStatus: (...args) => failureEvents.pokemonStatuses.push(args),
  toRenderer: (...args) => failureEvents.done.push(args),
  pokemonDone: id => failureEvents.pokemonDone.push(id),
  clearTargetCookieTasks() {},
  clearPendingTargetStarts: () => { targetPendingOnFailure.length = 0; },
  pokemonTaskConfigs: new Map([['pokemon-pending', {}]]),
  pendingPokemonStarts: pokemonPendingOnFailure,
  engineTaskSites: { clear() {} },
  taskAccountById: new Map([['target-pending', 'account']]),
  taskProfileById: new Map([['target-pending', 'profile']]),
  taskCheckoutConfigById: new Map([['target-pending', {}]]),
  manualCaptchaManager: { cancelPending: () => { failureEvents.cancelled += 1; } },
  nativeHyperBroker: { cancelPending: () => { failureEvents.cancelled += 1; } },
});
vm.runInContext(`${target.slice(failureHelperStart, failureHelperEnd)}
globalThis.failNativeRuns = failNativeEngineRuns;`, failureContext);
failureContext.failNativeRuns('spawn denied\nsecret detail', true);
assert.equal(failureContext.engineConn, null);
assert.equal(failedSocket.closed, true, 'native failure cleanup did not retire the failed socket');
assert.equal(targetPendingOnFailure.length, 0, 'native failure cleanup left Target starts latent');
assert.equal(pokemonPendingOnFailure.length, 0, 'native failure cleanup left Pokemon starts latent');
assert.equal(failureContext.runningTaskIds.size, 0);
assert.equal(failureContext.pokemonTaskIds.size, 0);
assert.equal(failureContext.activeMonitorBandwidthRuns.size, 0);
assert.equal(failureContext.targetMainMonitorPendingStopIds.size, 0);
assert.equal(failureEvents.statuses.length, 1);
assert.equal(failureEvents.pokemonStatuses.length, 1);
assert.equal(failureEvents.cancelled, 2);
assert.equal(failureEvents.monitorCleared, 1,
  'native failure cleanup did not reset the shared Target monitor lifecycle');
assert.ok(failureEvents.done.some(([channel, payload]) => channel === 'targetDone' && payload.taskId === ''),
  'native failure cleanup did not terminate the renderer monitor state');

const messageHandlerStart = target.indexOf('function handleEngineMessage(data, connection) {');
const messageHandlerEnd = target.indexOf('\n// ── server lifecycle', messageHandlerStart);
assert.ok(messageHandlerStart >= 0 && messageHandlerEnd > messageHandlerStart,
  'could not isolate native inbound ownership for behavior testing');
let staleParseCalls = 0;
const ownedConnection = {};
const staleHandlerContext = vm.createContext({
  engineConn: ownedConnection,
  engineContract: { parseEnvelope: () => { staleParseCalls += 1; throw new Error('must not parse stale data'); } },
});
vm.runInContext(`${target.slice(messageHandlerStart, messageHandlerEnd)}
globalThis.acceptNativeMessage = handleEngineMessage;`, staleHandlerContext);
staleHandlerContext.acceptNativeMessage(Buffer.from('{"type":"monitor-bandwidth","messages":[]}'), {});
assert.equal(staleParseCalls, 0,
  'a stale native socket reached envelope parsing before ownership rejection');

const gracefulStopStart = target.indexOf('const TARGET_ENGINE_STOP_GRACE_MS = 1500;');
const gracefulStopEnd = target.indexOf('\n// ── Shape cookie farmer', gracefulStopStart);
assert.ok(gracefulStopStart >= 0 && gracefulStopEnd > gracefulStopStart,
  'could not isolate native monitor graceful-stop lifecycle for behavior testing');
const killedProcesses = [];
const stopTimers = [];
const stopContext = {
  engineConn: { readyState: 1 },
  targetMainMonitorPendingStopIds: new Set(),
  acknowledgeLiveEditMonitorStop() {},
  WebSocket: { OPEN: 1 },
  killTree: proc => killedProcesses.push(proc),
  setTimeout: callback => {
    const timer = { callback, cleared: false, unrefCalled: false, unref() { this.unrefCalled = true; } };
    stopTimers.push(timer);
    return timer;
  },
  clearTimeout: timer => { if (timer) timer.cleared = true; },
};
vm.runInNewContext(`${target.slice(gracefulStopStart, gracefulStopEnd)}
globalThis.monitorStop = {
  track: trackTargetMonitorBandwidth,
  begin: beginTargetEngineStop,
  force: forcePendingTargetEngineStop,
  finish: finishTargetEngineStop,
  active: activeMonitorBandwidthRuns,
  pending: () => pendingTargetEngineStop,
};`, stopContext);

const firstProcess = { pid: 101 };
stopContext.monitorStop.track({
  monitorId: 'target-monitor', runId: 'run-one', running: true,
  proxyUrl: 'http://user:password@example.invalid', cookie: 'secret-value',
});
assert.equal(stopContext.monitorStop.active.get('target-monitor'), 'run-one');
assert.doesNotMatch(JSON.stringify([...stopContext.monitorStop.active]), /password|secret-value/,
  'the shutdown acknowledgement tracker retained native telemetry payload data');
assert.equal(stopContext.monitorStop.begin(firstProcess), true,
  'a connected active monitor did not receive its bounded terminal-sample grace');
assert.equal(killedProcesses.length, 0, 'the engine was killed before its terminal sample arrived');
assert.equal(stopTimers.length, 1);
assert.equal(stopTimers[0].unrefCalled, true, 'the shutdown grace timer can keep Electron alive');
const completedStop = stopContext.monitorStop.track({
  monitorId: 'target-monitor', runId: 'run-one', running: false,
});
assert.equal(completedStop, stopContext.monitorStop.pending(),
  'the matching terminal monitor sample did not acknowledge the pending stop');
assert.equal(stopContext.monitorStop.force(completedStop), true);
assert.deepEqual(killedProcesses, [firstProcess], 'the acknowledged engine stop did not force-kill exactly once');
assert.equal(stopContext.monitorStop.force(completedStop), false,
  'a duplicate terminal sample can kill the same engine more than once');
assert.equal(stopContext.monitorStop.finish(firstProcess), true);
assert.equal(stopContext.monitorStop.pending(), null);

const timeoutProcess = { pid: 202 };
stopContext.monitorStop.track({ monitorId: 'target-monitor', runId: 'run-two', running: true });
assert.equal(stopContext.monitorStop.begin(timeoutProcess), true);
const timeoutTimer = stopTimers[stopTimers.length - 1];
timeoutTimer.callback();
assert.deepEqual(killedProcesses, [firstProcess, timeoutProcess],
  'the bounded timeout did not force-stop an engine that omitted its terminal sample');
assert.equal(stopContext.monitorStop.finish(timeoutProcess), true);

const disconnectedProcess = { pid: 303 };
stopContext.engineConn = null;
stopContext.monitorStop.track({ monitorId: 'target-monitor', runId: 'run-three', running: true });
assert.equal(stopContext.monitorStop.begin(disconnectedProcess), false,
  'a disconnected engine unnecessarily entered the terminal-sample grace');
assert.deepEqual(killedProcesses, [firstProcess, timeoutProcess, disconnectedProcess],
  'a disconnected engine was not stopped immediately');
assert.equal(stopContext.monitorStop.finish(disconnectedProcess), true);

const bindServerStart = target.indexOf('function bindServer(port) {');
const bindServerEnd = target.indexOf('\nfunction spawnEngine() {', bindServerStart);
assert.ok(bindServerStart >= 0 && bindServerEnd > bindServerStart,
  'could not isolate native bridge bind failure cleanup for behavior testing');
const bindFailures = [];
const fakeServers = [];
let throwDuringServerConstruction = true;
function FakeWebSocketServer() {
  if (throwDuringServerConstruction) {
    const error = new Error('constructor denied');
    error.code = 'EACCES';
    throw error;
  }
  this.handlers = {};
  this.on = (name, callback) => { this.handlers[name] = callback; };
  this.close = () => {};
  this.address = () => ({ port: 8727 });
  fakeServers.push(this);
}
const bindContext = vm.createContext({
  boundPort: 0,
  wss: null,
  ENGINE_PORT: 8727,
  serverWaiters: [() => {}],
  WebSocket: { Server: FakeWebSocketServer, OPEN: 1 },
  log() {},
  failNativeEngineRuns: (reason, publishError) => bindFailures.push({ reason, publishError }),
});
vm.runInContext(`${target.slice(bindServerStart, bindServerEnd)}
globalThis.runBindServer = bindServer;`, bindContext);
bindContext.runBindServer(8727);
assert.deepEqual(bindFailures.shift(), { reason: 'engine bridge: EACCES', publishError: true },
  'a synchronous WebSocket bridge constructor failure left optimistic starts alive');
assert.equal(bindContext.serverWaiters.length, 0);

throwDuringServerConstruction = false;
bindContext.serverWaiters.push(() => {});
bindContext.runBindServer(0);
assert.equal(fakeServers.length, 1);
fakeServers[0].handlers.error({ code: 'EACCES', message: 'bind denied' });
assert.deepEqual(bindFailures.shift(), { reason: 'engine bridge: EACCES', publishError: true },
  'an asynchronous fatal WebSocket bridge bind failure left optimistic starts alive');
assert.equal(bindContext.serverWaiters.length, 0);

const spawnEngineStart = target.indexOf('function spawnEngine() {');
const spawnEngineEnd = target.indexOf('\n// ── public API', spawnEngineStart);
assert.ok(spawnEngineStart >= 0 && spawnEngineEnd > spawnEngineStart,
  'could not isolate native engine spawn/exit behavior for restart testing');
const socketExitOrder = [];
const scheduledRespawns = [];
const spawnedProcesses = [];
const failedNativeRuns = [];
const staleConnection = {
  readyState: 1,
  close() { socketExitOrder.push('socket-close'); this.readyState = 3; },
};
function fakeEngineProcess(pid) {
  const handlers = {};
  return {
    pid,
    handlers,
    stdout: { on() {} },
    stderr: { on() {} },
    on(name, callback) { handlers[name] = callback; },
  };
}
const spawnContext = vm.createContext({
  engineProc: null,
  engineConn: staleConnection,
  pendingTargetEngineStop: null,
  pendingTargetStarts: [{ tasks: [{ id: 'restart-one' }], skus: ['44444444'], qty: 2 }],
  pendingPokemonStarts: [],
  taskActive: false,
  targetMainMonitorRunning: false,
  activeMonitorBandwidthRuns: new Map(),
  runningTaskIds: new Set(),
  pokemonTaskIds: new Set(),
  quitting: false,
  fs: { existsSync: () => true },
  enginePath: () => '/tmp/backend',
  status() {},
  log() {},
  path: { dirname: () => '/tmp' },
  boundPort: 8727,
  ENGINE_PORT: 8727,
  SHAPE_PORT: 4727,
  SHAPE_TOKEN: 'test-token',
  process: { env: {} },
  plat: { spawnOpts: () => ({}), engineBin: () => 'backend' },
  spawn: () => {
    const proc = fakeEngineProcess(400 + spawnedProcesses.length);
    spawnedProcesses.push(proc);
    return proc;
  },
  verboseLogs: () => false,
  KEEP_IN_QUIET: /$a/,
  setImmediate: callback => scheduledRespawns.push(callback),
  finishTargetEngineStop: proc => {
    if (proc === spawnedProcesses[0]) {
      assert.equal(spawnContext.engineConn, null,
        'the graceful stop gate was cleared before the stale socket was detached');
      assert.deepEqual(socketExitOrder, ['socket-close'],
        'the graceful stop gate was cleared before the stale socket was closed');
      spawnContext.pendingTargetEngineStop = null;
      socketExitOrder.push('stop-finished');
      return true;
    }
    return false;
  },
  failNativeEngineRuns: (reason, publishError) => {
    failedNativeRuns.push({ reason, publishError });
    spawnContext.pendingTargetStarts.length = 0;
    spawnContext.pendingPokemonStarts.length = 0;
  },
});
vm.runInContext(`${target.slice(spawnEngineStart, spawnEngineEnd)}
globalThis.runSpawnEngine = spawnEngine;`, spawnContext);
spawnContext.runSpawnEngine();
assert.equal(spawnedProcesses.length, 1);
spawnContext.pendingTargetEngineStop = { proc: spawnedProcesses[0] };
spawnedProcesses[0].handlers.exit(0);
assert.equal(spawnContext.engineConn, null,
  'graceful child exit left its stale WebSocket available to flush a new start');
assert.deepEqual(socketExitOrder, ['socket-close', 'stop-finished']);
assert.equal(scheduledRespawns.length, 1,
  'a queued Target restart was not scheduled after graceful child exit');
scheduledRespawns[0]();
assert.equal(spawnedProcesses.length, 2,
  'the queued Target restart did not spawn a replacement after the stale socket was retired');
spawnContext.pendingTargetStarts.push({ tasks: [{ id: 'spawn-failure' }] });
spawnedProcesses[1].handlers.error(new Error('permission denied'));
assert.deepEqual(failedNativeRuns.shift(), {
  reason: 'engine spawn error: permission denied', publishError: true,
}, 'a spawn error did not fail and clear optimistic native starts');
assert.equal(spawnContext.pendingTargetStarts.length, 0);

spawnContext.pendingTargetStarts.push({ tasks: [{ id: 'crash-failure' }] });
spawnContext.runSpawnEngine();
assert.equal(spawnedProcesses.length, 3);
spawnedProcesses[1].handlers.exit(1);
spawnedProcesses[1].handlers.error(new Error('late stale error'));
assert.equal(failedNativeRuns.length, 0,
  'a stale errored child event tore down its replacement engine');
assert.equal(spawnContext.engineProc, spawnedProcesses[2],
  'a stale child event cleared the replacement process owner');
assert.equal(spawnContext.pendingTargetStarts.length, 1,
  'a stale child event cleared the replacement process queue');
spawnedProcesses[2].handlers.exit(9);
assert.deepEqual(failedNativeRuns.shift(), {
  reason: 'Native engine exited', publishError: false,
}, 'an unexpected native exit did not clear latent pending starts');
assert.equal(spawnContext.pendingTargetStarts.length, 0);

const idleSocket = {
  readyState: 1,
  close() { socketExitOrder.push('idle-socket-close'); this.readyState = 3; },
};
spawnContext.engineConn = idleSocket;
spawnContext.runSpawnEngine();
assert.equal(spawnedProcesses.length, 4);
spawnedProcesses[3].handlers.exit(0);
assert.equal(spawnContext.engineConn, null,
  'an idle unexpected child exit left its dead WebSocket as the active owner');
assert.equal(socketExitOrder.at(-1), 'idle-socket-close');

spawnContext.fs.existsSync = () => false;
spawnContext.pendingTargetStarts.push({ tasks: [{ id: 'missing-engine' }] });
spawnContext.runSpawnEngine();
assert.deepEqual(failedNativeRuns.shift(), {
  reason: 'engine binary not found', publishError: true,
}, 'a missing native executable did not fail and clear optimistic starts');
assert.equal(spawnContext.pendingTargetStarts.length, 0);

spawnContext.fs.existsSync = () => true;
spawnContext.spawn = () => { throw new Error('synchronous spawn denied'); };
spawnContext.pendingTargetStarts.push({ tasks: [{ id: 'sync-spawn-failure' }] });
spawnContext.runSpawnEngine();
assert.deepEqual(failedNativeRuns.shift(), {
  reason: 'engine spawn error: synchronous spawn denied', publishError: true,
}, 'a synchronous native spawn exception did not fail and clear optimistic starts');
assert.equal(spawnContext.pendingTargetStarts.length, 0);

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
assert.match(target, /cancelAllOtpFetches\(detail\)/,
  'native engine failure cleanup does not cancel outstanding OTP fetches');
assert.match(target, /type: 'code-watcher-ready'/,
  'Target bridge does not acknowledge native OTP watcher readiness');
assert.match(target, /onLog: \(line\) => log\(String\(line\), taskId\)/);
assert.match(target, /const found = await Promise\.any\(sources\)/,
  'AYCD and profile IMAP are not raced for the first verified code');
assert.match(target, /signal: sourceController\.signal/,
  'the losing OTP provider cannot be cancelled after another source finds the code');
assert.match(target, /if \(next && !otpFetches\.has\(key\)\) fetchOtpAndDeliver\(next\.email, next\.taskId\)/,
  'a sibling task on the same account can be left without a fresh code lookup');
assert.doesNotMatch(target, /AYCD returned no code.*trying this profile’s IMAP/,
  'profile IMAP still waits for AYCD to time out before it starts');
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
assert.match(plainLog, /Mailbox connected — waiting for the email code/);
assert.match(plainLog, /Email code found — submitting/);
assert.match(plainLog, /Could not find the new email code — enter it manually/);

for (const filename of ['target-engine.js', 'plain-log.js']) {
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
}, null, 2));
