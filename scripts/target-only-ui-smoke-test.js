#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

const accounts = read('frontend/src/components/pages/accounts.js');
const sidebar = read('frontend/src/components/sidebar.js');
const routes = read('frontend/src/components/page-handler.js');
const settings = read('frontend/src/components/pages/settings.js');

assert.doesNotMatch(accounts, /SITE_TABS|activeSite|account-site-picker/);
assert.match(accounts, /addAccountsBulk'[\s\S]*site:\s*'target'/);
assert.match(accounts, /<option value="target">Target<\/option>/);
assert.match(accounts, /filter\(isTargetAccount\)/);
assert.match(accounts, /ipcRenderer\.sendSync\('updateAccount', \{ id: editingId, data \}\)/);
assert.match(accounts, /Leave blank to keep the saved password/);
assert.match(accounts, /data\.profileId = matchingProfile \? matchingProfile\.id : null/);
assert.match(accounts, /if \(emailChanged \|\| passwordChanged\) data\.cookie = ''/);

assert.match(sidebar, /to:\s*'\/task-groups'[\s\S]*label:\s*'Target'[\s\S]*section:\s*'Tasks'/);
assert.match(sidebar, /to:\s*'\/pokemoncenter'[\s\S]*label:\s*'Pokémon Center'[\s\S]*taskType:\s*'pokemoncenter'/);
assert.match(sidebar, /activeRoutes:\s*\['\/task-groups',\s*'\/target'\]/);
assert.doesNotMatch(sidebar, /label:\s*'Tasks'[\s\S]*to:\s*'\/modules'/);
assert.match(routes, /<Sidebar taskTypes=\{license\.taskTypes \|\| \{\}\} \/>/);
assert.match(sidebar, /Update to v\{update\.version\}/);
assert.match(sidebar, /background:\s*'var\(--ok\)'[\s\S]{0,80}color:\s*'#000'/);
assert.doesNotMatch(sidebar, /label:\s*'Generate'/);

for (const retired of ['tasks', 'generate', 'pbandai', 'round1', 'riotgames', 'walmart']) {
  assert.doesNotMatch(routes, new RegExp(`(?:pages/|path=")${retired}`));
}
assert.match(routes, /pages\/modules/);
assert.match(routes, /pages\/pokemoncenter/);
assert.match(routes, /license\.taskTypes[\s\S]*pokemoncenter/);
assert.match(routes, /<Redirect to="\/modules" \/>/);

assert.match(settings, /Target workspace/);
assert.doesNotMatch(settings, /Bandai|Walmart|Pokémon|Pokemon|Round1|Riot Games|Secret Lair|Auto Buy Profiles|Solver Keys/);

const extensionSettings = settings.indexOf('Target — Chrome Extension Harvester');
const operatorSettings = settings.indexOf('{operatorMode && (<>');
assert.ok(extensionSettings >= 0 && extensionSettings < operatorSettings,
  'Chrome extension harvester settings must be visible without operator mode');
const publicHarvesterSettings = settings.slice(extensionSettings, operatorSettings);
assert.match(publicHarvesterSettings, /Chrome extension harvesting/);
assert.match(publicHarvesterSettings, /value=\{targetHarvesterExtensionId\}/);
assert.match(publicHarvesterSettings, /in-app harvesters can run at the same time and feed the same Target cookie bank/,
  'Settings must explain that extension and in-app harvesting are additive');
assert.match(settings, /ipcRenderer\.send\('resetHarvesterExtensionActivity'\)/,
  'changing extension settings must reset stale bridge activity');
const advancedHarvesterSettings = settings.slice(operatorSettings, settings.indexOf('Email / OTP', operatorSettings));
assert.doesNotMatch(advancedHarvesterSettings, /value=\{shapeMethod\}|value=\{targetHarvesterExtensionId\}/,
  'Chrome extension controls must not remain operator-only');

console.log('Target and Pokemon Center UI smoke test passed');
