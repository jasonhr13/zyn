#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const project = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(project, relative), 'utf8');

const taskGroups = read('frontend/src/components/pages/task-groups.js');
const targetPage = read('frontend/src/components/pages/target.js');
const engine = read('runtime-app/public/helpers/target-engine.js');
const dataManager = read('runtime-app/public/helpers/data-manager.js');
const bootstrap = read('launcher/bootstrap.js');
const scheduler = read('launcher/task-group-scheduler.js');
const store = read('frontend/src/components/store.js');
const pageHandler = read('frontend/src/components/page-handler.js');

assert.doesNotMatch(taskGroups, /sendSync\('stopTarget'/,
  'Task Groups Stop must not freeze the renderer on a sendSync loop');
assert.match(taskGroups, /stopTargetTasks\(ids\)/,
  'Stop All / selected Stop must send one batched stopTarget');
assert.match(taskGroups, /stopTargetTasks\(taskIds\)/,
  'Deleting a group must stop its tasks in one IPC');
assert.match(taskGroups, /includeBank: intent !== 'start'/,
  'Check Readiness may load the cookie bank; Start must not');
assert.match(taskGroups, /type: 'targetLaunch'/,
  'Start All must paint Starting in the renderer before main-process work');
assert.match(taskGroups, /this\.launchTasks\(group, tasks\)/,
  'Start All must not wait on a readiness IPC round-trip');
assert.doesNotMatch(taskGroups, /this\.runReadiness\(group, tasks, 'start'\)/,
  'Start All must not block on targetReadiness');
assert.doesNotMatch(taskGroups, /level === 'ready'/,
  'Start must not wait for a ready-level readiness modal');

assert.doesNotMatch(targetPage, /sendSync\('stopTarget'/,
  'Legacy Target Stop/Delete must not use sendSync');
assert.match(targetPage, /ipcRenderer\.send\('stopTarget', ids\.map\(String\)\)/);
assert.match(targetPage, /ipcRenderer\.send\('stopTarget', \[id\]\)/);

assert.match(engine, /function normalizeTargetStopIds/);
assert.match(engine, /sendToEngine\(\{ type: 'stop-tasks', messages: requested\.map/);
assert.match(engine, /notifyTargetDone\(requested\)/);
assert.match(engine, /flushStartingStatuses\(statusCoalescer\)/);
assert.match(engine, /status\('Starting', '#868686', 'launching engine', t\.id, 1, true\)/);
assert.match(engine, /proxyMaps\.set\(proxyKey, buildProxyMap/);
assert.match(engine, /function cachedProxySources/);
assert.match(engine, /proxySources: cachedProxySources\(t\.id, t\.proxyListName\)/);
assert.match(engine, /function forgetStatusKeys/);
assert.match(engine, /forgetStatusKeys\(\(config\.tasks \|\| \[\]\)\.map\(task => task && task\.id\)\)/);
assert.equal([...engine.matchAll(/lastStatusKeys = \{\}/g)].length, 1,
  'Start must not wipe status keys for tasks that are already running');
assert.match(engine, /logMonitorLine/);
assert.match(dataManager, /const jsonCache = new Map\(\)/);
assert.match(dataManager, /jsonCache\.set\(filename, data\)/);
assert.match(store, /case 'targetLaunch':/);
assert.match(engine, /flushStartingStatuses\(pokemonStatusCoalescer\)/);
assert.match(engine, /flushStartingStatuses\(walmartStatusCoalescer\)/);
assert.doesNotMatch(engine, /for \(const t of \(config\.tasks \|\| \[\]\)\) \{\s*[\s\S]{0,80}sendToEngine\(\{ type: 'stop-tasks'/,
  'Target stop must not send one engine message per task');

assert.match(bootstrap, /targetStatusBatch/);
assert.doesNotMatch(bootstrap, /webContents\.send\('targetStatus'/,
  'runtime-not-ready must not send one targetStatus IPC per task');
assert.match(bootstrap, /includeBank: payload\.includeBank !== false/);
assert.match(bootstrap, /getReadiness: group => targetReadinessForGroup\(group, undefined, \{ includeBank: false \}\)/);
assert.match(scheduler, /stopTarget\(ids\)/);
assert.doesNotMatch(scheduler, /stopTarget\(String\(task\.id\)\)/);

assert.match(store, /Array\.isArray\(action\.taskIds\)/);
assert.match(pageHandler, /taskIds: payload\.taskIds/);

console.log('Target start/stop batching and non-blocking Start click path passed.');
