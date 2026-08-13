#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const project = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(project, relative), 'utf8');
const configSource = read('scripts/target-multi-harvester-config.fragment.js');
const producerSource = read('scripts/target-multi-harvester-producers.fragment.js');
const rendererSource = read('frontend/src/components/pages/task-groups.js');
const runtimePatchSource = read('scripts/patch-zyn-runtime-brand.js');
const bootstrapSource = read('launcher/bootstrap.js');

let settings = {
  unrelated: 'preserved',
  targetHarvesters: [{
    id: 'default-harvester',
    name: 'Default',
    type: 'atc',
    browser: 'auto',
    workers: 2,
    enabled: true,
    startSchedule: '2026-08-13T20:00:00.000Z',
    stopSchedule: '2026-08-14T02:00:00.000Z',
  }],
};
const configContext = {
  dm: { getSettings: () => settings },
  result: null,
};
vm.runInNewContext(`${configSource}
globalThis.configs = () => managedHarvesterConfigs();
globalThis.setRunning = command => setManagedHarvesterRunning(command);
`, configContext);

assert.equal(configContext.configs()[0].enabled, false,
  'a persisted enabled flag granted start authorization in a fresh process');
assert.equal(configContext.setRunning({ id: 'default-harvester', running: true }), true);
assert.equal(configContext.configs()[0].enabled, true,
  'an explicit Start command did not authorize the configured harvester');
assert.equal(configContext.setRunning({ id: 'default-harvester' }), false,
  'a malformed command changed harvester authorization');
assert.equal(configContext.configs()[0].enabled, true,
  'a malformed command cleared valid session authorization');
assert.equal(configContext.setRunning({ id: 'default-harvester', running: false }), true);
assert.equal(configContext.configs()[0].enabled, false,
  'an explicit Stop command did not revoke session authorization');

configContext.setRunning({ id: 'default-harvester', running: true });
settings = { ...settings, targetHarvesters: [] };
assert.equal(configContext.configs().length, 0);
settings = { ...settings, targetHarvesters: [{ id: 'default-harvester', enabled: true }] };
assert.equal(configContext.configs()[0].enabled, false,
  'deleting and restoring a config revived stale session authorization');

const syncStart = producerSource.indexOf('function syncTargetHarvesters(');
assert.ok(syncStart >= 0, 'could not find managed harvester sync');
const syncSource = producerSource.slice(syncStart);
let commandCount = 0;
const syncContext = {
  attachWindow() {},
  setManagedHarvesterRunning() { commandCount += 1; },
  ensureHarvesterBroker() {},
  syncTargetCookieBankDemand() {},
};
vm.runInNewContext(`${syncSource}
globalThis.sync = syncTargetHarvesters;
`, syncContext);
syncContext.sync({});
assert.equal(commandCount, 0, 'ordinary reconciliation granted run authorization');
syncContext.sync({}, { id: 'default-harvester', running: true });
assert.equal(commandCount, 1, 'explicit Start command was not forwarded to session authorization');

const disarmStart = bootstrapSource.indexOf('function disarmPersistedTargetHarvesters()');
const disarmEnd = bootstrapSource.indexOf('\nfunction installHarvesterExtensionCompatibility(', disarmStart);
assert.ok(disarmStart >= 0 && disarmEnd > disarmStart, 'could not isolate startup disarm');
let savedSettings = null;
const startupSettings = {
  unrelated: 'preserved',
  targetHarvesters: [
    { id: 'running', enabled: true, workers: 3, startSchedule: 'future' },
    { id: 'stopped', enabled: false, workers: 1 },
  ],
};
const startupContext = {
  originalAsar: '/app/app-original.asar',
  path: { join: (...parts) => parts.join('/') },
  require: () => ({
    getSettings: () => startupSettings,
    saveSettings: value => { savedSettings = value; },
  }),
  console: { error() {} },
};
vm.runInNewContext(`${bootstrapSource.slice(disarmStart, disarmEnd)}
globalThis.disarm = disarmPersistedTargetHarvesters;
`, startupContext);
assert.equal(startupContext.disarm(), 1);
assert.equal(savedSettings.targetHarvesters[0].enabled, false);
assert.equal(savedSettings.targetHarvesters[0].workers, 3);
assert.equal(savedSettings.targetHarvesters[0].startSchedule, 'future');
assert.equal(savedSettings.targetHarvesters[1].enabled, false);
assert.equal(savedSettings.unrelated, 'preserved');

assert.match(rendererSource, /const EMPTY_HARVESTER = Object\.freeze\([\s\S]*?enabled: false/,
  'new harvesters do not default to Stopped');
assert.doesNotMatch(rendererSource, /Start this harvester/,
  'the configuration modal can still start a harvester without the card Start button');
assert.match(rendererSource, /Saving never starts a harvester[\s\S]*Use its Start button/,
  'the schedule editor does not explain session-only Start authorization');
assert.match(rendererSource,
  /persistHarvesters\(harvesters, null, \{ id: harvester\.id, running \}\)/,
  'Start/Stop clicks do not send an explicit run command');
assert.match(runtimePatchSource,
  /ipcMain\.on\('syncTargetHarvesters', \(e, runCommand\)[\s\S]*syncTargetHarvesters\(mainWindow, runCommand \|\| null\)/,
  'the main-process bridge does not forward explicit run authorization');
assert.match(bootstrapSource,
  /disarmPersistedTargetHarvesters\(\);[\s\S]*installTaskGroups\(\);/,
  'saved run state is not disarmed before Target startup');

console.log('Target harvesters require an explicit Start click in every app session');
