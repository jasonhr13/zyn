#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const project = path.resolve(__dirname, '..');
const {
  disableGpuMarkerPath,
  softwareGpuRequested,
  writeSoftwareGpuMarker,
  preserveHardwareAcceleration,
  compositingLabel,
} = require('../launcher/gpu-compositing');

const read = relative => fs.readFileSync(path.join(project, relative), 'utf8');

assert.match(read('runtime-app/public/electron.js'), /app\.disableHardwareAcceleration\(\)/,
  'runtime app must still request software compositing before ready');
assert.match(read('launcher/bootstrap.js'), /installGpuCompositing/,
  'packaged launcher must install GPU compositing before the original app loads');
assert.match(read('launcher/bootstrap.js'), /disableWindowsNativeOcclusion/,
  'Windows occlusion disable must stay independent of GPU compositing');
assert.match(read('frontend/src/components/pages/settings.js'), /Use software graphics/,
  'Windows settings must offer a software-graphics rollback');
assert.match(read('frontend/src/components/pages/settings.js'), /setSoftwareGpu/,
  'software graphics toggle must persist through the main process');
const contract = require('../config/runtime-contract.json');
assert.ok(contract.requiredResources.includes('Contents/Resources/app/gpu-compositing.js'),
  'gpu-compositing.js must ship in the packaged launcher');
assert.match(read('scripts/build-zyn.sh'), /gpu-compositing\.js/,
  'macOS build must copy gpu-compositing.js');
assert.match(read('scripts/build-zyn-windows.sh'), /gpu-compositing\.js/,
  'Windows build must copy gpu-compositing.js');

assert.equal(softwareGpuRequested({ env: {}, userData: '' }), '');
assert.equal(softwareGpuRequested({ env: { ZYN_DISABLE_GPU: '1' }, userData: '' }), 'env');
assert.equal(softwareGpuRequested({ env: { ZYN_DISABLE_GPU: 'true' }, userData: '' }), 'env');
assert.equal(softwareGpuRequested({ env: { ZYN_DISABLE_GPU: '0' }, userData: '' }), '');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'zyn-gpu-'));
try {
  assert.equal(softwareGpuRequested({ env: {}, userData: temp }), '');
  writeSoftwareGpuMarker(temp, true);
  assert.equal(fs.existsSync(disableGpuMarkerPath(temp)), true);
  assert.equal(softwareGpuRequested({ env: {}, userData: temp }), 'file');
  assert.equal(softwareGpuRequested({ env: { ZYN_DISABLE_GPU: '1' }, userData: temp }), 'env',
    'env must win over the disable-gpu marker');
  writeSoftwareGpuMarker(temp, false);
  assert.equal(fs.existsSync(disableGpuMarkerPath(temp)), false);
  assert.equal(softwareGpuRequested({ env: {}, userData: temp }), '');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

let softwareCalls = 0;
const windowsApp = { disableHardwareAcceleration() { softwareCalls += 1; } };
const allowed = preserveHardwareAcceleration(windowsApp, {
  platform: 'win32', env: {}, userData: '', log: { info() {} },
});
assert.equal(allowed.allowed, true);
windowsApp.disableHardwareAcceleration();
assert.equal(softwareCalls, 0, 'Windows GPU path must neutralize disableHardwareAcceleration');

softwareCalls = 0;
const forcedApp = { disableHardwareAcceleration() { softwareCalls += 1; } };
const forced = preserveHardwareAcceleration(forcedApp, {
  platform: 'win32', env: { ZYN_DISABLE_GPU: '1' }, userData: '', log: { info() {} },
});
assert.equal(forced.allowed, false);
assert.equal(forced.reason, 'env');
forcedApp.disableHardwareAcceleration();
assert.equal(softwareCalls, 1, 'ZYN_DISABLE_GPU=1 must keep the original software-compositing call');

softwareCalls = 0;
const macApp = { disableHardwareAcceleration() { softwareCalls += 1; } };
assert.equal(preserveHardwareAcceleration(macApp, {
  platform: 'darwin', env: {}, userData: '', log: { info() {} },
}).allowed, true);
macApp.disableHardwareAcceleration();
assert.equal(softwareCalls, 0, 'Mac GPU path must stay neutralized');

assert.equal(compositingLabel({ gpu_compositing: 'enabled' }), 'hardware');
assert.equal(compositingLabel({ gpu_compositing: 'disabled_software' }), 'software');

console.log(JSON.stringify({ ok: true, windowsGpu: 'hardware-by-default' }));
