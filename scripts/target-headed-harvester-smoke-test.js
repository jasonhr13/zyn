#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const project = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(project, relative), 'utf8');

const ui = read('frontend/src/components/pages/task-groups.js');
const engine = read('runtime-app/public/helpers/target-engine.js');
const producer = read('scripts/target-multi-harvester-producers.fragment.js');
const config = read('scripts/target-multi-harvester-config.fragment.js');
const farmer = read('native-farmer/shape-farmer.mjs');
const harvestEngine = read('native-farmer/shape-harvester-engine.mjs');
const harvestWindow = read('native-farmer/shape-harvest-window.mjs');
const botPackage = JSON.parse(read('bot-runtime/package.json'));

assert.match(ui, /\['playwright', 'Headless'\]/);
assert.match(ui, /\['patchright', 'Headed \(experimental\)'\]/);
assert.match(ui, /Zyn opens the browser and assigns the proxy/);
assert.doesNotMatch(ui, />Playwright</);
assert.doesNotMatch(ui, />Patchright</);
assert.match(ui, /engine: 'playwright'/);
assert.match(ui, /harvesterEngineOf\(raw && raw\.engine\)/);

assert.match(config, /=== 'patchright' \? 'patchright' : 'playwright'/);
assert.match(config, /engine === 'patchright' \? \(route \? 8 : 2\)/);
assert.match(engine, /`--engine=\$\{engine\}`/);
assert.match(engine, /`--headless=\$\{headed \? 'false' : 'true'\}`/);
assert.match(engine, /`--profileRoot=\$\{profileRoot\}`/);
assert.match(producer, /`--engine=\$\{engine\}`/);
assert.match(producer, /`--headless=\$\{headed \? 'false' : 'true'\}`/);

assert.match(harvestEngine, /normalizeHarvesterEngine/);
assert.match(harvestEngine, /launchPersistentContext|workerProfileDir/);
assert.match(farmer, /launchPersistentContext/);
assert.match(farmer, /harvestSourceForEngine/);
assert.match(farmer, /concealHarvestWindow/);
assert.match(harvestWindow, /windowState: 'minimized'/);
assert.match(harvestWindow, /window-position/);
assert.equal(botPackage.dependencies.patchright, '1.59.4');

const directory = fs.mkdtempSync(path.join(require('os').tmpdir(), 'zyn-headed-harvester-'));
process.on('exit', () => { try { fs.rmSync(directory, { recursive: true, force: true }); } catch {} });
execFileSync(process.execPath, ['--check', path.join(project, 'runtime-app/public/helpers/target-engine.js')]);

console.log(JSON.stringify({
  ok: true,
  uiMode: ['Headless', 'Headed (experimental)'],
  internalEngine: ['playwright', 'patchright'],
  headedWindow: { win32: 'offscreen', darwin: 'minimized' },
  hash: crypto.createHash('sha256').update(farmer).digest('hex').slice(0, 12),
}, null, 2));
