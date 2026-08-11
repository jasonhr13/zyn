import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  sameTargetBank,
  targetBankMetrics,
  targetBankPresentation,
} from '../frontend/src/components/target-bank-metrics.mjs';

assert.equal(targetBankMetrics(null).online, false);

const bank = {
  login: 2,
  atc: 7,
  proxies: 1200,
  lastBankedAt: 1700000000000,
  inFlight: { login: 0, atc: 1 },
  activity: {
    startedAt: 1234,
    produced: { login: 2, atc: 9 },
    delivered: { login: 0, atc: 2 },
    waiting: { login: 0, atc: 1 },
  },
  health: {
    workerState: 'running',
    activeWorkers: 3,
    configuredWorkers: 4,
    failures: { total: 3, byCategory: { timeout: 2, proxy: 1 } },
    quarantinedProxies: 2,
    cooldowns: { atc: { remainingMs: 8200 } },
    scaling: {
      policy: 'fixed', desiredWorkers: 4, hardLimit: 4,
      recentSamples: 10, recentErrors: 3, recentErrorRate: 0.3,
    },
  },
};

const metrics = targetBankMetrics(bank);
assert.deepEqual({
  login: metrics.login,
  atc: metrics.atc,
  proxies: metrics.proxies,
  workers: `${metrics.activeWorkers}/${metrics.workerLimit}`,
  farmed: metrics.farmedAtc,
  delivered: metrics.deliveredAtc,
  inFlight: metrics.inFlightAtc,
  recentErrors: `${metrics.recentErrors}/${metrics.recentSamples}`,
  cooling: metrics.quarantinedProxies,
  leadingFailure: metrics.leadingFailure.label,
  cooldown: metrics.atcCooldownSec,
  lastBankedAt: metrics.lastBankedAt,
}, {
  login: 2,
  atc: 7,
  proxies: 1200,
  workers: '3/4',
  farmed: 9,
  delivered: 2,
  inFlight: 1,
  recentErrors: '3/10',
  cooling: 2,
  leadingFailure: 'Timeout',
  cooldown: 9,
  lastBankedAt: 1700000000000,
});
assert.equal(sameTargetBank(bank, structuredClone(bank)), true);
assert.equal(metrics.workerState, 'running');
const changed = structuredClone(bank);
changed.atc += 1;
assert.equal(sameTargetBank(bank, changed), false);

const stoppedConfiguration = [{ id: 'target-main', enabled: false }];
const staleRuntimeBank = {
  login: 0,
  atc: 0,
  harvesters: [{ id: 'target-main', activeWorkers: 5 }],
};
const stopped = targetBankPresentation(staleRuntimeBank, stoppedConfiguration, { now: 1800000000000 });
assert.equal(stopped.state, 'stopped');
assert.equal(stopped.label, 'Harvesters stopped');
assert.equal(stopped.activeWorkers, 0, 'stopped configuration must override a stale runtime worker report');
assert.equal(stopped.brokerLabel, 'Broker online');
assert.match(stopped.description, /All harvesters are stopped/);

const harvesting = targetBankPresentation(staleRuntimeBank, [{ id: 'target-main', enabled: true }], { now: 1800000000000 });
assert.equal(harvesting.state, 'working');
assert.equal(harvesting.label, 'Harvesting');
assert.equal(harvesting.activeWorkers, 5);

const readyWhileStopped = targetBankPresentation(
  { ...staleRuntimeBank, login: 2, atc: 3 },
  stoppedConfiguration,
  { now: 1800000000000 },
);
assert.equal(readyWhileStopped.state, 'ready');
assert.equal(readyWhileStopped.label, 'Cookies ready');
assert.match(readyWhileStopped.description, /Harvesters are stopped/);

const scheduled = targetBankPresentation(staleRuntimeBank, [{
  id: 'later', enabled: true, startSchedule: '2030-01-01T00:00:00.000Z',
}], { now: Date.parse('2029-01-01T00:00:00.000Z') });
assert.equal(scheduled.state, 'scheduled');
assert.equal(scheduled.label, 'Waiting for schedule');

// The recovered broker's compact payload remains supported while the renderer also accepts the
// richer upstream health payload above.
const compact = targetBankMetrics({ login: 5, atc: 8, proxies: 9 });
assert.deepEqual({
  online: compact.online,
  login: compact.login,
  atc: compact.atc,
  proxies: compact.proxies,
  activeWorkers: compact.activeWorkers,
  workerLimit: compact.workerLimit,
}, {
  online: true,
  login: 5,
  atc: 8,
  proxies: 9,
  activeWorkers: 0,
  workerLimit: 0,
});

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const taskGroups = fs.readFileSync(path.join(root, 'frontend/src/components/pages/task-groups.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'frontend/src/App.css'), 'utf8');
assert.match(taskGroups, /ipcRenderer\.invoke\('targetCookieBank'\)/);
assert.match(taskGroups, /<small>Login<\/small>/);
assert.match(taskGroups, /<small>ATC<\/small>/);
assert.match(taskGroups, /<small>Shared Cookie Bank<\/small>/);
assert.match(taskGroups, /presentation\.brokerLabel/);
assert.match(taskGroups, /<span>Per-type limit<\/span>/);
assert.doesNotMatch(taskGroups, /workerDescription/);
assert.doesNotMatch(taskGroups, /<small>Run output<\/small>/);
assert.doesNotMatch(taskGroups, /<small>Cooling routes<\/small>/);
assert.doesNotMatch(taskGroups, /<small>Top failure<\/small>/);
assert.doesNotMatch(taskGroups, /target-global-harvester-summary/);
assert.match(taskGroups, /aria-label="Target cookie bank maximum size"/);
assert.match(taskGroups, /targetBankPresentation\(bank, this\.state\.harvesters/);
assert.match(taskGroups, /renderHarvesterDrawer\(\)/);
assert.match(taskGroups, /className=\{`target-harvester-rail/);
assert.match(taskGroups, /id="target-harvester-drawer"/);
assert.match(taskGroups, /aria-controls="target-harvester-drawer"/);
assert.match(taskGroups, /Proxy bandwidth/);
assert.match(taskGroups, /Total proxy data/);
assert.match(taskGroups, /heavy assets blocked/);
assert.match(taskGroups, /Per cookie/);
assert.match(taskGroups, /HARVESTER_DRAWER_STORAGE_KEY/);
assert.doesNotMatch(taskGroups, /renderHarvesterManager\(\)/);
assert.doesNotMatch(taskGroups, /workerLimit \|\| 'Auto'/);
assert.doesNotMatch(taskGroups, /R2 groups existing Target controls only/);
assert.match(styles, /\.cookie-bank-prominent \{ display: grid; grid-template-columns:/,
  'prominent bank header must keep its controls on one grid row');
assert.match(styles, /\.cookie-bank-prominent \.cookie-bank-copy em \{[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/,
  'long bank status must truncate instead of wrapping the controls');
assert.match(styles, /\.cookie-bank-stopped/);
assert.match(styles, /\.cookie-bank-broker/);
assert.doesNotMatch(styles, /\.cookie-bank-health/);
assert.match(styles, /\.target-harvester-rail \{/);
assert.match(styles, /\.target-harvester-drawer \{/);
assert.match(styles, /\.target-harvester-drawer-content \{[^}]*overflow-y: auto;/);
assert.match(styles, /\.target-harvester-bandwidth-summary \{/);
assert.match(styles, /\.target-harvester-bandwidth \{ grid-area: bandwidth; \}/);

console.log('Target cookie-bank metrics smoke test passed');
