'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { displayEngineVersion, engineInfoFrom } = require('../runtime-app/public/helpers/engine-version');

assert.equal(displayEngineVersion('1.2.5-76842f3f8e3b'), '1.2.5');
assert.equal(displayEngineVersion('1.2.5'), '1.2.5');
assert.equal(displayEngineVersion('bundled'), 'bundled');
assert.equal(displayEngineVersion(''), '');

const live = engineInfoFrom({
  runningRaw: '1.2.5-76842f3f8e3b',
  installedRaw: '1.2.5-76842f3f8e3b',
  engineRunning: true,
});
assert.equal(live.running, '1.2.5');
assert.equal(live.installed, '1.2.5');
assert.equal(live.pendingRestart, false);

const pending = engineInfoFrom({
  runningRaw: '1.2.4-61eb06dc9dcd',
  installedRaw: '1.2.5-76842f3f8e3b',
  engineRunning: true,
});
assert.equal(pending.running, '1.2.4');
assert.equal(pending.installed, '1.2.5');
assert.equal(pending.pendingRestart, true);

const idle = engineInfoFrom({
  runningRaw: '1.2.4-61eb06dc9dcd',
  installedRaw: '1.2.5-76842f3f8e3b',
  engineRunning: false,
});
assert.equal(idle.running, '1.2.5');
assert.equal(idle.pendingRestart, false);

const root = path.join(__dirname, '..');
const sidebar = fs.readFileSync(path.join(root, 'frontend/src/components/sidebar.js'), 'utf8');
assert.match(sidebar, /App v\$\{APP_VERSION\}/);
assert.match(sidebar, /Engine v/);
assert.match(sidebar, /getEngineInfo/);

const settings = fs.readFileSync(path.join(root, 'frontend/src/components/pages/settings.js'), 'utf8');
assert.match(settings, /App <strong/);
assert.match(settings, /Engine <strong/);
assert.match(settings, /getEngineInfo/);

const electron = fs.readFileSync(path.join(root, 'runtime-app/public/electron.js'), 'utf8');
assert.match(electron, /getEngineInfo/);

const bootstrap = fs.readFileSync(path.join(root, 'launcher/bootstrap.js'), 'utf8');
assert.match(bootstrap, /getEngineInfo/);
assert.match(bootstrap, /withEngineInfo/);

const engine = fs.readFileSync(path.join(root, 'runtime-app/public/helpers/target-engine.js'), 'utf8');
assert.match(engine, /function getEngineInfo/);
assert.match(engine, /runningEngineVersion = engineVersion/);

console.log('engine version smoke test passed');
