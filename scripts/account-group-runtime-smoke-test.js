#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const WebSocket = require(path.join(__dirname, '..', 'launcher', 'node_modules', 'ws'));

const port = Number(process.argv[2]);
const screenshotPath = process.argv[3];
if (!port || !screenshotPath) {
  console.error('Usage: node scripts/account-group-runtime-smoke-test.js <debug-port> <screenshot-path>');
  process.exit(2);
}

const getJson = url => new Promise((resolve, reject) => {
  http.get(url, response => {
    let body = '';
    response.on('data', chunk => { body += chunk; });
    response.on('end', () => {
      try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
    });
  }).on('error', reject);
});

async function main() {
  const targets = await getJson(`http://127.0.0.1:${port}/json`);
  const target = targets.find(entry => entry.type === 'page');
  if (!target) throw new Error('Zyn renderer target was not found');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 1;
  let rendererExceptions = 0;
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  socket.on('message', raw => {
    const message = JSON.parse(raw);
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') rendererExceptions += 1;
  });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Runtime.evaluate', {
    awaitPromise: true,
    expression: `(async () => {
      const ipc = window.require('electron').ipcRenderer;
      const smokeLicense = { ok: true, email: 'runtime-smoke@localhost', reason: '' };
      for (let attempt = 0; attempt < 3; attempt += 1) {
        ipc.emit('licenseStatus', {}, smokeLicense);
        await new Promise(resolve => setTimeout(resolve, 175));
      }
      location.hash = '#/accounts';
      await new Promise(resolve => setTimeout(resolve, 500));
      ipc.emit('licenseStatus', {}, smokeLicense);
      await new Promise(resolve => setTimeout(resolve, 400));
    })()`,
  });
  const evaluated = await send('Runtime.evaluate', {
    returnByValue: true,
    awaitPromise: true,
    expression: `(async () => {
      const electron = window.require('electron');
      const ipc = electron.ipcRenderer;
      const testGroup = 'Runtime Smoke Group';
      ipc.sendSync('deleteAccountGroup', testGroup);
      const created = ipc.sendSync('createAccountGroup', testGroup);
      const groups = ipc.sendSync('getAccountGroups') || [];
      const deleted = ipc.sendSync('deleteAccountGroup', testGroup);
      const addButton = [...document.querySelectorAll('button')].find(button => button.textContent.includes('Add Accounts'));
      addButton?.click();
      await new Promise(resolve => setTimeout(resolve, 100));
      const headers = [...document.querySelectorAll('.account-list-table-head > span')]
        .map(element => ({ text: element.textContent.trim(), display: getComputedStyle(element).display }));
      const tableWrap = document.querySelector('.account-table-wrap');
      const result = {
        workspace: Boolean(document.querySelector('.accounts-workspace')),
        shell: Boolean(document.querySelector('.profiles-shell.accounts-shell')),
        sidebar: Boolean(document.querySelector('.profile-groups-sidebar')),
        allAccounts: [...document.querySelectorAll('.profile-group-item')].some(button => button.textContent.includes('All Accounts')),
        ungrouped: [...document.querySelectorAll('.profile-group-item')].some(button => button.textContent.includes('Ungrouped')),
        table: Boolean(document.querySelector('.account-list-table-head')),
        tableFits: Boolean(tableWrap && tableWrap.scrollWidth <= tableWrap.clientWidth + 1),
        viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
        headers,
        headersVisible: headers.length === 5 && headers.every(header => header.display !== 'none'),
        addModal: Boolean(document.querySelector('.account-add-modal')),
        site: document.querySelector('.account-add-modal select')?.value || '',
        created: Boolean(created && created.ok),
        groupVisible: groups.includes(testGroup),
        deleted: Boolean(deleted && deleted.ok),
        decoratedAccounts: (ipc.sendSync('getAccounts') || []).every(account => Array.isArray(account.groups)),
      };
      document.querySelector('.account-add-modal .modal-close')?.click();
      return result;
    })()`,
  });
  if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.text || 'Accounts evaluation failed');
  const screenshot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));
  const report = { ...evaluated.result.value, rendererExceptions, screenshotPath };
  console.log(JSON.stringify(report, null, 2));
  socket.close();
  const failed = Object.entries(report).some(([key, value]) => (
    key !== 'rendererExceptions' && key !== 'screenshotPath' && (value === false || value === '')
  )) || rendererExceptions > 0;
  if (failed) process.exitCode = 1;
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
