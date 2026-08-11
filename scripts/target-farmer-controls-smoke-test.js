#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const project = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zyn-farmer-controls-'));
process.on('exit', () => { try { fs.rmSync(directory, { recursive: true, force: true }); } catch {} });
for (const filename of ['target-engine.js', 'walmart-engine.js', 'plain-log.js']) {
  fs.copyFileSync(
    path.join(project, 'extracted', 'asar', 'public', 'helpers', filename),
    path.join(directory, filename),
  );
}
execFileSync(process.execPath, [path.join(__dirname, 'patch-profile-imap-engines.js'), directory], { stdio: 'inherit' });
execFileSync(process.execPath, ['--check', path.join(directory, 'target-engine.js')]);

const engine = fs.readFileSync(path.join(directory, 'target-engine.js'), 'utf8');
const farmer = fs.readFileSync(path.join(project, 'native-farmer', 'shape-farmer.mjs'), 'utf8');
const settings = fs.readFileSync(path.join(project, 'frontend', 'src', 'components', 'pages', 'settings.js'), 'utf8');

// The ported GitHub setting names must survive UI state, saving, and the engine boundary.
for (const key of ['targetCapturesPerLoad', 'targetLoadsPerBrowser', 'targetBlockHeavyResources']) {
  assert.match(settings, new RegExp(key), `${key} is missing from Settings`);
  assert.match(engine, new RegExp(`s\\.${key}`), `${key} is not read by the Target engine`);
}
assert.match(settings, /Cookies per page load/);
assert.match(settings, /Page loads per browser/);
assert.match(settings, /Block images, video &amp; fonts while farming/);
assert.match(settings, /targetAtcCookiesPerTask/,
  'Settings must persist the dynamic ATC reserve per task');
assert.match(settings, /Math\.max\(1, Math\.min\(maximum, parsed\)\)/, 'UI values are not bounded');
assert.match(engine, /Math\.max\(1, Math\.min\(10, configuredCaptures\)\)/);
assert.match(engine, /Math\.max\(1, Math\.min\(10, configuredLoads\)\)/);
assert.match(engine, /`--capturesPerLoad=\$\{capturesPerLoad\}`/);
assert.match(engine, /`--loadsPerBrowser=\$\{loadsPerBrowser\}`/);
assert.match(engine, /`--blockHeavyResources=\$\{blockHeavyResources\}`/);
assert.match(engine, /`--browsers=auto`/);
assert.match(engine, /`--sessionReady=\$\{hasSession\}`/);
assert.match(engine, /health: j\.health \|\| null/, 'broker worker health is not forwarded to the UI');
assert.match(engine, /lastBankedAt: latestBankedAt\(\)/, 'latest bank success is not forwarded to the UI');
assert.match(engine, /function targetCookieDemand\(\)/,
  'Target bridge is missing dynamic per-task cookie demand');
assert.match(engine, /path: '\/demand'/,
  'Target bridge does not publish dynamic demand to the broker');
assert.match(engine, /demand: j\.demand \|\| targetCookieDemand\(\)/,
  'canonical broker demand is not forwarded to the UI');
assert.equal((engine.match(/const env = nodeEnvironment\(/g) || []).length, 3,
  'broker, legacy farmer, and managed producer must all use the packaged native runtime environment');
assert.match(engine, /'--producer=true'/, 'packaged bridge is missing managed producer launch mode');
assert.match(engine, /harvesters: Array\.isArray\(j\.harvesters\)/,
  'per-harvester telemetry is not forwarded to the renderer');
assert.match(engine, /not started — proxy group/,
  'packaged harvester bridge does not fail closed when its selected proxy group disappears');
assert.match(engine, /const harvesterStartFailures = new Map\(\)/,
  'packaged harvester bridge cannot suppress repeated missing-proxy reconciliation errors');
assert.match(engine, /function isTaskRunning\(taskId\)/,
  'scheduled task groups cannot inspect per-task runtime state');
assert.match(engine, /module\.exports = \{[^}]*isTaskRunning/,
  'scheduled task running-state helper is not exported');

// The IPC bridge is applied while staging an app, so exercise that tracked patch against the
// recovered baseline instead of depending on ignored extracted-file edits.
const stagedApp = path.join(directory, 'staged-app');
fs.mkdirSync(path.join(stagedApp, 'public', 'helpers'), { recursive: true });
for (const relative of [
  'package.json',
  'public/electron.js',
  'public/index.html',
  'public/helpers/platform.js',
  'public/helpers/monitor-parse.js',
  'public/helpers/discord-monitor.js',
  'public/helpers/license-client.js',
  'public/helpers/walmart-engine.js',
  'public/helpers/target-engine.js',
]) {
  const destination = path.join(stagedApp, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.join(project, 'extracted', 'asar', relative), destination);
}
execFileSync(process.execPath, [path.join(__dirname, 'patch-zyn-runtime-brand.js'), stagedApp], { stdio: 'inherit' });
const stagedElectron = fs.readFileSync(path.join(stagedApp, 'public', 'electron.js'), 'utf8');
assert.match(stagedElectron, /ipcMain\.on\('syncTargetHarvesters'/,
  'staged main process is missing the managed harvester reconciliation channel');
execFileSync(process.execPath, ['--check', path.join(stagedApp, 'public', 'electron.js')]);

// The native farmer is the pinned GitHub implementation, not a parallel rewrite.
assert.match(farmer, /bag\.push\(picked\)/, 'one page cannot accumulate multiple signatures');
assert.match(farmer, /bag\.length >= CAPTURES_PER_LOAD/, 'multi-capture ceiling is not honored');
assert.match(farmer, /randomLoadsForBrowser\(LOADS_PER_BROWSER\)/);
assert.match(farmer, /harvestOnce\(type, proxy, selectedBrowser, browser\)/, 'worker does not reuse its browser');
assert.match(farmer, /browser\.newContext\(/, 'a reused browser does not create fresh contexts');
assert.match(farmer, /argOf\('blockHeavyResources', 'true'\)/);
assert.match(farmer, /installHeavyResourceBlock\(page/);
assert.match(farmer, /createPageBandwidthMeter\(context, page/);
assert.match(farmer, /bandwidth: bandwidthStatusPayload\(\)/,
  'per-harvester status omits browser wire-bandwidth telemetry');
assert.match(farmer, /browserPerformance: browserOptimizer \? browserOptimizer\.snapshot\(\) : null/,
  'per-harvester status omits adaptive browser performance telemetry');
assert.match(farmer, /failureCategory: category/,
  'browser optimizer cannot distinguish route failures from browser failures');
assert.match(farmer, /u\.pathname === '\/demand'/,
  'broker is missing the live dynamic-demand endpoint');
assert.match(farmer, /bankDemand\.accepts\(type, pool\[type\]\.length/,
  'broker is not enforcing its authoritative per-type target');

console.log(JSON.stringify({
  ok: true,
  defaults: { cookiesPerPage: 1, pageLoadsPerBrowser: 3, blockHeavyResources: true },
  limits: { cookiesPerPage: 10, pageLoadsPerBrowser: 10 },
  blockedTypes: ['image', 'media', 'font'],
  freshContextPerLoad: true,
  adaptiveBrowserScheduling: true,
}, null, 2));
