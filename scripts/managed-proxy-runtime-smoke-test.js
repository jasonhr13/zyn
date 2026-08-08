#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const WebSocket = require(path.join(__dirname, '..', 'extracted', 'asar', 'node_modules', 'ws'));

const port = Number(process.argv[2]);
const screenshotPath = process.argv[3];
if (!port || !screenshotPath) {
  console.error('Usage: node scripts/managed-proxy-runtime-smoke-test.js <debug-port> <screenshot-path>');
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
      const ref = 'managed:11111111-2222-4333-8444-555555555555';
      const leakedSecret = 'remote.example:9000:remote-user:remote-pass';
      const route = async hash => { location.hash = '#' + hash; await wait(300); };
      await wait(350);
      const authoritative = await ipc.invoke('licenseStatus');
      const gateBadge = document.querySelector('.license-gate-badge')?.textContent.trim() || '';

      ipc.sendSync('saveProxyList', { name: 'R7 Local', raw: 'local.example:8000:user:pass' });
      ipc.sendSync('saveProxyList', { name: ref, raw: leakedSecret });
      const persistedCatalog = ipc.sendSync('getProxies');
      const forgedManagedPersisted = (persistedCatalog.lists || []).some(list => list.name === ref);
      const local = (persistedCatalog.lists || []).find(list => list.name === 'R7 Local');
      const safeCatalog = { lists: [local, {
        id: ref.slice(8), ref, name: 'Admin Residential', label: 'Admin Residential', managed: true, count: 2
      }].filter(Boolean) };
      const status = {
        ok: true,
        email: 'r7-renderer-test@example.com',
        offline: false,
        proxyAccess: true,
        managedProxyCount: 1,
        taskTypes: { pokemoncenter: true, round1: true }
      };
      // Startup performs its own authoritative status request. Repeat the renderer-only fixture so
      // a late completion from that request cannot race this visual catalog test back to the gate.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        ipc.emit('licenseStatus', {}, status);
        await wait(175);
      }
      ipc.emit('proxiesUpdated', {}, safeCatalog);
      await wait(100);
      await route('/proxies');
      const proxiesRoute = {
        hash: location.hash,
        title: document.querySelector('.page-title')?.textContent.replace(/\\s+/g, ' ').trim() || '',
        licenseListeners: ipc.listenerCount('licenseStatus'),
        proxyListeners: ipc.listenerCount('proxiesUpdated'),
      };
      const managedRow = [...document.querySelectorAll('.proxy-list-item')]
        .find(element => element.textContent.includes('Admin Residential'));
      managedRow?.click();
      await wait(150);
      const proxyPageText = document.body.textContent.replace(/\\s+/g, ' ');
      const managedChecks = {
        rowFound: Boolean(managedRow),
        lockCopy: proxyPageText.includes('Managed by Zyn'),
        managedLabel: proxyPageText.includes('Admin Residential · Managed'),
        proxyCount: proxyPageText.includes('2 proxies'),
        rowHasDelete: Boolean(managedRow?.querySelector('button')),
        editorTextarea: Boolean(document.querySelector('.proxy-editor-textarea')),
      };
      const managedReadOnly = managedChecks.rowFound && managedChecks.lockCopy
        && managedChecks.managedLabel && managedChecks.proxyCount
        && !managedChecks.rowHasDelete && !managedChecks.editorTextarea;
      const secretVisible = document.documentElement.innerHTML.includes(leakedSecret);

      await route('/task-groups');
      [...document.querySelectorAll('button')]
        .find(button => button.textContent.includes('New Group'))?.click();
      await wait(150);
      const taskGroupOption = [...document.querySelectorAll('.modal select option')]
        .find(option => option.value === ref);

      const originalInvoke = ipc.invoke;
      ipc.invoke = function simulatedStatus(channel, ...args) {
        if (channel === 'licenseStatus') return Promise.resolve(status);
        return originalInvoke.call(this, channel, ...args);
      };
      await route('/settings');
      const settingsAccess = document.querySelector('[data-license-module-access="active"]')?.textContent
        .replace(/\\s+/g, ' ').trim() || '';
      ipc.invoke = originalInvoke;

      ipc.emit('proxiesUpdated', {}, { lists: local ? [local] : [] });
      await route('/task-groups');
      [...document.querySelectorAll('button')]
        .find(button => button.textContent.includes('New Group'))?.click();
      await wait(150);
      const revokedRemoved = ![...document.querySelectorAll('.modal select option')]
        .some(option => option.value === ref);
      ipc.emit('proxiesUpdated', {}, safeCatalog);
      await route('/proxies');
      [...document.querySelectorAll('.proxy-list-item')]
        .find(element => element.textContent.includes('Admin Residential'))?.click();
      await wait(150);

      return {
        electron: process.versions.electron,
        authoritativeOk: authoritative?.ok,
        gateBadge,
        forgedManagedPersisted,
        persistedCatalogSafe: !JSON.stringify(persistedCatalog).includes(leakedSecret),
        managedReadOnly,
        managedChecks,
        proxiesRoute,
        secretVisible,
        taskGroupOption: taskGroupOption ? { value: taskGroupOption.value, label: taskGroupOption.textContent } : null,
        settingsAccess,
        revokedRemoved,
      };
    })()`,
  });
  if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.exception?.description || evaluated.exceptionDetails.text);
  const screenshot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));
  socket.close();

  const result = { ...evaluated.result.value, rendererExceptions, rendererErrors, screenshotPath };
  console.log(JSON.stringify(result, null, 2));
  assert.equal(result.authoritativeOk, false);
  assert.equal(result.gateBadge, 'ZYN');
  assert.equal(result.forgedManagedPersisted, false);
  assert.equal(result.persistedCatalogSafe, true);
  assert.equal(result.managedReadOnly, true);
  assert.equal(result.secretVisible, false);
  assert.equal(result.taskGroupOption.value, 'managed:11111111-2222-4333-8444-555555555555');
  assert.match(result.taskGroupOption.label, /Admin Residential.*Managed/);
  assert.match(result.settingsAccess.replace(/\s+/g, ''), /Managedproxies1list/i);
  assert.equal(result.revokedRemoved, true);
  assert.equal(rendererExceptions, 0);
  assert.equal(rendererErrors, 0);
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
