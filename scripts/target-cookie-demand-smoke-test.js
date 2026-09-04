#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(__dirname, 'target-cookie-demand.fragment.js'), 'utf8');
const settings = {};
const requests = [];
let ensured = 0;
const stoppedProducers = [];

const http = {
  request(options, onResponse) {
    const record = { options, body: '' };
    requests.push(record);
    const handlers = {};
    return {
      on(event, handler) { handlers[event] = handler; return this; },
      end(body) {
        record.body = String(body || '');
        const responseHandlers = {};
        const response = {
          statusCode: 200,
          resume() {},
          on(event, handler) { responseHandlers[event] = handler; return this; },
        };
        onResponse(response);
        responseHandlers.end?.();
      },
      destroy(error) { handlers.error?.(error); },
    };
  },
};

const context = {
  Buffer,
  console,
  http,
  SHAPE_PORT: 4727,
  SHAPE_TOKEN: 'smoke-token',
  quitting: false,
  farmerProc: null,
  harvesterProcs: new Map(),
  stopHarvesterProducer: id => {
    stoppedProducers.push(id);
    context.harvesterProcs.delete(id);
  },
  dm: {
    getSettings: () => settings,
    getTargetTasks: () => ({ tasks: [{ id: 'legacy-a' }, { id: 'legacy-b' }] }),
  },
  ensureHarvesterBroker: () => { ensured += 1; },
  setTimeout,
  clearTimeout,
};
vm.createContext(context);
vm.runInContext(`${source}\n;globalThis.__demandApi = {
  targetCookieDemand, setTargetCookieStandbyTasks, setTargetLoginDemandTasks,
  acceptTargetCookieTasks, releaseTargetCookieTask, clearTargetCookieTasks,
  syncTargetCookieBankDemand, setTargetHarvestAuthorized,
};`, context, { filename: 'target-cookie-demand.fragment.js' });
const api = context.__demandApi;

assert.deepEqual(JSON.parse(JSON.stringify(api.targetCookieDemand())), {
  mode: 'per-task', basis: 'paused', activeTasks: 0, standbyTasks: 2, effectiveTasks: 0,
  atcPerTask: 3, targets: { login: 0, atc: 0 },
});
api.setTargetCookieStandbyTasks('task-groups', 5);
assert.equal(ensured, 0, 'standby bootstrap must not start a broker before authorization');
assert.equal(requests.length, 0, 'standby bootstrap must not publish before authorization');

api.setTargetHarvestAuthorized(true);
assert.deepEqual(JSON.parse(JSON.stringify(api.targetCookieDemand())), {
  mode: 'per-task', basis: 'standby', activeTasks: 0, standbyTasks: 5, effectiveTasks: 5,
  atcPerTask: 3, targets: { login: 0, atc: 15 },
});

api.setTargetCookieStandbyTasks('task-groups', 5);
assert.equal(api.targetCookieDemand().standbyTasks, 5, 'largest standby source must win, not sum');
assert.equal(api.targetCookieDemand().targets.atc, 15);

api.acceptTargetCookieTasks([{ id: 'a' }, { id: 'a' }, { id: 'b' }]);
assert.equal(api.targetCookieDemand().basis, 'active');
assert.equal(api.targetCookieDemand().activeTasks, 2, 'duplicate starts must not inflate demand');
assert.equal(api.targetCookieDemand().targets.atc, 6, 'active tasks override standby while a run exists');
assert.equal(api.targetCookieDemand().targets.login, 0, 'ATC demand must not start login harvesting');
api.setTargetLoginDemandTasks(['a', 'b', 'b']);
assert.equal(api.targetCookieDemand().targets.login, 2, 'login demand follows tasks that need a sign-in');
api.setTargetLoginDemandTasks([]);
assert.equal(api.targetCookieDemand().targets.login, 0, 'login demand must drop when sign-in waits end');

settings.targetAtcCookiesPerTask = '4';
api.syncTargetCookieBankDemand();
assert.equal(api.targetCookieDemand().targets.atc, 8, 'live settings changes must alter demand');

settings.targetAtcCookiesPerTask = '75';
api.syncTargetCookieBankDemand();
assert.equal(api.targetCookieDemand().atcPerTask, 75, 'values above the retired 20-cookie cap must persist');
assert.equal(api.targetCookieDemand().targets.atc, 150, 'values above 20 must scale live task demand');

settings.targetAtcCookiesPerTask = '0';
api.syncTargetCookieBankDemand();
assert.equal(api.targetCookieDemand().atcPerTask, 0, 'zero must remain an explicit configured value');
assert.equal(api.targetCookieDemand().targets.atc, null, 'zero must publish uncapped ATC demand');

settings.targetAtcCookiesPerTask = '4';
api.syncTargetCookieBankDemand();

api.releaseTargetCookieTask('missing');
assert.equal(api.targetCookieDemand().activeTasks, 2, 'unknown stops must be a no-op');
api.releaseTargetCookieTask('a');
assert.equal(api.targetCookieDemand().targets.atc, 4);
api.clearTargetCookieTasks();
assert.equal(api.targetCookieDemand().basis, 'standby');
assert.equal(api.targetCookieDemand().targets.atc, 20, 'idle mode must prefill for the largest saved batch');

context.farmerProc = {};
context.harvesterProcs.set('managed-atc', { proc: {} });
api.setTargetHarvestAuthorized(false);
assert.deepEqual(JSON.parse(JSON.stringify(api.targetCookieDemand().targets)), { login: 0, atc: 0 });
assert.equal(api.targetCookieDemand().basis, 'paused');
assert.deepEqual(stoppedProducers, ['managed-atc'], 'revocation must stop every managed producer');
assert.deepEqual(JSON.parse(requests.at(-1).body), {
  basis: 'paused', activeTasks: 0, standbyTasks: 5, atcPerTask: 4, loginTasks: 0,
}, 'revocation must push an explicit paused target to an existing broker');

const ensuredBeforeReauthorize = ensured;
api.setTargetHarvestAuthorized(true);
assert.ok(ensured > ensuredBeforeReauthorize, 'reauthorization must reconcile the broker and producers');
assert.equal(api.targetCookieDemand().basis, 'standby');
assert.equal(api.targetCookieDemand().targets.atc, 20);

api.setTargetCookieStandbyTasks('task-groups', 0);
assert.equal(api.targetCookieDemand().basis, 'paused',
  'an emptied Task Groups store must override the stale migrated legacy task file');
assert.equal(api.targetCookieDemand().standbyTasks, 0);
api.setTargetCookieStandbyTasks('legacy-live', 3);
assert.equal(api.targetCookieDemand().basis, 'standby',
  'an intentional legacy workspace save must restore pre-run standby demand');
assert.equal(api.targetCookieDemand().targets.atc, 12);
api.setTargetCookieStandbyTasks('legacy-live', 0);
api.setTargetCookieStandbyTasks('legacy-migrated', 0);
assert.equal(api.targetCookieDemand().basis, 'paused');
assert.deepEqual(JSON.parse(JSON.stringify(api.targetCookieDemand().targets)), { login: 0, atc: 0 });

assert.ok(ensured > 0, 'demand changes must reconcile the broker');
assert.ok(requests.length > 0, 'demand was never published');
const last = requests.at(-1);
assert.equal(last.options.path, '/demand');
assert.equal(last.options.headers['x-zyn-token'], 'smoke-token');
assert.deepEqual(JSON.parse(last.body), { basis: 'paused', activeTasks: 0, standbyTasks: 0, atcPerTask: 4, loginTasks: 0 });
assert.doesNotMatch(last.body, /legacy-a|legacy-b|"a"|"b"/, 'task ids must never leave the bridge');

console.log('Target dynamic cookie demand transitions and authenticated publication passed');
