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
const page = read('frontend/src/components/pages/costco.js');
const routes = read('frontend/src/components/page-handler.js');
const sidebar = read('frontend/src/components/sidebar.js');
const modules = read('frontend/src/components/pages/modules.js');
const store = read('frontend/src/components/store.js');
const dataManager = read('runtime-app/public/helpers/data-manager.js');
const access = read('launcher/task-type-access.js');
const contract = read('launcher/native-engine-contract.js');
const dispatch = fs.readFileSync(path.join(engineSourceRoot(), 'frontend/dispatch_zyn.go'), 'utf8');
const costcoInit = fs.readFileSync(path.join(engineSourceRoot(), 'sites/costco/init.go'), 'utf8');
const queueTask = fs.readFileSync(path.join(engineSourceRoot(), 'sites/queueit/task.go'), 'utf8');
const browser = read('bot-runtime/queue-pass-browser.mjs');

assert.match(dispatch, /costco\.StartTask/);
assert.match(costcoInit, /Queue Runner/);
assert.match(costcoInit, /queueit\.StartTask/);
assert.match(contract, /COSTCO: 'Costco'/);
assert.match(contract, /'queue-pass'/);
assert.match(engine, /function startCostco\(/);
assert.match(engine, /function stopCostco\(/);
assert.match(engine, /function setCostcoTaskProxy\(/);
assert.match(engine, /function flushCostcoStarts\(/);
assert.match(engine, /case 'queue-pass'/);
assert.match(engine, /launchQueuePassBrowser/);
assert.match(engine, /mode: 'Queue Runner'/);
assert.match(engine, /message\.id && message\.item\.length/);
assert.doesNotMatch(engine, /flushCostcoStarts[\s\S]{0,800}profileId && message\.accountId/);
assert.match(engine, /openBrowserOnPass !== false/);
assert.match(engine, /QUEUE_PASS_PROXY/);
assert.match(electron, /ipcMain\.on\('startCostco'/);
assert.match(electron, /moduleBlocked\('costco'\)/);
assert.match(page, /startCostco/);
assert.match(page, /Product \/ waiting-room URL/);
assert.match(page, /<VirtualList/);
assert.match(page, /connectEngineLog\('costco'\)/);
assert.match(page, /openBrowserOnPass/);
assert.match(routes, /taskTypes\.costco/);
assert.match(sidebar, /taskType: 'costco'/);
assert.match(modules, /taskType: 'costco'/);
assert.match(access, /key: 'costco'/);
assert.match(store, /openBrowserOnPass: true/);
assert.match(store, /costcoDone/);
assert.match(dataManager, /function getCostcoTasks/);
assert.match(dataManager, /costco-tasks\.json/);
assert.match(queueTask, /SendQueuePass/);
assert.doesNotMatch(queueTask, /ExtraFeilds:[\s\S]{0,180}"cookies"/);
assert.match(browser, /channel: 'chromium'/);
assert.match(browser, /QUEUE_PASS_PROXY/);
assert.doesNotMatch(browser, /queue-pass browser opened \$\{url\}/);

console.log(JSON.stringify({
  ok: true,
  site: 'Costco',
  licenseGated: true,
  queuePassBrowser: true,
}, null, 2));
