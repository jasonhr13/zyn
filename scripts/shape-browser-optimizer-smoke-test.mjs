#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createShapeBrowserOptimizer } from '../native-farmer/shape-browser-optimizer.mjs';

let timestamp = 1_000;
const browsers = [
  { key: 'chrome', label: 'Chrome', channel: 'chrome' },
  { key: 'opera', label: 'Opera', executablePath: '/Applications/Opera' },
  { key: 'chromium', label: 'Bundled Chromium', channel: 'chromium' },
];
const optimizer = createShapeBrowserOptimizer({
  browsers,
  workerCount: 10,
  minimumSamples: 3,
  now: () => timestamp++,
});

// A new pool starts evenly on its scheduler-assigned browsers before performance data exists.
for (const [workerId, browser] of browsers.entries()) {
  assert.equal(optimizer.acquire(workerId, browser.key).key, browser.key);
}
assert.deepEqual(optimizer.snapshot().browsers.map(item => item.activeWorkers).sort(), [1, 1, 1]);
for (let workerId = 0; workerId < browsers.length; workerId += 1) optimizer.release(workerId);

const record = (browserKey, { success, cookies, bytes, durationMs, failureCategory = '' }) => {
  optimizer.recordOutcome({
    browserKey,
    success,
    cookies,
    durationMs,
    failureCategory,
    bandwidth: { supported: true, totalBytes: bytes },
  });
};

for (let index = 0; index < 3; index += 1) {
  record('chrome', { success: true, cookies: 1, bytes: 1_000_000, durationMs: 20_000 });
  record('opera', { success: false, cookies: 0, bytes: 4_000_000, durationMs: 45_000, failureCategory: 'browser' });
  record('chromium', {
    success: index < 2,
    cookies: index < 2 ? 1 : 0,
    bytes: 4_000_000,
    durationMs: 30_000,
    failureCategory: index < 2 ? '' : 'target_block',
  });
}

let snapshot = optimizer.snapshot();
assert.equal(snapshot.learning, false);
assert.equal(snapshot.leader.key, 'chrome');
assert.equal(snapshot.maximumActivePerBrowser, 6);
assert.equal(snapshot.browsers.find(item => item.key === 'chrome').successRate, 1);
assert.equal(snapshot.browsers.find(item => item.key === 'opera').successRate, 0);

// Dead routes remain visible as real attempts/cost, but cannot bias the browser comparison.
const operaBeforeProxyFailure = snapshot.browsers.find(item => item.key === 'opera');
record('opera', { success: false, cookies: 0, bytes: 9_000_000, durationMs: 50_000, failureCategory: 'proxy' });
snapshot = optimizer.snapshot();
const operaAfterProxyFailure = snapshot.browsers.find(item => item.key === 'opera');
assert.equal(operaAfterProxyFailure.attempts, operaBeforeProxyFailure.attempts + 1);
assert.equal(operaAfterProxyFailure.decisionAttempts, operaBeforeProxyFailure.decisionAttempts);
assert.equal(operaAfterProxyFailure.excludedProxyFailures, 1);

// Subsequent sessions favor the measured leader while retaining a hard diversity ceiling.
for (let workerId = 0; workerId < 10; workerId += 1) optimizer.acquire(workerId);
snapshot = optimizer.snapshot();
const activeByBrowser = Object.fromEntries(snapshot.browsers.map(item => [item.key, item.activeWorkers]));
assert.ok(activeByBrowser.chrome > activeByBrowser.opera);
assert.ok(activeByBrowser.chrome <= snapshot.maximumActivePerBrowser);
assert.equal(Object.values(activeByBrowser).reduce((sum, value) => sum + value, 0), 10);

for (let workerId = 0; workerId < 10; workerId += 1) optimizer.release(workerId);
assert.equal(optimizer.snapshot().browsers.reduce((sum, item) => sum + item.activeWorkers, 0), 0);

const twoWorkerOptimizer = createShapeBrowserOptimizer({ browsers: browsers.slice(0, 2), workerCount: 2 });
twoWorkerOptimizer.acquire(0);
twoWorkerOptimizer.acquire(1);
assert.deepEqual(twoWorkerOptimizer.snapshot().browsers.map(item => item.activeWorkers).sort(), [1, 1],
  'a small multi-browser pool must retain at least one worker outside its current leader');

console.log('Shape browser optimizer smoke test passed');
