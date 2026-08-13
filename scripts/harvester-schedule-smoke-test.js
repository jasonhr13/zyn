#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const project = path.resolve(__dirname, '..');
const configSource = fs.readFileSync(
  path.join(project, 'scripts', 'target-multi-harvester-config.fragment.js'),
  'utf8',
);
const producerSource = fs.readFileSync(
  path.join(project, 'scripts', 'target-multi-harvester-producers.fragment.js'),
  'utf8',
);
const rendererSource = fs.readFileSync(
  path.join(project, 'frontend', 'src', 'components', 'pages', 'task-groups.js'),
  'utf8',
);

const start = Date.UTC(2026, 7, 9, 12, 0, 0);
const stop = start + 60 * 60_000;
const sandbox = {
  dm: {
    getSettings: () => ({
      targetHarvesters: [{
        id: 'scheduled-harvester',
        name: 'Scheduled',
        type: 'auto',
        browser: 'auto',
        workers: 2,
        enabled: true,
        startSchedule: new Date(start).toISOString(),
        stopSchedule: new Date(stop).toISOString(),
      }],
    }),
  },
  result: null,
};
vm.runInNewContext(`${configSource}
setManagedHarvesterRunning({ id: 'scheduled-harvester', running: true });
const smokeConfig = managedHarvesterConfigs()[0];
result = {
  config: smokeConfig,
  before: harvesterScheduleActive(smokeConfig, ${start - 1}),
  during: harvesterScheduleActive(smokeConfig, ${start}),
  after: harvesterScheduleActive(smokeConfig, ${stop}),
  disabled: harvesterScheduleActive({ ...smokeConfig, enabled: false }, ${start}),
};`, sandbox);

assert.equal(sandbox.result.config.startSchedule, new Date(start).toISOString());
assert.equal(sandbox.result.config.stopSchedule, new Date(stop).toISOString());
assert.equal(sandbox.result.before, false);
assert.equal(sandbox.result.during, true);
assert.equal(sandbox.result.after, false);
assert.equal(sandbox.result.disabled, false);

const emptySandbox = {
  dm: { getSettings: () => ({}) },
  result: null,
};
vm.runInNewContext(`${configSource}
result = {
  configs: managedHarvesterConfigs(),
  managed: managedHarvesterMode(),
};`, emptySandbox);
assert.equal(Array.isArray(emptySandbox.result.configs), true);
assert.equal(emptySandbox.result.configs.length, 0,
  'missing settings must not synthesize a harvester configuration');
assert.equal(emptySandbox.result.managed, true,
  'missing settings must block the legacy task-owned farmer path');

assert.match(producerSource, /setInterval\([\s\S]*ensureHarvesterBroker\(\)[\s\S]*15000/,
  'harvester schedules are not reconciled by a background timer');
assert.match(rendererSource, /type="datetime-local" value=\{draft\.startSchedule\}/);
assert.match(rendererSource, /type="datetime-local" value=\{draft\.stopSchedule\}/);
assert.match(rendererSource, /Stop Schedule must be later than Start Schedule/);

console.log('Harvester persisted start/end window and background reconciliation passed');
