#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const project = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(project, relative), 'utf8');
const helper = require(path.join(project, 'runtime-app/public/helpers/target-login-harvester.js'));
const ui = read('frontend/src/components/pages/task-groups.js');
const engine = read('runtime-app/public/helpers/target-engine.js');
const configFragment = read('scripts/target-multi-harvester-config.fragment.js');
const demandFragment = read('scripts/target-cookie-demand.fragment.js');
const bootstrap = read('launcher/bootstrap.js');
const styles = read('frontend/src/App.css');

assert.equal(helper.LOGIN_HARVESTER_ID, 'zyn-login');
assert.deepEqual(helper.normalizeTargetLoginHarvester({}), {
  proxyListName: '',
  cookieTtlSec: 600,
  intervalDelaySec: 10,
  loadsPerBrowser: 3,
});
assert.equal(helper.normalizeTargetLoginHarvester({ cookieTtlSec: 12 }).cookieTtlSec, 30);
assert.equal(helper.normalizeTargetLoginHarvester({ loadsPerBrowser: 99 }).loadsPerBrowser, 10);

const migrated = helper.readTargetLoginHarvesterSettings({
  targetHarvesters: [{
    type: 'login',
    proxyListName: 'resi',
    cookieTtlSec: 120,
    intervalDelaySec: 4,
    loadsPerBrowser: 2,
  }],
});
assert.deepEqual(migrated, {
  proxyListName: 'resi',
  cookieTtlSec: 120,
  intervalDelaySec: 4,
  loadsPerBrowser: 2,
});
assert.equal(helper.readTargetLoginHarvesterSettings({
  targetLoginHarvester: { proxyListName: 'dedicated' },
  targetHarvesters: [{ type: 'login', proxyListName: 'old' }],
}).proxyListName, 'dedicated');

const config = helper.buildTargetLoginHarvesterConfig({
  targetLoginHarvester: { proxyListName: 'group:resi', cookieTtlSec: 90 },
}, true);
assert.equal(config.id, 'zyn-login');
assert.equal(config.name, 'Login');
assert.equal(config.type, 'login');
assert.equal(config.engine, 'playwright');
assert.equal(config.browser, 'auto');
assert.equal(config.workers, 1);
assert.equal(config.startSchedule, '');
assert.equal(config.enabled, true);
assert.equal(config.proxyListName, 'group:resi');
assert.equal(config.cookieTtlSec, 90);

assert.equal(helper.loginStatusNeedsHarvester('Waiting For Shape'), true);
assert.equal(helper.loginStatusNeedsHarvester('Requesting login code'), true);
assert.equal(helper.loginStatusNeedsHarvester('Waiting For Restock'), false);
assert.equal(helper.loginStatusClearsHarvester('Waiting For Restock'), true);
assert.equal(helper.loginStatusClearsHarvester('Adding To Cart'), true);
assert.equal(helper.loginStatusClearsHarvester('Getting Session'), false);

assert.equal(helper.loginHarvesterShouldRun({
  authorized: true,
  runningTaskIds: ['t1'],
  latchedTaskIds: ['t1'],
}), true);
assert.equal(helper.loginHarvesterShouldRun({
  authorized: true,
  runningTaskIds: ['t1'],
  statuses: { t1: 'Waiting For Shape' },
}), true);
assert.equal(helper.loginHarvesterShouldRun({
  authorized: true,
  runningTaskIds: ['t1'],
  otpPending: true,
}), true);
assert.equal(helper.loginHarvesterShouldRun({
  authorized: false,
  runningTaskIds: ['t1'],
  latchedTaskIds: ['t1'],
}), false);
assert.equal(helper.loginHarvesterShouldRun({
  authorized: true,
  runningTaskIds: ['t1'],
  statuses: { t1: 'Waiting For Restock' },
}), false);

assert.match(engine, /require\('\.\/target-login-harvester'\)/);
assert.match(engine, /latchLoginHarvesterForTasks/);
assert.match(engine, /reconcileLoginHarvester/);
assert.match(engine, /LOGIN_HARVESTER_ID/);
assert.match(engine, /starting login harvester — tasks need a Target sign-in/);
assert.match(engine, /stopping login harvester — no tasks waiting for sign-in/);
assert.match(engine, /id === LOGIN_HARVESTER_ID\) return false/);
assert.match(engine, /login: basis === 'paused' \? 0 : Math\.min\(TARGET_COOKIE_TASK_MAX, targetLoginDemandTaskIds\.size\)/);

assert.match(configFragment, /id === 'zyn-login'\) return false/);
assert.match(configFragment, /explicitlyStartedHarvesterIds\.has\('zyn-login'\)/);
assert.match(configFragment, /\(raw && raw\.type\) !== 'login'/);

assert.match(demandFragment, /const targetLoginDemandTaskIds = new Set\(\)/);
assert.match(demandFragment, /login: basis === 'paused' \? 0 : Math\.min\(TARGET_COOKIE_TASK_MAX, targetLoginDemandTaskIds\.size\)/);
assert.match(demandFragment, /function setTargetLoginDemandTasks/);

assert.match(ui, /LOGIN_HARVESTER_ID = 'zyn-login'/);
assert.match(ui, /renderLoginHarvesterPanel/);
assert.match(ui, /Zyn starts this automatically when a task needs to sign in/);
assert.match(ui, /value: 'atc', label: 'Target ATC'/);
assert.doesNotMatch(ui, /value: 'login', label: 'Target Login'/);
assert.match(ui, /userHarvesters = \(\) => this\.state\.harvesters\.filter/);
assert.match(ui, /persistLoginHarvester/);
assert.match(styles, /\.target-login-harvester/);

assert.match(bootstrap, /settings\.targetLoginHarvester && settings\.targetLoginHarvester\.proxyListName/);

const configSource = configFragment;
let settings = { targetHarvesters: [{ id: 'atc-1', type: 'atc', workers: 2 }] };
const sandbox = {
  dm: { getSettings: () => settings },
  setSettings: value => { settings = value; },
  result: null,
};
vm.runInNewContext(`${configSource}
setManagedHarvesterRunning({ id: 'atc-1', running: true });
result = {
  user: managedHarvesterConfigs(),
  rejectedLogin: setManagedHarvesterRunning({ id: 'zyn-login', running: true }),
};
explicitlyStartedHarvesterIds.add('zyn-login');
setSettings({
  targetHarvesters: [{ id: 'atc-1', type: 'atc', workers: 2 }],
  targetLoginHarvester: { proxyListName: 'resi', cookieTtlSec: 90, intervalDelaySec: 5, loadsPerBrowser: 2 },
});
result.withLogin = managedHarvesterConfigs();
`, sandbox);
assert.equal(sandbox.result.user.length, 1);
assert.equal(sandbox.result.user[0].id, 'atc-1');
assert.equal(sandbox.result.rejectedLogin, false);
assert.equal(sandbox.result.withLogin.length, 2);
const login = sandbox.result.withLogin.find(item => item.id === 'zyn-login');
assert.ok(login);
assert.equal(login.type, 'login');
assert.equal(login.enabled, true);
assert.equal(login.workers, 1);
assert.equal(login.engine, 'playwright');
assert.equal(login.proxyListName, 'resi');
assert.equal(login.cookieTtlSec, 90);

console.log('Target login harvester is a singleton auto-started from checkout demand');
