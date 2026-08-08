#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const project = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hope-farmer-controls-'));
for (const filename of ['target-engine.js', 'walmart-engine.js']) {
  fs.copyFileSync(
    path.join(project, 'extracted', 'asar', 'public', 'helpers', filename),
    path.join(directory, filename),
  );
}
execFileSync(process.execPath, [path.join(__dirname, 'patch-profile-imap-engines.js'), directory], { stdio: 'inherit' });

const engine = fs.readFileSync(path.join(directory, 'target-engine.js'), 'utf8');
const farmer = fs.readFileSync(path.join(project, 'extracted', 'app', 'resources', 'bot', 'shape-farmer.mjs'), 'utf8');
const settings = fs.readFileSync(path.join(project, 'frontend', 'src', 'components', 'pages', 'settings.js'), 'utf8');

// The ported GitHub setting names must survive UI state, saving, and the engine boundary.
for (const key of ['targetCapturesPerLoad', 'targetLoadsPerBrowser', 'targetBlockHeavyResources']) {
  assert.match(settings, new RegExp(key), `${key} is missing from Settings`);
  assert.match(engine, new RegExp(`s\\.${key}`), `${key} is not read by the Target engine`);
}
assert.match(settings, /Cookies per page load/);
assert.match(settings, /Page loads per browser/);
assert.match(settings, /Block images, video &amp; fonts while farming/);
assert.match(settings, /Math\.max\(1, Math\.min\(maximum, parsed\)\)/, 'UI values are not bounded');
assert.match(engine, /Math\.max\(1, Math\.min\(10, configuredCaptures\)\)/);
assert.match(engine, /Math\.max\(1, Math\.min\(10, configuredLoads\)\)/);
assert.match(engine, /`--capturesPerLoad=\$\{capturesPerLoad\}`/);
assert.match(engine, /`--loadsPerBrowser=\$\{loadsPerBrowser\}`/);
assert.match(engine, /`--blockAssets=\$\{blockHeavyResources \? 'image,media,font' : ''\}`/);

// The recovered farmer already implements the GitHub behavior; guard that implementation instead
// of replacing it with a parallel control path.
assert.match(farmer, /bag\.push\(picked\)/, 'one page cannot accumulate multiple signatures');
assert.match(farmer, /bag\.length >= CAPTURES_PER_LOAD/, 'multi-capture ceiling is not honored');
assert.match(farmer, /loadsForSession = \(\) => 1 \+ Math\.floor\(Math\.random\(\) \* LOADS_PER_BROWSER\)/);
assert.match(farmer, /harvestOnce\(type, proxy, browser, instance, stats\)/, 'worker does not reuse its browser');
assert.match(farmer, /instance\.newContext\(/, 'a reused browser does not create fresh contexts');
assert.match(farmer, /argOf\('blockAssets', 'image,media,font'\)/);
assert.match(farmer, /BLOCK_TYPES\.has\(route\.request\(\)\.resourceType\(\)\)/);

console.log(JSON.stringify({
  ok: true,
  defaults: { cookiesPerPage: 1, pageLoadsPerBrowser: 3, blockHeavyResources: true },
  limits: { cookiesPerPage: 10, pageLoadsPerBrowser: 10 },
  blockedTypes: ['image', 'media', 'font'],
  freshContextPerLoad: true,
}, null, 2));
