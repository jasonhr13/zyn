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

const extensionSettings = settings.indexOf('Target — Browser Extension Harvesters');
const operatorSettings = settings.indexOf('{operatorMode && (<>');
assert.ok(extensionSettings >= 0 && extensionSettings < operatorSettings,
  'Chrome extension harvester settings must be visible without operator mode');
const publicHarvesterSettings = settings.slice(extensionSettings, operatorSettings);
assert.match(publicHarvesterSettings, /Browser extension harvesting/);
assert.match(publicHarvesterSettings, /value=\{targetHarvesterExtensionIds\}/);
assert.match(publicHarvesterSettings, /Chrome, Brave, or multiple browser profiles at once/,
  'Settings must explain simultaneous multi-browser harvesting');
assert.match(publicHarvesterSettings, /Browser extension IDs/);
assert.match(publicHarvesterSettings, /extensionIdsError/);
assert.match(publicHarvesterSettings, /role="alert"/);
assert.match(settings, /targetHarvesterExtensionIds\.split\('\\n'\)\[0\]/,
  'saving multiple IDs must preserve the legacy singular setting');
assert.match(settings,
  /const targetHarvesterExtensionIds = !extensionModeEnabled && parsedExtensionIds\.error[\s\S]{0,100}\? previousExtensionIds[\s\S]{0,100}: parsedExtensionIds\.normalized/,
  'turning harvesting off must preserve the prior valid IDs when the hidden draft is invalid');
assert.match(settings, /ipcRenderer\.send\('resetHarvesterExtensionActivity'\)/,
  'changing extension settings must reset stale bridge activity');
const advancedHarvesterSettings = settings.slice(operatorSettings, settings.indexOf('Email / OTP', operatorSettings));
assert.doesNotMatch(advancedHarvesterSettings, /value=\{shapeMethod\}|value=\{targetHarvesterExtensionIds\}/,
  'Chrome extension controls must not remain operator-only');

console.log('Target and Pokemon Center UI smoke test passed');
