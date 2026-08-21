#!/usr/bin/env node

import assert from 'node:assert/strict';
import { makePersona, personaInitScript } from './harvest-persona.mjs';

class MediaDeviceInfo {}
class InputDeviceInfo extends MediaDeviceInfo {
  getCapabilities() { throw new TypeError('Illegal invocation'); }
}
class MediaDevices {
  enumerateDevices() { return Promise.resolve([]); }
  getUserMedia() { return Promise.reject(new Error('native gum')); }
}
function Navigator() {
  this.mediaDevices = new MediaDevices();
  this.permissions = { query: async () => ({ state: 'prompt' }) };
}

function installBrowserGlobals() {
  globalThis.window = globalThis;
  globalThis.Navigator = Navigator;
  globalThis.navigator = new Navigator();
  globalThis.MediaDevices = MediaDevices;
  globalThis.MediaDeviceInfo = MediaDeviceInfo;
  globalThis.InputDeviceInfo = InputDeviceInfo;
  globalThis.screen = {};
  globalThis.Notification = { permission: 'default' };
}

function runPersona(platform) {
  installBrowserGlobals();
  const persona = makePersona();
  if (platform) persona.platform = platform;
  new Function(personaInitScript(persona))();
  return globalThis.navigator;
}

async function rejectName(promise) {
  try {
    await promise;
    assert.fail('expected rejection');
  } catch (error) {
    return error.name;
  }
}

for (const platform of ['Win32', 'MacIntel']) {
  const navigator = runPersona(platform);
  const devices = await navigator.mediaDevices.enumerateDevices();
  assert.equal(devices.length, 2, `${platform} reports one device per kind`);
  assert.deepEqual(devices.map(d => d.kind), ['audioinput', 'audiooutput']);
  for (const device of devices) {
    assert.equal(device.deviceId, '');
    assert.equal(device.label, '');
    assert.equal(device.groupId, '');
    assert.deepEqual(device.toJSON(), {
      deviceId: '', kind: device.kind, label: '', groupId: '',
    });
    assert.equal(Object.keys(device).length, 0, 'ids live on the prototype, as in Chrome');
    assert.equal(device instanceof MediaDeviceInfo, true);
  }
  assert.equal(devices[0] instanceof InputDeviceInfo, true);
  assert.deepEqual(devices[0].getCapabilities(), {});
  assert.equal(devices.some(d => d.kind === 'videoinput'), false);
  assert.equal(devices.some(d => d.deviceId === 'communications'), false);
  assert.equal(devices.some(d => d.deviceId && d.deviceId.length > 0), false);

  assert.equal(await rejectName(navigator.mediaDevices.getUserMedia({ audio: true })), 'NotAllowedError',
    `${platform} audio exists but permission was never granted`);
  assert.equal(await rejectName(navigator.mediaDevices.getUserMedia({ video: true })), 'NotFoundError',
    `${platform} listed no camera, so video must not be NotAllowedError`);
  assert.equal(await rejectName(navigator.mediaDevices.getUserMedia({ audio: true, video: true })), 'NotFoundError');
}

const src = personaInitScript(makePersona());
assert.match(src, /fakeDev\('audioinput'\)/);
assert.doesNotMatch(src, /deviceId:'communications'/);
assert.doesNotMatch(src, /getSupportedConstraints/);

console.log('Harvest persona mediaDevices no-permission contract passed');
