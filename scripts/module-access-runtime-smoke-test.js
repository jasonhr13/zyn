#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const WebSocket = require(path.join(__dirname, '..', 'extracted', 'asar', 'node_modules', 'ws'));

const port = Number(process.argv[2]);
const screenshotPath = process.argv[3];
if (!port || !screenshotPath) {
  console.error('Usage: node scripts/module-access-runtime-smoke-test.js <debug-port> <screenshot-path>');
  process.exit(2);
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
    }).on('error', reject);
  });
}

async function main() {
  const targets = await getJson(`http://127.0.0.1:${port}/json`);
  const target = targets.find(entry => entry.type === 'page');
  if (!target) throw new Error('Zyn renderer target was not found');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 1;
  let rendererExceptions = 0;
  let rendererErrors = 0;
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  socket.on('message', data => {
    const message = JSON.parse(data);
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
      return;
    }
    if (message.method === 'Runtime.exceptionThrown') rendererExceptions += 1;
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') rendererErrors += 1;
  });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');

  const evaluated = await send('Runtime.evaluate', {
    awaitPromise: true,
    returnByValue: true,
    expression: `(async () => {
      const ipc = window.require('electron').ipcRenderer;
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const publish = taskTypes => ipc.emit('licenseStatus', {}, {
        ok: true,
        email: 'r5-renderer-test@example.com',
        offline: false,
        taskTypes
      });
      const cards = () => [...document.querySelectorAll('.module-card-copy strong')]
        .map(element => element.textContent.trim());
      const route = async hash => {
        location.hash = '#' + hash;
        await wait(250);
        return {
          hash: location.hash,
          title: (document.querySelector('.page-title')?.textContent || '').replace(/\\s+/g, ' ').trim()
        };
      };

      await wait(450);
      const authoritative = await ipc.invoke('licenseStatus');
      const gateBadge = document.querySelector('.license-gate-badge')?.textContent.trim();

      publish({ pokemoncenter: false, round1: false });
      await route('/modules');
      const deniedCards = cards();
      const deniedRound1Route = await route('/round1');
      const deniedPokemonRoute = await route('/pokemoncenter');

      publish({ pokemoncenter: true, round1: true });
      await route('/modules');
      const allowedCards = cards();
      const allowedRound1Route = await route('/round1');
      const allowedPokemonRoute = await route('/pokemoncenter');
      // Settings independently refreshes licenseStatus when it mounts. Keep this renderer-only UI
      // simulation self-contained; the real main authority deliberately remains locked throughout.
      const originalInvoke = ipc.invoke;
      ipc.invoke = function invokeWithSimulatedLicense(channel, ...args) {
        if (channel === 'licenseStatus') return Promise.resolve({
          ok: true,
          email: 'r5-renderer-test@example.com',
          offline: false,
          taskTypes: { pokemoncenter: true, round1: true }
        });
        return originalInvoke.call(this, channel, ...args);
      };
      await route('/settings');
      const settingsAccess = document.querySelector('[data-license-module-access="active"]')?.textContent
        .replace(/\\s+/g, ' ').trim() || '';
      ipc.invoke = originalInvoke;

      await route('/round1');
      publish({ pokemoncenter: true, round1: false });
      await wait(250);
      const removalRedirect = location.hash;

      publish({ pokemoncenter: true, round1: true });
      await route('/modules');
      return {
        electron: process.versions.electron,
        appVersion: ipc.sendSync('getAppVersion'),
        authoritative: {
          ok: authoritative && authoritative.ok,
          taskTypes: authoritative && authoritative.taskTypes
        },
        gateBadge,
        deniedCards,
        deniedRound1Route,
        deniedPokemonRoute,
        allowedCards,
        allowedRound1Route,
        allowedPokemonRoute,
        settingsAccess,
        removalRedirect
      };
    })()`,
  });
  if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.exception?.description || evaluated.exceptionDetails.text);
  const screenshot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));

  const launchBoundary = await send('Runtime.evaluate', {
    awaitPromise: true,
    returnByValue: true,
    expression: `(async () => {
      const ipc = window.require('electron').ipcRenderer;
      let denialPushes = 0;
      const listener = () => { denialPushes += 1; };
      ipc.on('licenseStatus', listener);
      const round1Accepted = ipc.sendSync('startRound1', { profileIds: ['renderer-forgery'], url: 'https://example.com' });
      ipc.send('startPokemonCenter', { instanceId: 'renderer-forgery', queueUrl: 'https://example.com' });
      await new Promise(resolve => setTimeout(resolve, 250));
      ipc.removeListener('licenseStatus', listener);
      return { round1Accepted, denialPushes, authoritativeOk: (await ipc.invoke('licenseStatus')).ok };
    })()`,
  });
  if (launchBoundary.exceptionDetails) throw new Error(launchBoundary.exceptionDetails.exception?.description || launchBoundary.exceptionDetails.text);

  const report = {
    ...evaluated.result.value,
    launchBoundary: launchBoundary.result.value,
    rendererExceptions,
    rendererErrors,
    screenshotPath,
  };
  console.log(JSON.stringify(report, null, 2));
  socket.close();

  const deniedCardsExpected = ['Target'];
  const allowedCardsExpected = ['Target', 'Pokémon Center'];
  const exact = (actual, expected) => JSON.stringify(actual) === JSON.stringify(expected);
  const compactSettingsAccess = report.settingsAccess.replace(/\s+/g, '');
  if (report.authoritative.ok !== false
    || !exact(report.authoritative.taskTypes, { pokemoncenter: false, round1: false })
    || report.gateBadge !== 'ZYN'
    || !exact(report.deniedCards, deniedCardsExpected)
    || !report.deniedRound1Route.hash.endsWith('/modules')
    || !report.deniedPokemonRoute.hash.endsWith('/modules')
    || !exact(report.allowedCards, allowedCardsExpected)
    || !report.allowedRound1Route.hash.endsWith('/modules')
    || !report.allowedPokemonRoute.hash.endsWith('/pokemoncenter')
    || !compactSettingsAccess.includes('TargetworkspaceEnabled')
    || /Pokémon|Round1/i.test(report.settingsAccess)
    || !report.removalRedirect.endsWith('/modules')
    || report.launchBoundary.round1Accepted !== false
    || report.launchBoundary.denialPushes < 2
    || report.launchBoundary.authoritativeOk !== false
    || rendererExceptions
    || rendererErrors) process.exitCode = 1;
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
