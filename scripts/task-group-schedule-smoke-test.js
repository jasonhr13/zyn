#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {
  CATCH_UP_MS,
  evaluateScheduleAction,
  normalizeSchedule,
  timerDelayMs,
} = require('../launcher/task-group-schedule');
const { buildTargetGroupLaunch } = require('../launcher/target-group-launch');
const { createTaskGroupScheduler } = require('../launcher/task-group-scheduler');

const now = Date.UTC(2026, 7, 9, 12, 0, 0);
const project = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(project, relative), 'utf8');

assert.deepEqual(normalizeSchedule({ startAt: now + 1000, stopAt: now + 2000 }), {
  startAt: now + 1000,
  stopAt: now + 2000,
});
assert.equal(normalizeSchedule({ startAt: now }, 'unsupported'), null);
assert.equal(evaluateScheduleAction({ startAt: now - CATCH_UP_MS - 1 }, { now }).action, 'clear-start');
assert.equal(evaluateScheduleAction({ startAt: now - 1, stopAt: now + 1000 }, { now }).action, 'start');
assert.equal(evaluateScheduleAction({ stopAt: now - 1 }, { now, groupRunning: true }).action, 'stop');
assert.equal(timerDelayMs(now + 5000, now), 5000);

const accounts = [{ id: 'account-1', email: 'buyer@example.com', site: 'target' }];
const profiles = [{ id: 'profile-1', email: 'buyer@example.com' }];
const baseGroup = {
  id: 'group-1',
  name: 'Drop',
  site: 'target',
  skus: '12345678\nhttps://www.target.com/p/example/-/A-87654321',
  items: [
    { sku: '12345678', maxPrice: '24.99', priority: true },
    { sku: '87654321', maxPrice: '' },
  ],
  qty: 2,
  useFillerItem: true,
  stockConfidence: 'confirmed-10-plus',
  tasks: [{ id: 'task-1', accountId: 'account-1', proxyListName: 'Local', loopCheckout: true }],
};

const launch = buildTargetGroupLaunch(baseGroup, { accounts, profiles });
assert.equal(launch.ok, true);
assert.deepEqual(launch.config.skus, ['12345678', '87654321']);
assert.deepEqual(launch.config.items, [
  { sku: '12345678', maxPrice: '24.99', priority: true },
  { sku: '87654321', maxPrice: '' },
]);
assert.equal(launch.config.ignoreLowStock, true);
assert.equal(launch.config.tasks[0].profileId, 'profile-1');
assert.equal(launch.config.tasks[0].loopCheckout, true);
assert.equal(launch.config.useFillerItem, true, 'scheduled launch omitted the group filler-item setting');

const fakeSetTimeout = (callback, delay) => ({ callback, delay, unref() {} });
const fakeClearTimeout = () => {};
let groups = [{ ...baseGroup, schedule: { startAt: now - 500, stopAt: now + 60_000 } }];
const running = new Set();
const starts = [];
const stops = [];
const events = [];
const scheduler = createTaskGroupScheduler({
  getGroups: () => structuredClone(groups),
  saveGroups: next => { groups = structuredClone(next); return structuredClone(groups); },
  getAccounts: () => accounts,
  getProfiles: () => profiles,
  isTaskRunning: id => running.has(id),
  startTarget: config => { starts.push(config); config.tasks.forEach(task => running.add(task.id)); },
  stopTarget: taskId => {
    const ids = Array.isArray(taskId) ? taskId : [taskId];
    for (const id of ids) {
      stops.push(String(id));
      running.delete(String(id));
    }
  },
  canStart: () => true,
  notify: event => events.push(event),
  now: () => now,
  setTimeout: fakeSetTimeout,
  clearTimeout: fakeClearTimeout,
});

scheduler.sync();
assert.equal(starts.length, 1, 'due task-group start did not fire');
assert.equal(groups[0].schedule.startAt, null);
assert.equal(groups[0].schedule.stopAt, now + 60_000);
assert.ok(events.some(event => event.event === 'start'));

groups = [{ ...baseGroup, schedule: { startAt: null, stopAt: now - 1 } }];
running.add('task-1');
scheduler.sync();
assert.deepEqual(stops, ['task-1']);
assert.equal(groups[0].schedule, undefined);

groups = [{ ...baseGroup, schedule: { startAt: now - 500, stopAt: now + 500 } }];
scheduler.fireStop('group-1');
assert.equal(groups[0].schedule, undefined, 'stop boundary left a pending start that could fire late');

let licensed = false;
groups = [{ ...baseGroup, schedule: { startAt: now - 500, stopAt: now + 60_000 } }];
const gated = createTaskGroupScheduler({
  getGroups: () => structuredClone(groups),
  saveGroups: next => { groups = structuredClone(next); return structuredClone(groups); },
  getAccounts: () => accounts,
  getProfiles: () => profiles,
  canStart: () => licensed,
  startTarget: config => starts.push(config),
  now: () => now,
  setTimeout: fakeSetTimeout,
  clearTimeout: fakeClearTimeout,
});
gated.sync();
assert.equal(groups[0].schedule.startAt, now - 500, 'unlicensed start was discarded');
licensed = true;
gated.sync();
assert.equal(starts.length, 2, 'preserved start did not fire after sign-in');

groups = [{ ...baseGroup, schedule: { startAt: now - 500, stopAt: now + 60_000 } }];
const beforePause = starts.length;
scheduler.pause();
scheduler.sync();
assert.equal(starts.length, beforePause, 'paused scheduler launched a task during restore');
assert.equal(scheduler.snapshot().paused, true);
scheduler.resume();
assert.equal(starts.length, beforePause + 1, 'resumed scheduler did not reconcile restored schedules');
assert.equal(scheduler.snapshot().paused, false);

scheduler.dispose();
gated.dispose();

const contract = JSON.parse(read('config/runtime-contract.json'));
assert.equal(contract.features.taskScheduling, true);
for (const file of ['task-group-schedule.js', 'task-group-scheduler.js', 'target-group-launch.js']) {
  assert.ok(contract.requiredResources.includes(`Contents/Resources/app/${file}`), `${file} is missing from the runtime contract`);
  assert.match(read('scripts/build-zyn.sh'), new RegExp(file.replaceAll('.', '\\.')),
    `${file} is not copied into packaged apps`);
}
const bootstrap = read('launcher/bootstrap.js');
const taskGroupsPage = read('frontend/src/components/pages/task-groups.js');
const targetEngine = read('runtime-app/public/helpers/target-engine.js');
assert.match(bootstrap, /createTaskGroupScheduler/);
assert.match(bootstrap, /includeBank: false/,
  'scheduled Target starts must not wait on the cookie bank HTTP probe');
assert.match(bootstrap, /taskGroupScheduler\?\.sync\(\)/,
  'saving task groups does not reconcile main-process timers');
assert.match(bootstrap, /webContents\.send\('taskGroupSchedule'/,
  'timer actions do not refresh the renderer');
assert.match(taskGroupsPage, /> Schedule<\/button>/);
assert.match(taskGroupsPage, /ipcRenderer\.on\('taskGroupSchedule'/);
assert.match(taskGroupsPage, /Loop checkout by default/);
assert.match(taskGroupsPage, /Loop checkout for these tasks/);
assert.match(taskGroupsPage, /updateTaskLoopCheckout/);
assert.match(taskGroupsPage, /Pre-cart filler item/);
assert.match(taskGroupsPage, /useFillerItem: group\.useFillerItem === true/,
  'manual task-group launch omitted the filler-item setting');
assert.match(targetEngine, /useFillerItem: !!config\.useFillerItem/,
  'native Target bridge does not forward the group filler-item setting to Go');

(async () => {
  let readinessGroups = [{ ...baseGroup, schedule: { startAt: now - 500, stopAt: now + 60_000 } }];
  const readinessStarts = [];
  const readinessEvents = [];
  const warningScheduler = createTaskGroupScheduler({
    getGroups: () => structuredClone(readinessGroups),
    saveGroups: next => { readinessGroups = structuredClone(next); return structuredClone(readinessGroups); },
    getAccounts: () => accounts,
    getProfiles: () => profiles,
    getReadiness: async () => ({
      level: 'warning', blockers: [], warnings: [{ title: 'Cookie bank below target' }],
    }),
    startTarget: config => readinessStarts.push(config),
    notify: event => readinessEvents.push(event),
    now: () => now,
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
  });
  await warningScheduler.fireStart('group-1');
  assert.equal(readinessStarts.length, 1, 'scheduled readiness warning blocked an otherwise valid start');
  assert.ok(readinessEvents.some(event => event.event === 'start-warning'));
  warningScheduler.dispose();

  readinessGroups = [{ ...baseGroup, schedule: { startAt: now - 500, stopAt: now + 60_000 } }];
  const blockedScheduler = createTaskGroupScheduler({
    getGroups: () => structuredClone(readinessGroups),
    saveGroups: next => { readinessGroups = structuredClone(next); return structuredClone(readinessGroups); },
    getAccounts: () => accounts,
    getProfiles: () => profiles,
    getReadiness: async () => ({
      level: 'blocked', blockers: [{ title: 'Missing checkout profile' }], warnings: [],
    }),
    startTarget: config => readinessStarts.push(config),
    notify: event => readinessEvents.push(event),
    now: () => now,
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
  });
  await blockedScheduler.fireStart('group-1');
  assert.equal(readinessStarts.length, 1, 'scheduled readiness blocker still launched Target');
  assert.ok(readinessEvents.some(event => event.event === 'start-failed' && /start blocked/.test(event.line)));
  blockedScheduler.dispose();

  const renderer = await import('../frontend/src/components/task-group-schedule.mjs');
  const draft = renderer.buildScheduleFromDraft({
    startMode: 'in', startAmount: '30', startUnit: 'minutes',
    stopMode: 'in', stopAmount: '2', stopUnit: 'hours',
  }, now);
  assert.equal(draft.schedule.startAt, now + 30 * 60_000);
  assert.equal(draft.schedule.stopAt, now + 2 * 3_600_000);
  assert.match(renderer.scheduleSummary(draft.schedule, now), /Starts in 30m.*Stops in 2h/);
  console.log('Task-group persisted scheduling, catch-up, launch, stop, and renderer helpers passed');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
