#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const project = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(project, relative), 'utf8');

const gate = read('frontend/src/components/license-gate.js');
const settings = read('frontend/src/components/pages/settings.js');
const authority = read('launcher/license-authority.js');
const client = read('launcher/license-client.js');
const worker = read('cloudflare/license/src/index.js');
const mobile = read('cloudflare/license/src/mobile-harvester.js');
const bootstrap = read('launcher/bootstrap.js');
const companion = read('launcher/companion-harvester-bridge.js');
const migration = read('cloudflare/license/migrations/0016_session_kind.sql');

assert.match(migration, /session_kind TEXT NOT NULL DEFAULT 'engine'/);
assert.match(worker, /COALESCE\(session_kind, 'engine'\) = 'engine'/);
assert.match(worker, /if \(kind === 'engine'\)/);
assert.match(worker, /\/api\/license\/session-kind/);
assert.match(client, /sessionKind/);
assert.match(client, /\/api\/harvester\/room/);
assert.match(authority, /setLicenseSessionKind/);
assert.match(authority, /getPreferredSessionKind/);
assert.match(gate, /sessionKind: 'harvester'/);
assert.match(gate, /loginLicense', \{ email, password, sessionKind \}/);
assert.match(settings, /setLicenseSessionKind/);
assert.match(mobile, /role === 'companion'/);
assert.match(mobile, /engine_required/);
assert.match(mobile, /harvester_required/);
assert.match(bootstrap, /sessionKind !== 'harvester'/);
assert.match(bootstrap, /createCompanionHarvesterBridge/);
assert.match(bootstrap, /remoteHarvesterStatus/);
assert.match(bootstrap, /remoteHarvesterReconnect/);
assert.match(bootstrap, /role: 'host'/);
assert.match(bootstrap, /companionCount/);
assert.match(companion, /role: 'companion'/);
assert.match(companion, /source: 'remote'/);
assert.match(companion, /DRAIN_BATCH = 12/);
assert.match(companion, /sendRate/);
assert.doesNotMatch(
  companion.slice(companion.indexOf('const drainOnce'), companion.indexOf('const scheduleDrain')),
  /ensureBroker/,
);
const hostBridge = read('launcher/mobile-harvester-bridge.js');
assert.match(hostBridge, /companionsJoined/);
const taskGroups = read('frontend/src/components/pages/task-groups.js');
assert.match(taskGroups, /harvest-workspace/);
assert.match(taskGroups, /Per sec/);
assert.match(taskGroups, /harvestOnly/);
assert.match(taskGroups, /Cookie Harvesters/);
assert.match(taskGroups, /Checkout tasks are not available in Harvester only/);
assert.doesNotMatch(
  taskGroups.slice(taskGroups.indexOf('renderHarvestWorkspace()'), taskGroups.indexOf('renderHarvesterDrawer() {')),
  /ATC per task/,
);
const harvestWorkspace = taskGroups.slice(
  taskGroups.indexOf('renderHarvestWorkspace()'),
  taskGroups.indexOf('renderHarvesterDrawer() {'),
);
assert.doesNotMatch(harvestWorkspace, /<small>Remote<\/small>/);
const drawer = taskGroups.slice(taskGroups.indexOf('renderHarvesterDrawer() {'));
assert.match(drawer, /<small>Remote<\/small>/);
assert.match(drawer, /Remote apps/);
assert.match(drawer, /Remote harvest machines/);
assert.match(taskGroups, /harvest-only app/);
assert.match(taskGroups, /remoteHarvesterSummary/);
assert.match(taskGroups, /remoteHarvesterCopy/);
assert.match(taskGroups, /Reconnect/);
assert.match(taskGroups, /remoteHarvesterReconnect/);
assert.match(companion, /engineOnline/);
assert.match(companion, /healthOnce/);
assert.match(hostBridge, /reconnect\(\)/);
assert.match(settings, /Reconnect/);
const pageHandler = read('frontend/src/components/page-handler.js');
assert.match(pageHandler, /harvestOnly=\{license\.sessionKind === 'harvester'\}/);

console.log(JSON.stringify({ ok: true, sessionKind: true, remoteHarvest: true }, null, 2));
