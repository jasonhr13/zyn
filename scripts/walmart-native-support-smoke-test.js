#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { engineSourceRoot } = require('./zyn-engine-source.cjs');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

const engine = read('runtime-app/public/helpers/target-engine.js');
const electron = read('runtime-app/public/electron.js');
const reporter = read('runtime-app/public/helpers/checkout-reporter.js');
const page = read('frontend/src/components/pages/walmart.js');
const createProfile = read('frontend/src/components/pages/profiles-components/create-modal.js');
const profilesPage = read('frontend/src/components/pages/profiles.js');
const routes = read('frontend/src/components/page-handler.js');
const sidebar = read('frontend/src/components/sidebar.js');
const modules = read('frontend/src/components/pages/modules.js');
const accounts = read('frontend/src/components/pages/accounts.js');
const dataManager = read('runtime-app/public/helpers/data-manager.js');
const access = read('launcher/task-type-access.js');
const contract = read('launcher/native-engine-contract.js');
const siteconfig = fs.readFileSync(path.join(engineSourceRoot(), 'bot-base/siteconfig/siteconfig.go'), 'utf8');
const dispatch = fs.readFileSync(path.join(engineSourceRoot(), 'frontend/dispatch_zyn.go'), 'utf8');
const walmartCheckout = fs.readFileSync(path.join(engineSourceRoot(), 'sites/walmart/checkout.go'), 'utf8');
const walmartFunctions = fs.readFileSync(path.join(engineSourceRoot(), 'sites/walmart/functions.go'), 'utf8');

assert.match(dispatch, /walmart\.StartTask/);
assert.match(walmartCheckout, /Waiting for Input/);
assert.match(walmartFunctions, /isPlaceholderInput/);
assert.match(engine, /input\.toLowerCase\(\) === 'placeholder'/);
assert.match(siteconfig, /if trimmed == "" \{\s*return\s*\}/s,
  'empty SetLucaAPIKey must not wipe Polar lucaApiKey');
assert.match(contract, /WALMART: 'Walmart'/);
assert.match(access, /key: 'walmart'/);
const queueEvents = read('launcher/pokemon-queue-events.js');
const bootstrap = read('launcher/bootstrap.js');
const authority = read('launcher/license-authority.js');
assert.match(engine, /function startWalmart\(/);
assert.match(engine, /function stopWalmart\(/);
assert.match(engine, /function editWalmart\(/);
assert.match(engine, /function setSolverLucaKey\(/);
assert.match(engine, /lucaApiKey: solverLucaApiKey/);
assert.doesNotMatch(engine, /webhookSettings\.lucaApiKey|getSettings\(\)\.lucaApiKey/,
  'desktop must not load Luca from settings.json');
assert.match(engine, /'-key', 'local'/);
assert.doesNotMatch(engine, /polar-wss-production/);
assert.match(queueEvents, /onSolverConfig/);
assert.match(queueEvents, /taskTypes\.walmart === true/);
assert.doesNotMatch(queueEvents, /polar-wss-production|licenseKey|siteConfigs/);
assert.match(bootstrap, /onSolverConfig: key => engine\.setSolverLucaKey/);
assert.match(authority, /!taskTypes\.pokemoncenter && !taskTypes\.walmart/);
assert.match(engine, /function validateWalmartProducts\(/);
assert.match(page, /Add product/);
assert.match(page, /placeholder/);
assert.match(page, /Apply to all tasks/);
assert.match(page, /one task each/);
assert.match(page, /MAX_PRODUCTS = 10/);
assert.match(engine, /site: WALMART_SITE/);
assert.match(engine, /type: 'start-monitors'/);
assert.match(engine, /walmart-monitor-\$/);
assert.match(engine, /site: 'walmart'/);
assert.match(engine, /received-code[\s\S]*site/);
assert.match(reporter, /'walmart'/);
assert.match(reporter, /PUBLIC_SITES = new Set\(\['target', 'pokemoncenter', 'walmart'\]\)/);
assert.match(electron, /ipcMain\.on\('startWalmart'/);
assert.match(electron, /moduleBlocked\('walmart'\)/);
assert.match(page, /startWalmart/);
assert.match(page, /toggleDraftAccount/);
assert.match(page, /applyProductsToAllTasks/);
assert.match(routes, /taskTypes\.walmart/);
assert.match(sidebar, /taskType: 'walmart'/);
assert.match(modules, /taskType: 'walmart'/);
assert.match(accounts, /SITE_TABS/);
assert.match(accounts, /id: 'walmart'/);
assert.match(dataManager, /function matchingProfileForAccount/);
assert.match(dataManager, /function linkAccountsToProfile/);
assert.match(createProfile, /<option value="walmart">Walmart<\/option>/);
assert.match(createProfile, /profileType !== 'pokemoncenter'/);
assert.match(profilesPage, /walmart \? 'WALMART' : 'TARGET'/);
assert.match(page, /profileType\) \|\| ''\)\.toLowerCase\(\) === 'walmart'/);
assert.match(page, /Engine log/);
assert.match(page, /engineLogRef/);
assert.match(read('frontend/src/components/store.js'), /walmartDone[\s\S]*action\.idle/);
assert.match(read('runtime-app/public/helpers/target-engine.js'), /walmartDone\(id, \{ idle: true \}\)/);
assert.match(engine, /profileType\) \|\| ''\)\.toLowerCase\(\) === 'walmart'/);

console.log(JSON.stringify({
  ok: true,
  site: 'Walmart',
  lucaEmptyIsNoop: true,
  publicDiscord: true,
  localMonitor: true,
}, null, 2));
