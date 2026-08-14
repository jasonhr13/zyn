#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  isGenerationBrowserInstalled,
  pickGenerationBrowser,
  loadGenerationBrowserPool,
} from '../bot-runtime/generation-browsers.mjs';

const candidates = [
  { key: 'chrome', label: 'Chrome', channel: 'chrome' },
  { key: 'msedge', label: 'Edge', channel: 'msedge' },
  { key: 'brave', label: 'Brave', channel: 'chromium', installedExecutable: 'brave' },
  { key: 'chromium', label: 'Chromium', channel: 'chromium' },
];

const onlyChrome = {
  existsSync: file => String(file).includes('Google Chrome'),
  findInstalled: () => '',
  allowBundled: true,
};

assert.equal(isGenerationBrowserInstalled(candidates[0], onlyChrome), true);
assert.equal(isGenerationBrowserInstalled(candidates[1], onlyChrome), false);
assert.equal(isGenerationBrowserInstalled(candidates[2], onlyChrome), false);

const pickedChrome = pickGenerationBrowser(candidates, 'auto', { ...onlyChrome, rng: () => 0 });
assert.equal(pickedChrome.key, 'chrome', 'auto preferred bundled Chromium over an installed browser');

const locked = pickGenerationBrowser(candidates, 'brave', onlyChrome);
assert.equal(locked.key, 'brave');

const noneInstalled = {
  existsSync: () => false,
  findInstalled: () => '',
  allowBundled: true,
};
assert.equal(pickGenerationBrowser(candidates, 'auto', noneInstalled).key, 'chromium');

const pool = await loadGenerationBrowserPool();
assert.ok(Array.isArray(pool.SHAPE_BROWSER_CANDIDATES));
assert.equal(typeof pool.shapeBrowserLaunchOptions, 'function');
assert.equal(typeof pool.findInstalledBrowserExecutable, 'function');

console.log(JSON.stringify({
  ok: true,
  autoPrefersInstalled: true,
  explicitSelectionHonored: true,
  bundledFallback: true,
}, null, 2));
