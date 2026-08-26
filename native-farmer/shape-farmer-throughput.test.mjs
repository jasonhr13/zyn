import assert from 'node:assert/strict';
import {
  MAX_LOADS_PER_BROWSER,
  randomLoadsForBrowser,
  shapeFarmerThroughputOptions,
} from './shape-farmer-throughput.mjs';

assert.equal(shapeFarmerThroughputOptions({}).loadsPerBrowser, 3);
assert.equal(shapeFarmerThroughputOptions({ loadsPerBrowser: '10' }).loadsPerBrowser, 10);
assert.equal(shapeFarmerThroughputOptions({ loadsPerBrowser: 99 }).loadsPerBrowser, MAX_LOADS_PER_BROWSER);
assert.equal(shapeFarmerThroughputOptions({ loadsPerBrowser: 0 }).loadsPerBrowser, 1);

const seen = new Set();
for (let i = 0; i < 40; i++) {
  seen.add(randomLoadsForBrowser(10, () => i / 40));
}
assert.equal(Math.min(...seen), 1);
assert.equal(Math.max(...seen), 10);
assert.ok(seen.size > 1, 'refresh cadence must jitter under the configured ceiling');

console.log('shape-farmer-throughput bounds passed');
