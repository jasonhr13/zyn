#!/usr/bin/env electron
'use strict';

const assert = require('node:assert/strict');
const electron = require('electron');
const contract = require('../launcher/native-engine-contract');
const { ManualCaptchaManager } = require('../launcher/manual-captcha-manager').__test;

const timeout = setTimeout(() => {
  console.error('manual captcha Electron smoke test timed out');
  electron.app.exit(1);
}, 15_000);

electron.app.whenReady().then(async () => {
  const registry = new contract.TaskSiteRegistry();
  registry.register('electron-pc', contract.SITES.POKEMON_CENTER_US);
  const manager = new ManualCaptchaManager({ electron, logger: { warn() {} } });
  await manager.handleEnvelope({
    type: 'solve-captcha',
    messages: [{
      taskId: 'electron-pc',
      siteKey: '10000000-ffff-ffff-ffff-000000000001',
      siteUrl: 'https://www.pokemoncenter.com/',
      hcapData: '',
      proxy: '',
      cookies: [],
      headers: [],
      captchaType: 'hcaptcha-PokemonCenter',
    }],
  }, {
    registry,
    send: () => true,
    isActive: () => true,
  });

  const window = electron.BrowserWindow.getAllWindows()[0];
  assert.ok(window, 'manual captcha window was not created');
  const page = await window.webContents.executeJavaScript(`({
    origin: location.origin,
    title: document.title,
    nodeType: typeof require,
    tokenBridgeType: typeof window.__zynCaptchaToken,
    body: document.body.innerText
  })`, true);
  assert.equal(page.origin, 'https://www.pokemoncenter.com');
  assert.equal(page.title, 'Zyn Manual Captcha');
  assert.equal(page.nodeType, 'undefined');
  assert.equal(page.tokenBridgeType, 'string');
  assert.match(page.body, /Pokémon Center verification/);

  await manager.cancelPending();
  clearTimeout(timeout);
  console.log(JSON.stringify({
    ok: true,
    electron: process.versions.electron,
    realOrigin: page.origin,
    nodeIntegration: false,
    protocolHandler: true,
  }, null, 2));
  electron.app.exit(0);
}).catch(error => {
  clearTimeout(timeout);
  console.error(error);
  electron.app.exit(1);
});
