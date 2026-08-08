#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const project = path.resolve(__dirname, '..');
const sourceFile = path.join(project, 'extracted', 'app', 'resources', 'bot', 'shape-farmer.mjs');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hope-new-headless-'));
const farmerFile = path.join(directory, 'shape-farmer.mjs');
fs.copyFileSync(sourceFile, farmerFile);

execFileSync(process.execPath, [path.join(__dirname, 'patch-target-farmer-new-headless.js'), farmerFile], { stdio: 'inherit' });
const farmer = fs.readFileSync(farmerFile, 'utf8');
assert.match(farmer, /const HEADLESS = argOf\('headless', 'true'\) === 'true'/);
assert.match(farmer, /\{ key: 'chromium', channel: 'chromium', realBrand: false \}/);
assert.match(farmer, /display: \$\{HEADLESS \? 'new-headless'/);
assert.doesNotMatch(farmer, /\{ key: 'chromium', channel: null, realBrand: false \}/);
assert.doesNotMatch(farmer, /BROWSER_CANDIDATES\[2\]/);
execFileSync(process.execPath, ['--check', farmerFile]);

const repeat = spawnSync(process.execPath, [path.join(__dirname, 'patch-target-farmer-new-headless.js'), farmerFile], { encoding: 'utf8' });
assert.notEqual(repeat.status, 0, 'hash gate accepted an already-modified farmer');
assert.match(`${repeat.stdout}${repeat.stderr}`, /does not match the reviewed source/);

const resources = path.join(project, 'extracted', 'app', 'resources');
const playwrightPackage = JSON.parse(fs.readFileSync(path.join(resources, 'node_modules', 'playwright', 'package.json'), 'utf8'));
const browsers = JSON.parse(fs.readFileSync(path.join(resources, 'node_modules', 'playwright-core', 'browsers.json'), 'utf8'));
const chromium = browsers.browsers.find((browser) => browser.name === 'chromium');
const coreBundle = fs.readFileSync(path.join(resources, 'node_modules', 'playwright-core', 'lib', 'coreBundle.js'), 'utf8');
assert.ok(chromium, 'bundled regular Chromium descriptor is missing');
assert.ok(fs.existsSync(path.join(resources, 'vendor', 'ms-playwright', `chromium-${chromium.revision}`, 'chrome-win64', 'chrome.exe')));
assert.match(coreBundle, /options\.channel && registry\.isChromiumAlias\(options\.channel\)[\s\S]{0,80}return "chromium"/);
assert.match(coreBundle, /return options\.headless \? "chromium-headless-shell" : "chromium"/);

console.log(JSON.stringify({
  ok: true,
  hashGated: true,
  displayMode: 'new-headless',
  playwright: playwrightPackage.version,
  chromium: chromium.browserVersion,
  executableProduct: 'chromium',
}, null, 2));
