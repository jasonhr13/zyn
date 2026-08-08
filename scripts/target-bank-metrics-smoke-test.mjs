import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sameTargetBank, targetBankMetrics } from '../frontend/src/components/target-bank-metrics.mjs';

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
assert.match(taskGroups, /ipcRenderer\.invoke\('targetCookieBank'\)/);
assert.match(taskGroups, /<small>Login<\/small>/);
assert.match(taskGroups, /<small>ATC<\/small>/);
assert.match(taskGroups, /<small>Workers<\/small>/);
assert.match(taskGroups, /<small>Run output<\/small>/);
assert.match(taskGroups, /<small>Activity<\/small>/);
assert.match(taskGroups, /<small>Last success<\/small>/);
assert.match(taskGroups, /<small>Recent errors<\/small>/);
assert.match(taskGroups, /<small>Cooling routes<\/small>/);
assert.match(taskGroups, /<small>Top failure<\/small>/);
assert.match(taskGroups, /metrics\.leadingFailure\.label/);
assert.match(taskGroups, /metrics\.quarantinedProxies/);
assert.match(taskGroups, /aria-label="Target cookie bank maximum size"/);
assert.match(taskGroups, /state === 'starting' \? 'Starting broker'/);
assert.doesNotMatch(taskGroups, /workerLimit \|\| 'Auto'/);
assert.doesNotMatch(taskGroups, /R2 groups existing Target controls only/);

console.log('Target cookie-bank metrics smoke test passed');
