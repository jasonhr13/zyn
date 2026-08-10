#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const source = relative => fs.readFileSync(path.join(root, relative), 'utf8');

const ui = source('frontend/src/components/pages/target.js');
const taskGroups = source('frontend/src/components/pages/task-groups.js');
const proxiesPage = source('frontend/src/components/pages/proxies.js');
const pageHandler = source('frontend/src/components/page-handler.js');
const store = source('frontend/src/components/store.js');
const runtimePatcher = source('scripts/patch-profile-imap-engines.js');
const brandPatcher = source('scripts/patch-zyn-runtime-brand.js');
const harvesterConfig = source('scripts/target-multi-harvester-config.fragment.js');
const harvesterProducers = source('scripts/target-multi-harvester-producers.fragment.js');
const electron = source('extracted/asar/public/electron.js');
const bridge = source('extracted/asar/public/helpers/target-engine.js');
const farmer = source('native-farmer/shape-farmer.mjs');
const engine = fs.readFileSync(path.join(
  root,
  `native-backend/darwin-${process.arch === 'x64' ? 'x64' : 'arm64'}/backend`,
));

assert.match(ui, /ipcRenderer\.sendSync\('setTargetTaskProxy', id, proxyListName\)/,
  'running-task selector must invoke the synchronous live proxy IPC channel');
assert.match(ui, /change sent ✓/,
  'UI must distinguish command delivery from backend switch completion');
assert.match(ui, /proxyStatus\[t\.id\].*hidden/,
  'Target task rows must render transient proxy feedback without replacing task status');
assert.match(taskGroups, /const displayStatus = this\.proxyStatusFor\(task\) \|\| status/,
  'task groups must keep the operational status behind transient proxy feedback');
assert.match(taskGroups, /const running = statusKind\(status\) === 'running'/,
  'task actions must continue to use the operational status during a proxy failure notice');
assert.match(taskGroups, /targetHarvesterProxyList/,
  'task groups must migrate the former shared farmer proxy setting');
assert.match(taskGroups, /targetThrottleFallbackGroup/,
  'task groups must expose and persist the post-cart throttle fallback setting');
assert.match(taskGroups, />Cookie Harvesters</,
  'task groups must render the global harvester manager summary');
assert.match(taskGroups, />FALLBACK</,
  'task groups must render the global fallback selector');
assert.match(taskGroups, /targetHarvesters/,
  'task groups must persist multiple harvester configurations');
assert.match(taskGroups, /Target Login/,
  'task groups must expose a dedicated login harvester type');
assert.match(taskGroups, /Target ATC/,
  'task groups must expose a dedicated ATC harvester type');
assert.match(taskGroups, /\['opera', 'Opera'\]/,
  'task groups must expose Opera as a managed harvester browser');
assert.match(taskGroups, /runtime && runtime\.browserPerformance/,
  'harvester cards must read per-browser performance telemetry');
assert.match(taskGroups, /Favoring \$\{browserLeader\.label\}/,
  'automatic harvester cards must identify the browser currently being favored');
assert.match(taskGroups, /harvesterProxyAvailable/,
  'harvester UI must detect deleted or unavailable proxy groups');
assert.match(taskGroups, /label: 'Proxy unavailable'/,
  'a harvester with a missing proxy group must render an actionable error state');
assert.equal((proxiesPage.match(/sendSync\('syncTargetHarvesters'\)/g) || []).length, 2,
  'saving or deleting a proxy group must immediately reconcile managed harvesters');
assert.match(pageHandler, /targetProxyStatusClear/,
  'proxy feedback must be cleared after a bounded display interval');
assert.match(store, /proxyEdit && proxyEdit\.pending && isTargetProxyStatusForGroup/,
  'only an outstanding live proxy edit may be separated from task status');
assert.match(store, /proxyEdit && isTargetProxyRotationStatus/,
  'late Rotating Proxy chatter must not replace the operational task status after a live edit');
assert.match(runtimePatcher, /Object\.assign\(sentConfigs\.proxies, buildProxyMap\(group\)\)/,
  'live edits must load or refresh the selected proxy group before asking the engine to switch');
assert.match(electron, /ipcMain\.on\('setTargetTaskProxy'/,
  'main process must bridge live proxy edits');
assert.match(brandPatcher, /ipcMain\.on\('syncTargetHarvesters'/,
  'packaged main process patch must reconcile saved harvester configurations immediately');
assert.match(bridge, /runningTaskIds\.has\(taskId\)/,
  'bridge must only report live delivery for a running task');
assert.match(bridge, /type: 'set-task-proxy'.*proxyGroup: group/,
  'bridge must emit the backend live-edit protocol');
assert.match(runtimePatcher, /const harvesterProcs = new Map\(\)/,
  'packaged bridge patch must create independent producer process handles');
assert.match(runtimePatcher, /const harvesterStartFailures = new Map\(\)/,
  'packaged bridge patch must track fail-closed producer startup errors');
assert.match(harvesterConfig, /\['login', 'atc', 'auto'\]/,
  'managed harvester configuration must preserve the selected producer type');
assert.match(harvesterConfig, /'opera'/,
  'managed harvester configuration must preserve an Opera browser selection');
assert.match(harvesterProducers, /'--producer=true'/,
  'managed harvesters must run as producer-only processes behind the shared broker');
assert.match(harvesterProducers, /`--browsers=\$\{config\.browser\}`/,
  'managed harvesters must pass the selected browser to the farmer process');
assert.match(harvesterProducers, /config\.proxyListName && !lines\.length/,
  'managed harvesters must not silently fall back to direct traffic when a proxy group is empty');
assert.match(harvesterProducers, /not started — proxy group/,
  'missing proxy groups must produce a clear startup error');
assert.match(harvesterProducers, /createHash\('sha256'\).*lines\.join/,
  'proxy-list edits must change the producer fingerprint and restart affected harvesters');
assert.match(farmer, /u\.pathname === '\/harvesterStatus'/,
  'the shared broker must aggregate per-harvester runtime telemetry');
assert.match(farmer, /continuousLogin: PRODUCER_MODE && HARVESTER_TYPE === 'login'/,
  'a dedicated login harvester must replenish login cookies instead of stopping after one');

for (const marker of [
  'ConnectFrontend: set-task-proxy',
  'github.com/PolarAIO/Polar-AIO/backend/bot-base/task.EnqueueRuntimeEdit',
  'github.com/PolarAIO/Polar-AIO/backend/sites/target.(*TargetTask).applyRuntimeEdit',
  'github.com/PolarAIO/Polar-AIO/backend/sites/target.(*TargetTask).applyRuntimeProxy',
  'Proxy Updated',
  'Proxy Switch Failed',
]) {
  assert.equal(engine.includes(Buffer.from(marker)), true, `backend is missing live-proxy marker: ${marker}`);
}

for (const step of ['get-shape', 'login', 'otp-login', 'request-code', 'add-to-cart']) {
  assert.equal(engine.includes(Buffer.from(step)), true, `backend is missing Shape-pinned step: ${step}`);
}

console.log('Target running-task proxy edit reaches backend runtime-edit queue and guarded swap path');
