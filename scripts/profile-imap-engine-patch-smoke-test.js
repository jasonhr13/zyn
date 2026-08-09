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
assert.equal(fs.existsSync(nativeEngineContract), true, 'shared native-engine contract was not staged');
assert.equal(fs.existsSync(nativeHyperBroker), true, 'native Hyper broker was not staged');
assert.equal(fs.existsSync(manualCaptchaManager), true, 'manual captcha manager was not staged');
assert.match(target, /require\('\.\/native-engine-contract'\)/);
assert.match(target, /require\('\.\/native-hyper-broker'\)/);
assert.match(target, /require\('\.\/manual-captcha-manager'\)/);
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
const repeat = spawnSync(process.execPath, [path.join(__dirname, 'patch-profile-imap-engines.js'), directory], { encoding: 'utf8' });
assert.notEqual(repeat.status, 0, 'hash gate accepted an already-modified engine');
assert.match(`${repeat.stdout}${repeat.stderr}`, /does not match the reviewed R5 source/);

console.log(JSON.stringify({
  ok: true,
  hashGated: true,
  targetProfileRouting: true,
  targetLiveSkuEditing: true,
  sharedNativeEngineContract: true,
  walmartProfileRouting: true,
}, null, 2));
