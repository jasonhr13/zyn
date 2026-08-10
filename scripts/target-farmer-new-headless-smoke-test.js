#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const project = path.resolve(__dirname, '..');
execFileSync(process.execPath, [path.join(__dirname, 'verify-native-farmer-upstream.js')], { stdio: 'inherit' });

const farmer = fs.readFileSync(path.join(project, 'native-farmer', 'shape-farmer.mjs'), 'utf8');
const browserPool = fs.readFileSync(path.join(project, 'native-farmer', 'shape-browser-pool.mjs'), 'utf8');
const browserOptimizer = fs.readFileSync(path.join(project, 'native-farmer', 'shape-browser-optimizer.mjs'), 'utf8');
const runtimePaths = fs.readFileSync(path.join(project, 'native-farmer', 'runtime-paths.js'), 'utf8');

for (const key of ['chrome', 'msedge', 'brave', 'vivaldi', 'yandex', 'opera', 'chromium']) {
  assert.match(browserPool, new RegExp(`key: '${key}'`), `native browser pool omits ${key}`);
}
assert.match(browserPool, /channel: 'chromium'/, 'Chromium-family launches lack an explicit full-browser channel');
assert.match(browserPool, /Brave Browser\.app\/Contents\/MacOS\/Brave Browser/);
assert.match(browserPool, /Vivaldi\.app/);
assert.match(browserPool, /Yandex\.app/);
assert.match(browserPool, /Opera\.app/);
assert.match(farmer, /normalizeShapeBrowserSelection\(argOf\('browsers', 'auto'\)\)/,
  'explicit installed-browser selections still collapse to the automatic pool');
assert.match(farmer, /const HEADLESS = argOf\('headless', 'false'\) === 'true'/);
assert.match(farmer, /browserMode = HEADLESS \? 'new-headless'/);
assert.match(farmer, /activeWorkers: scale\.activeWorkers/);
assert.match(farmer, /configuredWorkers: startedWorkerCount/);
assert.match(farmer, /farmerBrowsers = detected\.map/);
assert.match(farmer, /browserOptimizer\.acquire\(id, firstSession \? initialBrowser\.key : ''\)/,
  'new browser sessions do not use adaptive browser selection');
assert.match(farmer, /browserOptimizer\.recordOutcome\(/,
  'browser harvest outcomes do not train adaptive selection');
assert.match(farmer, /browserPerformance: browserOptimizer \? browserOptimizer\.snapshot\(\) : null/,
  'managed harvester status omits per-browser performance telemetry');
assert.match(browserOptimizer, /policy: candidates\.length > 1 \? 'adaptive-efficiency' : 'fixed-browser'/);
assert.match(browserOptimizer, /maximumActivePerBrowser: shareCeiling/,
  'adaptive scheduling omits its browser-diversity ceiling');
assert.match(runtimePaths, /ELECTRON_RUN_AS_NODE = '1'/);
assert.match(runtimePaths, /return process\.execPath/);

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zyn-native-engine-'));
process.on('exit', () => { try { fs.rmSync(directory, { recursive: true, force: true }); } catch {} });
for (const filename of ['target-engine.js', 'walmart-engine.js', 'plain-log.js']) {
  fs.copyFileSync(path.join(project, 'extracted', 'asar', 'public', 'helpers', filename), path.join(directory, filename));
}
fs.copyFileSync(path.join(project, 'native-farmer', 'runtime-paths.js'), path.join(directory, 'runtime-paths.js'));
execFileSync(process.execPath, [path.join(__dirname, 'patch-profile-imap-engines.js'), directory], { stdio: 'inherit' });
const engine = fs.readFileSync(path.join(directory, 'target-engine.js'), 'utf8');
assert.match(engine, /'--headless=true'/, 'Zyn does not request New Headless');
assert.doesNotMatch(engine, /'--headless=false'/);
assert.match(engine, /const findNodeExe = nodeExecutable/);
assert.match(engine, /nodeEnvironment\(\{ FORCE_COLOR/);
assert.match(engine, /`--browsers=auto`/);

console.log(JSON.stringify({
  ok: true,
  source: 'pinned native farmer @423d132',
  runtime: 'native-electron-node',
  displayMode: 'new-headless',
  browserScheduling: 'adaptive-efficiency',
  browsers: ['Chrome', 'Edge', 'Brave', 'Vivaldi', 'Yandex', 'Opera', 'Chromium'],
}, null, 2));
