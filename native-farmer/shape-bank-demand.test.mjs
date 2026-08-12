#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createBankDemand } from './shape-bank-demand.mjs';
import { createHarvestCoordinator } from './shape-harvest-coordinator.mjs';

const legacyUncapped = createBankDemand({ legacyPool: 0 });
assert.deepEqual(legacyUncapped.snapshot().targets, { login: null, atc: null });
assert.equal(legacyUncapped.accepts('atc', 1000), true);

const legacyCapped = createBankDemand({ legacyPool: 5 });
assert.deepEqual(legacyCapped.snapshot().targets, { login: 5, atc: 5 });
assert.equal(legacyCapped.accepts('login', 5), false);

const dynamic = createBankDemand({ legacyPool: 50 });
assert.deepEqual(dynamic.apply({
  activeTasks: 7, standbyTasks: 12, atcPerTask: 3, basis: 'active',
}), {
  demand: {
    mode: 'per-task', basis: 'active', activeTasks: 7, standbyTasks: 12,
    effectiveTasks: 7, atcPerTask: 3, targets: { login: 7, atc: 21 },
  },
  targets: { login: 7, atc: 21 },
});
assert.equal(dynamic.accepts('atc', 20), true);
assert.equal(dynamic.accepts('atc', 21), false);
assert.equal(dynamic.accepts('atc', 200, true), true, 'live waiters bypass the prewarm target');

const aboveLegacyCap = dynamic.apply({
  activeTasks: 2, standbyTasks: 0, atcPerTask: 75, basis: 'active',
});
assert.deepEqual(aboveLegacyCap.targets, { login: 2, atc: 150 },
  'positive per-task demand is no longer capped at 20');
const uncapped = dynamic.apply({ activeTasks: 2, standbyTasks: 0, atcPerTask: 0, basis: 'active' });
assert.deepEqual(uncapped.targets, { login: 2, atc: null }, 'zero means uncapped ATC prewarm');
assert.equal(dynamic.accepts('atc', 50000), true, 'uncapped dynamic ATC demand accepts every depth');
assert.deepEqual(dynamic.apply({
  activeTasks: 2, standbyTasks: 0, atcPerTask: 0, basis: 'paused',
}).targets, { login: 0, atc: 0 }, 'pausing still overrides the uncapped setting');

const standby = dynamic.apply({ activeTasks: 0, standbyTasks: 9, atcPerTask: 4 });
assert.equal(standby.demand.basis, 'standby', 'omitted basis selects standby while tasks are armed');
assert.deepEqual(standby.targets,
  { login: 9, atc: 36 }, 'standby demand can prewarm configured tasks before they start');
assert.deepEqual(dynamic.apply({ activeTasks: 8, standbyTasks: 9, atcPerTask: 4, basis: 'paused' }).targets,
  { login: 0, atc: 0 }, 'paused basis explicitly pauses both lanes');
assert.deepEqual(dynamic.apply({ activeTasks: 50000, standbyTasks: 0, atcPerTask: 50000 }).targets,
  { login: 1000, atc: 10000 }, 'untrusted demand is clamped to safe bounds');
assert.throws(() => dynamic.apply({ activeTasks: 'nope', atcPerTask: 3 }), /activeTasks/);
assert.throws(() => dynamic.apply({ activeTasks: 1 }), /atcPerTask/);
assert.throws(() => dynamic.apply({ activeTasks: 1, atcPerTask: -1 }), /non-negative/,
  'only an explicit zero, never a negative value, may enable uncapped demand');
assert.throws(() => dynamic.apply({ activeTasks: 1, atcPerTask: 3, basis: 'sleeping' }), /basis/);

const coordinator = createHarvestCoordinator({
  allowedTypes: ['login', 'atc'], targetPools: { login: 2, atc: 6 },
  continuousLogin: true, sessionReady: true,
});
assert.equal(coordinator.reserve({ pools: { login: 2, atc: 6 } }), null,
  'separate full targets park prewarm workers');
coordinator.setTargets({ login: 0, atc: 0 });
assert.equal(coordinator.reserve({ pools: { login: 0, atc: 0 } }), null,
  'dynamic zero pauses prewarm');
const waiterReservation = coordinator.reserve({
  pools: { login: 0, atc: 0 }, waiters: { login: 0, atc: 1 },
});
assert.equal(waiterReservation.type, 'atc', 'waiter demand still launches a paused lane');
assert.equal(coordinator.reserve({
  pools: { login: 0, atc: 0 }, waiters: { login: 0, atc: 1 },
}), null, 'one live waiter launches at most one paused-lane harvest');
waiterReservation.release({ success: true });
coordinator.setTargets({ login: 1, atc: 4 });
const loginReservation = coordinator.reserve({ pools: { login: 0, atc: 4 } });
assert.equal(loginReservation.type, 'login', 'login and ATC targets update independently');
loginReservation.release({ success: true });
assert.deepEqual(coordinator.state().targets, { login: 1, atc: 4 });

const specializedCoordinator = createHarvestCoordinator({
  allowedTypes: ['atc'], targetPools: { login: 0, atc: 0 }, continuousLogin: false,
});
const recoveryReservation = specializedCoordinator.reserve({
  pools: { login: 0, atc: 0 }, waiters: { login: 1, atc: 0 },
});
assert.equal(recoveryReservation.type, 'login',
  'a live waiter must override producer specialization and a paused prewarm target');
recoveryReservation.release();

const farmerSource = fs.readFileSync(new URL('./shape-farmer.mjs', import.meta.url), 'utf8');
assert.match(farmerSource, /status\.demand\?\.mode !== 'per-task'/,
  'producers must not adopt a legacy broker cap before authoritative demand arrives');
assert.match(farmerSource, /error \|\| !status \|\| !status\.pools[\s\S]{0,180}pauseUntilAuthoritativeDemand\(\)/,
  'producers must fail closed when broker status becomes unavailable');

console.log('Dynamic Shape bank demand and mutable coordinator targets passed');
