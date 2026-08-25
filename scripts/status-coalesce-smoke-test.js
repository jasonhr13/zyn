#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { createStatusCoalescer, STATUS_FLUSH_MS } = require('../runtime-app/public/helpers/status-coalesce');

const sent = [];
let now = 0;
const timers = [];
const coalescer = createStatusCoalescer({
  send: batch => {
    assert.ok(Array.isArray(batch), 'a flush must send one array, not one IPC per task');
    sent.push(...batch);
  },
  intervalMs: 64,
  setTimeoutFn: (fn, ms) => {
    const timer = { fn, at: now + ms, id: timers.length + 1 };
    timers.push(timer);
    return timer.id;
  },
  clearTimeoutFn: id => {
    const index = timers.findIndex(timer => timer.id === id);
    if (index >= 0) timers.splice(index, 1);
  },
});

function advance(ms) {
  now += ms;
  const due = timers.filter(timer => timer.at <= now);
  for (const timer of due) {
    const index = timers.indexOf(timer);
    if (index >= 0) timers.splice(index, 1);
    timer.fn();
  }
}

coalescer.enqueue('a', { taskId: 'a', state: 'Waiting For Restock' });
coalescer.enqueue('a', { taskId: 'a', state: 'Adding To Cart' });
coalescer.enqueue('b', { taskId: 'b', state: 'Waiting For Restock' });
assert.deepEqual(sent, [], 'statuses must not cross to the renderer before the flush window');

advance(64);
assert.deepEqual(sent.map(item => `${item.taskId}:${item.state}`), [
  'a:Adding To Cart',
  'b:Waiting For Restock',
], 'one flush must keep only the latest status per task');

sent.length = 0;
coalescer.enqueue('a', { taskId: 'a', state: 'Submitting Order' });
coalescer.enqueue('a', { taskId: 'a', state: 'Idle', running: false }, { immediate: true });
assert.deepEqual(sent.map(item => item.state), ['Idle'], 'a stopped task must flush immediately');
assert.equal(timers.length, 0, 'an immediate flush must cancel the pending timer');

sent.length = 0;
coalescer.enqueue('a', { taskId: 'a', state: 'Checking Out' });
coalescer.drop('a');
advance(64);
assert.deepEqual(sent, [], 'a dropped task must not deliver a stale status after Stop');

assert.equal(STATUS_FLUSH_MS, 64);

const engine = fs.readFileSync(
  path.join(__dirname, '..', 'runtime-app', 'public', 'helpers', 'target-engine.js'),
  'utf8',
);
assert.match(engine, /require\('\.\/status-coalesce'\)/);
assert.match(engine, /statusCoalescer\.enqueue/);
assert.match(engine, /targetStatusBatch/);
assert.match(engine, /targetLogBatch/);
assert.match(engine, /pokemonLogBatch/);
assert.match(engine, /walmartLogBatch/);
assert.match(engine, /pokemonStatusBatch/);
assert.match(engine, /walmartStatusBatch/);
assert.match(engine, /running === false/);
assert.match(engine, /statusCoalescer\.dropAll\(\)/);
assert.match(engine, /statusCoalescer\.drop\(/);
assert.match(engine, /for \(const t of \(config\.tasks \|\| \[\]\)\) statusCoalescer\.drop\(t\.id\)/);
assert.match(engine, /flushStartingStatuses\(statusCoalescer\)/);
assert.match(engine, /flushStartingStatuses\(pokemonStatusCoalescer\)/);
assert.match(engine, /flushStartingStatuses\(walmartStatusCoalescer\)/);
assert.match(engine, /normalizeTargetStopIds/);
assert.match(engine, /notifyTargetDone\(requested\)/);

const taskGroups = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'src', 'components', 'pages', 'task-groups.js'),
  'utf8',
);
assert.match(taskGroups, /mapTaskRowState/);
assert.match(taskGroups, /connect\(mapTaskRowState\)/);
assert.match(taskGroups, /connect\(mapTaskDetailState\)/);
assert.match(taskGroups, /<VirtualLogView/);
assert.match(taskGroups, /showOperatorLogs/);
assert.doesNotMatch(taskGroups, /target:\s*s\.target|target:\s*state\.target/,
  'Task Groups must not subscribe to the whole Target runtime object');

console.log('Target status coalescing and Task Groups row isolation smoke test passed');
