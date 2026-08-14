#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  detectShapeBrowsers,
  installedBrowserExecutablePaths,
  normalizeShapeBrowserSelection,
  shapeBrowserCandidates,
} from '../native-farmer/shape-browser-pool.mjs';
import {
  classifyHarvestFailure,
  createHarvestHealth,
  pickWeightedSource,
} from '../native-farmer/shape-harvest-health.mjs';

const unavailable = [];
const closed = [];
const installed = {
  brave: '/installed/brave',
  vivaldi: '/installed/vivaldi',
  yandex: '/installed/yandex',
  opera: '/installed/opera',
};

const detected = await detectShapeBrowsers(async (options) => {
  const key = options.executablePath || options.channel;
  const probe = {
    connected: true,
    isConnected() { return this.connected; },
    async newContext() {
      return {
        async newPage() {
          if (options.executablePath === '/installed/vivaldi') {
            probe.connected = false;
            throw new Error('Target page, context or browser has been closed');
          }
          return { evaluate: async () => 'complete' };
        },
        async close() {},
      };
    },
    async close() { closed.push(key); },
  };
  return probe;
}, (browser, error) => unavailable.push({ key: browser.key, message: error.message }), 'auto', name => installed[name] || '');

assert.deepEqual(detected.map(browser => browser.key), [
  'chrome', 'msedge', 'brave', 'yandex', 'opera', 'chromium',
]);
assert.deepEqual(unavailable.map(item => item.key), ['vivaldi']);
assert.match(unavailable[0].message, /browser has been closed/i);
assert.equal(closed.length, 7, 'every probe is closed, including a crash-on-page browser');

assert.equal(normalizeShapeBrowserSelection('Opera'), 'opera');
assert.equal(normalizeShapeBrowserSelection('chrome'), 'chrome');
assert.equal(normalizeShapeBrowserSelection('unknown-browser'), 'auto');
assert.deepEqual(shapeBrowserCandidates('opera').map(browser => browser.key), ['opera']);
assert.deepEqual(installedBrowserExecutablePaths('opera', {
  platform: 'darwin', homeDir: '/Users/test',
}), [
  '/Applications/Opera.app/Contents/MacOS/Opera',
  '/Users/test/Applications/Opera.app/Contents/MacOS/Opera',
]);
assert.ok(installedBrowserExecutablePaths('opera', {
  platform: 'win32', homeDir: 'C:\\Users\\test', env: { LOCALAPPDATA: 'C:\\Local' },
}).includes('C:\\Local\\Programs\\Opera\\opera.exe'));

const tunnelCategory = classifyHarvestFailure([
  'chrome-error://chromewebdata/',
  'This site can\u2019t be reached',
  'ERR_TUNNEL_CONNECTION_FAILED',
].join(' '));
assert.equal(tunnelCategory, 'proxy');

const health = createHarvestHealth({ now: () => 1_000, random: () => 0.5 });
const outcome = health.recordFailure({ type: 'atc', category: tunnelCategory, proxyKey: 'redacted-route' });
assert.equal(outcome.scope, 'proxy');
assert.equal(outcome.proxyQuarantineMs, 60_000);
assert.equal(health.snapshot().quarantinedProxies, 1);

assert.equal(pickWeightedSource(['Resi', 'ISP'], { ISP: { ok: 8, fail: 0 } }, { random: () => 0.99 }), 'ISP');
assert.equal(pickWeightedSource(['Resi', 'ISP'], { ISP: { ok: 8, fail: 0 } }, { random: () => 0.01 }), 'Resi');

console.log('Target farmer runtime health smoke test passed');
