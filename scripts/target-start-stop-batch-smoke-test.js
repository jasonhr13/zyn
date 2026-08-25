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
  'Start must not wait on the cookie-bank HTTP probe');
assert.match(taskGroups, /intent === 'start' && readiness && readiness\.ok/,
  'Start must launch when there are no blockers, including cookie-bank warnings');
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
assert.match(engine, /flushStartingStatuses\(pokemonStatusCoalescer\)/);
assert.match(engine, /flushStartingStatuses\(walmartStatusCoalescer\)/);
assert.doesNotMatch(engine, /for \(const t of \(config\.tasks \|\| \[\]\)\) \{\s*[\s\S]{0,80}sendToEngine\(\{ type: 'stop-tasks'/,
  'Target stop must not send one engine message per task');

assert.match(bootstrap, /includeBank: payload\.includeBank !== false/);
assert.match(bootstrap, /getReadiness: group => targetReadinessForGroup\(group, undefined, \{ includeBank: false \}\)/);
assert.match(scheduler, /stopTarget\(ids\)/);
assert.doesNotMatch(scheduler, /stopTarget\(String\(task\.id\)\)/);

assert.match(store, /Array\.isArray\(action\.taskIds\)/);
assert.match(pageHandler, /taskIds: payload\.taskIds/);

console.log('Target start/stop batching and non-blocking Start click path passed.');
