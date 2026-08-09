#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const { START_CHANNELS, installManagedProxyIpcGuard } = require('../launcher/managed-proxy-ipc-guard');

const id = '11111111-2222-4333-8444-555555555555';
const ref = `managed:${id}`;
const secret = 'remote.example:9000:remote-user:remote-pass';
const listeners = new Map();
const handlers = new Map();
const ipcMain = {
  on(channel, listener) { listeners.set(channel, listener); return this; },
  handle(channel, listener) { handlers.set(channel, listener); },
};
const dataManager = {
  getTasks: () => [{ id: 'task-one', proxyList: ref }],
  getSettings: () => ({ targetHarvesterProxyList: ref }),
};
let available = true;
const control = {
  getProxyLines(value) {
    if (!available && value === ref) {
      const error = new Error('Managed proxy unavailable');
      error.code = 'MANAGED_PROXY_UNAVAILABLE';
      throw error;
    }
    return value === ref ? [secret] : [];
  },
  pickProxyLine: value => value === ref ? secret : '',
};
const blocked = [];
const restore = installManagedProxyIpcGuard({
  ipcMain,
  dataManager,
  control,
  onBlocked: event => blocked.push(event),
});

let launches = 0;
for (const channel of START_CHANNELS) ipcMain.on(channel, () => { launches += 1; });
let mainOnlyArgs = [];
ipcMain.handle('runBotScript', async (_event, _script, args) => {
  mainOnlyArgs = args;
  return { success: true };
});
restore();

const argsFor = channel => {
  if (channel === 'startTask') return [{ id: 'task-one' }];
  if (channel === 'setTargetTaskProxy') return ['target-one', ref];
  if (channel === 'startTarget' || channel === 'editTargetTasks') return [{ tasks: [{ proxyListName: ref }] }];
  return [{ proxyListName: ref }];
};
const makeEvent = () => {
  const messages = [];
  return { returnValue: undefined, messages, sender: { send: (...args) => messages.push(args) } };
};

(async () => {
  const allowedEvent = makeEvent();
  listeners.get('startPbandai')(allowedEvent, { proxyListName: ref });
  assert.equal(launches, 1);

  const result = await handlers.get('runBotScript')({}, 'pbandai-register.mjs', ['--email=test@example.com'], 'run-one', ref);
  assert.deepEqual(result, { success: true });
  assert.ok(mainOnlyArgs.includes('--proxyServer=remote.example:9000'));
  assert.ok(mainOnlyArgs.includes('--proxyUser=remote-user'));
  assert.ok(mainOnlyArgs.includes('--proxyPass=remote-pass'));
  assert.equal(JSON.stringify(result).includes('remote-pass'), false, 'managed credential returned to renderer');

  available = false;
  for (const channel of START_CHANNELS) {
    const event = makeEvent();
    listeners.get(channel)(event, ...argsFor(channel));
    assert.equal(event.returnValue, false, `${channel} did not fail closed`);
    assert.equal(event.messages[0]?.[0], 'managedProxyError', `${channel} did not notify renderer`);
    assert.equal(JSON.stringify(event.messages).includes('remote-pass'), false, `${channel} leaked credentials`);
  }
  const denied = await handlers.get('runBotScript')({}, 'pbandai-register.mjs', [], 'run-two', ref);
  assert.equal(denied.success, false);
  assert.equal(JSON.stringify(denied).includes('remote-pass'), false);
  assert.equal(launches, 1, 'revoked managed list reached an archived launch handler');

  console.log(JSON.stringify({
    ok: true,
    guardedChannels: START_CHANNELS.size,
    revokedListsFailClosed: true,
    generateInjectionMainOnly: true,
    rendererCredentialLeak: false,
    blockedEvents: blocked.length,
  }, null, 2));
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
