#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const project = path.resolve(__dirname, '..');
const engineBuild = fs.readFileSync(path.join(project, 'scripts', 'build-native-target-engine.sh'), 'utf8');
const macBuild = fs.readFileSync(path.join(project, 'scripts', 'build-zyn.sh'), 'utf8');
const winBuild = fs.readFileSync(path.join(project, 'scripts', 'build-zyn-windows.sh'), 'utf8');
const harden = fs.readFileSync(path.join(project, 'scripts', 'harden-packaged-js.cjs'), 'utf8');

assert.match(engineBuild, /USE_GARBLE="\$\{USE_GARBLE:-1\}"/);
assert.match(engineBuild, /garble@\$\{GARBLE_VERSION\}/);
assert.match(engineBuild, /v0\.16\.0/);
assert.match(engineBuild, / -literals -tiny /);
assert.match(macBuild, /harden-packaged-js\.cjs/);
assert.match(winBuild, /harden-packaged-js\.cjs/);
assert.match(harden, /javascript-obfuscator/);
assert.match(harden, /bytenode/);
assert.match(harden, /stringArray: true/);

const { shouldObfuscate, shouldBytecode, BYTECODE_FILES } = require('./harden-packaged-js.cjs');
assert.equal(shouldObfuscate('/tmp/app/public/helpers/target-engine.js'), true);
assert.equal(shouldObfuscate('/tmp/app/node_modules/ws/index.js'), false);
assert.equal(shouldObfuscate('/tmp/app/build/static/js/main.js'), false);
assert.equal(shouldObfuscate('/tmp/app/feature-flags.js'), false);
assert.equal(shouldObfuscate('/tmp/bot/shape-farmer.mjs'), false);
assert.equal(shouldBytecode('/tmp/app/public/helpers/target-engine.js'), true);
assert.ok(BYTECODE_FILES.has('license-authority.js'));

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'zyn-harden-'));
const sample = path.join(workspace, 'secret-helper.js');
fs.writeFileSync(sample, `
'use strict';
function checkoutSecretFlow(sku) {
  const message = 'Submitting order for ' + sku;
  return { ok: true, message, sku };
}
module.exports = { checkoutSecretFlow };
`);
execFileSync(process.execPath, [
  path.join(project, 'scripts', 'harden-packaged-js.cjs'),
  sample,
  '--no-bytecode',
], { stdio: 'inherit' });
const hardened = fs.readFileSync(sample, 'utf8');
assert.doesNotMatch(hardened, /Submitting order for/);
assert.match(hardened, /checkoutSecretFlow/);
assert.match(hardened, /_0x/);

fs.rmSync(workspace, { recursive: true, force: true });
console.log('Packaged JavaScript hardening and Garble production-build smoke test passed');
