#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const source = relative => fs.readFileSync(path.join(root, relative), 'utf8');

const ui = source('frontend/src/components/pages/target.js');
const taskGroups = source('frontend/src/components/pages/task-groups.js');
const pageHandler = source('frontend/src/components/page-handler.js');
const store = source('frontend/src/components/store.js');
const runtimePatcher = source('scripts/patch-profile-imap-engines.js');
const electron = source('extracted/asar/public/electron.js');
const bridge = source('extracted/asar/public/helpers/target-engine.js');
const engine = fs.readFileSync(path.join(
  root,
  'dist/Zyn-Runtime-Base.app/Contents/Resources/engine/backend.exe',
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
assert.match(bridge, /runningTaskIds\.has\(taskId\)/,
  'bridge must only report live delivery for a running task');
assert.match(bridge, /type: 'set-task-proxy'.*proxyGroup: group/,
  'bridge must emit the backend live-edit protocol');

for (const marker of [
  'ConnectFrontend: set-task-proxy',
  'github.com/secretlair/backend/frontend.EditTask',
  'github.com/secretlair/backend/bot-base/task.EnqueueRuntimeEdit',
  'github.com/secretlair/backend/sites/target.(*TargetTask).applyRuntimeEdit',
  'github.com/secretlair/backend/sites/target.(*TargetTask).applyProxyEdit',
  'Switched To Local (home IP)',
  'Could Not Clear Proxy',
  'Could Not Switch To ',
  'Switched To ',
  ' (applies after carting)',
]) {
  assert.equal(engine.includes(Buffer.from(marker)), true, `backend is missing live-proxy marker: ${marker}`);
}

for (const step of ['get-shape', 'login', 'otp-login', 'request-code', 'add-to-cart']) {
  assert.equal(engine.includes(Buffer.from(step)), true, `backend is missing Shape-pinned step: ${step}`);
}

console.log('Target running-task proxy edit reaches backend runtime-edit queue and guarded swap path');
