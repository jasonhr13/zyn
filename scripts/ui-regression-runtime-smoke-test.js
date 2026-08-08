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
  console.error('Usage: node scripts/ui-regression-runtime-smoke-test.js <debug-port> <screenshot-path>');
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
  if (!target) throw new Error('Hope renderer target was not found');
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
      await wait(350);
      const originalGroups = ipc.sendSync('getTaskGroups') || [];
      const gate = {
        badge: document.querySelector('.license-gate-badge')?.textContent.trim() || '',
        acknowledgementPresent: Boolean(document.querySelector('.license-gate-acknowledge')),
        checkboxCount: document.querySelectorAll('.license-gate-card input[type="checkbox"]').length,
      };
      ipc.sendSync('saveTaskGroups', [{
        id: 'ui-regression-group',
        name: 'Target Log Verification',
        site: 'target',
        skus: '12345678',
        qty: 2,
        proxyListName: '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        tasks: [{
          id: 'ui-regression-task',
          accountId: 'ui-regression-account',
          proxyListName: '',
          createdAt: Date.now(),
        }],
      }]);
      const status = {
        ok: true,
        email: 'ui-regression@example.com',
        taskTypes: { pokemoncenter: true, round1: true },
        proxyAccess: false,
        managedProxyCount: 0,
      };
      for (let attempt = 0; attempt < 3; attempt += 1) {
        ipc.emit('licenseStatus', {}, status);
        await wait(175);
      }
      location.hash = '#/task-groups';
      await wait(350);
      const groupRow = [...document.querySelectorAll('.task-group-row')]
        .find(element => element.textContent.includes('Target Log Verification'));
      groupRow?.click();
      await wait(250);
      ipc.emit('targetLog', {}, { lines: [
        'ENGINE: shape farmer ready',
        'MONITOR: watching Target inventory',
      ] });
      ipc.emit('targetStatus', {}, {
        state: 'monitoring',
        label: 'Monitoring products',
        color: '#65d6a6',
        detail: 'Watching Target stock',
      });
      await wait(200);
      const panel = document.querySelector('.engine-log-panel');
      return {
        originalGroups,
        electron: process.versions.electron,
        gate,
        route: location.hash,
        pageTitle: document.querySelector('.page-title')?.textContent.replace(/\\s+/g, ' ').trim() || '',
        taskRows: document.querySelectorAll('.group-task-row:not(.group-task-table-head)').length,
        panelText: panel?.textContent.replace(/\\s+/g, ' ').trim() || '',
        engineLines: panel?.querySelectorAll('.engine-log-view > div:not(.task-log-empty)').length || 0,
        monitorChip: panel?.querySelector('.engine-monitor-chip')?.textContent.replace(/\\s+/g, ' ').trim() || '',
        panelBelowTasks: Boolean(panel && document.querySelector('.group-task-panel')
          && (document.querySelector('.group-task-panel').compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING)),
      };
    })()`,
  });
  if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.exception?.description || evaluated.exceptionDetails.text);
  const result = evaluated.result.value;
  const screenshot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));
  await send('Runtime.evaluate', {
    expression: `window.require('electron').ipcRenderer.sendSync('saveTaskGroups', ${JSON.stringify(result.originalGroups)})`,
  });
  delete result.originalGroups;
  socket.close();

  const report = { ...result, rendererExceptions, rendererErrors, screenshotPath };
  console.log(JSON.stringify(report, null, 2));
  assert.equal(report.gate.badge, 'CONTROL PLANE R7');
  assert.equal(report.gate.acknowledgementPresent, false);
  assert.equal(report.gate.checkboxCount, 0);
  assert.equal(report.pageTitle, 'Target Log Verification');
  assert.equal(report.taskRows, 1);
  assert.match(report.panelText, /Engine & Monitor Log/);
  assert.match(report.panelText, /ENGINE: shape farmer ready/);
  assert.match(report.panelText, /MONITOR: watching Target inventory/);
  assert.ok(report.engineLines >= 2, 'expected the injected engine and monitor lines');
  assert.match(report.monitorChip, /Monitoring products/);
  assert.equal(report.panelBelowTasks, true);
  assert.equal(rendererExceptions, 0);
  assert.equal(rendererErrors, 0);
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
