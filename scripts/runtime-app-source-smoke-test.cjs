#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const project = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(project, relative), 'utf8');

const runtimePackage = JSON.parse(read('runtime-app/package.json'));
assert.equal(runtimePackage.main, 'public/electron.js');
assert.equal(runtimePackage.productName, 'Zyn');
assert.ok(runtimePackage.dependencies['electron-updater']);
assert.ok(runtimePackage.dependencies['electron-log']);
assert.equal(runtimePackage.dependencies.react, undefined);
assert.equal(runtimePackage.dependencies['react-dom'], undefined);
assert.equal(runtimePackage.dependencies['@electron/remote'], undefined);

for (const relative of [
  'runtime-app/public/electron.js',
  'runtime-app/public/index.html',
  'runtime-app/public/helpers/data-manager.js',
  'runtime-app/public/helpers/task-handler.js',
  'runtime-app/public/helpers/target-engine.js',
  'bot-runtime/target-register.mjs',
  'bot-runtime/shared.mjs',
  'bot-runtime/pbandai-register.mjs',
  'bot-runtime/riotgames-register.mjs',
  'bot-runtime/icloud-register.mjs',
  'bot-runtime/pbandai-buyer.cjs',
]) assert.ok(fs.statSync(path.join(project, relative)).isFile(), `${relative} is tracked runtime source`);

const runtimeSources = fs.readdirSync(path.join(project, 'runtime-app/public/helpers'))
  .filter(name => name.endsWith('.js'))
  .map(name => read(`runtime-app/public/helpers/${name}`))
  .concat(read('runtime-app/public/electron.js'))
  .join('\n');
assert.doesNotMatch(runtimeSources, /https:\/\/(?:discord(?:app)?\.com)\/api\/webhooks\/\d+\//,
  'tracked runtime source must not contain a Discord webhook credential');
assert.doesNotMatch(runtimeSources, /['"][MN][A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{20,}['"]/,
  'tracked runtime source must not contain a Discord bot token');
assert.match(read('runtime-app/public/helpers/checkout-reporter.js'), /__ZYN_GLOBAL_CHECKOUT_WEBHOOK__/,
  'the checkout reporter keeps a build-time placeholder, not a credential');
assert.match(read('runtime-app/public/electron.js'), /MONITOR_BOT_TOKEN = '__ZYN_MONITOR_BOT_TOKEN__'/,
  'the monitor bot token stays a build-time placeholder, not a credential');

for (const script of ['scripts/build-zyn.sh', 'scripts/build-zyn-windows.sh']) {
  const source = read(script);
  assert.match(source, /runtime-app/);
  assert.match(source, /bot-runtime\/node_modules/);
  assert.match(source, /prepare-zyn-electron/);
  assert.doesNotMatch(source, /extracted\/asar/);
  assert.doesNotMatch(source, /Zyn-Runtime-Base/);
  assert.doesNotMatch(source, /patch-profile-imap-engines/);
  assert.doesNotMatch(source, /patch-task-handler-runtime/);
  assert.doesNotMatch(source, /patch-zyn-runtime-brand/);
}

const electronRuntime = JSON.parse(read('config/electron-runtime.json'));
assert.equal(electronRuntime.version, '43.3.0');
assert.deepEqual(Object.keys(electronRuntime.platforms).sort(), ['arm64', 'windows-x64', 'x64']);
for (const item of Object.values(electronRuntime.platforms)) {
  assert.match(item.sha256, /^[a-f0-9]{64}$/);
}

console.log('runtime app source smoke test passed');
