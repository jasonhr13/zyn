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

assert.match(sidebar, /to:\s*'\/task-groups'[\s\S]*label:\s*'Tasks'/);
assert.doesNotMatch(sidebar, /label:\s*'Generate'|to:\s*'\/modules'/);

for (const retired of ['modules', 'tasks', 'generate', 'pbandai', 'round1', 'riotgames', 'pokemoncenter', 'walmart']) {
  assert.doesNotMatch(routes, new RegExp(`(?:pages/|path=")${retired}`));
}
assert.match(routes, /<Redirect to="\/task-groups" \/>/);

assert.match(settings, /Target workspace/);
assert.doesNotMatch(settings, /Bandai|Walmart|Pokémon|Pokemon|Round1|Riot Games|Secret Lair|Auto Buy Profiles|Solver Keys/);

console.log('Target-only UI smoke test passed');
