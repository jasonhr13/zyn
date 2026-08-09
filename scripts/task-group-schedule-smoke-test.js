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
  qty: 2,
  tasks: [{ id: 'task-1', accountId: 'account-1', proxyListName: 'Local' }],
};

const launch = buildTargetGroupLaunch(baseGroup, { accounts, profiles });
assert.equal(launch.ok, true);
assert.deepEqual(launch.config.skus, ['12345678', '87654321']);
assert.equal(launch.config.tasks[0].profileId, 'profile-1');

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
  stopTarget: id => { stops.push(id); running.delete(id); },
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
assert.match(bootstrap, /createTaskGroupScheduler/);
assert.match(bootstrap, /taskGroupScheduler\?\.sync\(\)/,
  'saving task groups does not reconcile main-process timers');
assert.match(bootstrap, /webContents\.send\('taskGroupSchedule'/,
  'timer actions do not refresh the renderer');
assert.match(taskGroupsPage, /> Schedule<\/button>/);
assert.match(taskGroupsPage, /ipcRenderer\.on\('taskGroupSchedule'/);

(async () => {
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
