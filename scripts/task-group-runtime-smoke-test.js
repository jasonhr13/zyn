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
  console.error('Usage: node scripts/task-group-runtime-smoke-test.js <debug-port> <screenshot-path>');
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

(async () => {
  const targets = await getJson(`http://127.0.0.1:${port}/json`);
  const target = targets.find(entry => entry.type === 'page');
  assert.ok(target, 'Zyn renderer target was not found');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 1;
  let rendererErrors = 0;
  let rendererExceptions = 0;
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
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');

  const evaluated = await send('Runtime.evaluate', {
    awaitPromise: true,
    returnByValue: true,
    expression: `(async () => {
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const ipc = window.require('electron').ipcRenderer;
      location.hash = '#/task-groups';
      await wait(1200);
      const groups = ipc.sendSync('getTaskGroups') || [];
      const group = groups.find(item => (item.tasks || []).length) || groups[0];
      if (!group || !(group.tasks || []).length) throw new Error('A saved Target task is required for the detail smoke test');
      const task = group.tasks[0];
      ipc.emit('targetLog', {}, { taskId: task.id, lines: ['TASK-SMOKE: task-only diagnostic'] });
      ipc.emit('targetLog', {}, { lines: ['ENGINE-SMOKE: shared farmer lifecycle'] });
      await wait(5500);
      const bank = document.querySelector('.cookie-bank');
      const row = document.querySelector('.group-task-row-clickable');
      if (!row) throw new Error('Clickable Target task row was not rendered');
      const groupText = document.body.textContent;
      row.click();
      await wait(400);
      const taskLog = document.querySelector('.task-own-log-panel');
      const sharedLog = document.querySelector('.engine-log-panel');
      return {
        group: group.name,
        taskId: task.id,
        bankText: bank ? bank.textContent.replace(/\\s+/g, ' ').trim() : '',
        bankTitle: bank ? bank.title : '',
        staleR2Banner: groupText.includes('R2 groups existing Target controls only'),
        rowKeyboardAccessible: row.tabIndex === 0,
        detailTitle: document.querySelector('.page-title')?.textContent.trim() || '',
        taskLog: taskLog ? taskLog.textContent.replace(/\\s+/g, ' ').trim() : '',
        sharedLog: sharedLog ? sharedLog.textContent.replace(/\\s+/g, ' ').trim() : '',
      };
    })()`,
  });
  if (evaluated.exceptionDetails) {
    throw new Error(evaluated.exceptionDetails.exception?.description || evaluated.exceptionDetails.text);
  }
  const report = { ...evaluated.result.value, rendererErrors, rendererExceptions };
  assert.match(report.bankText, /Shared Cookie Bank/i);
  assert.match(report.bankText, /Broker (?:online|offline|starting)/i);
  assert.doesNotMatch(report.bankText, /Workers|Run output|Recent errors|Cooling routes|Top failure/i,
    'shared bank should not repeat per-harvester workers or legacy health diagnostics');
  assert.equal(report.staleR2Banner, false);
  assert.equal(report.rowKeyboardAccessible, true);
  assert.match(report.taskLog, /TASK-SMOKE: task-only diagnostic/);
  assert.doesNotMatch(report.taskLog, /ENGINE-SMOKE/);
  assert.match(report.sharedLog, /ENGINE-SMOKE: shared farmer lifecycle/);
  assert.equal(rendererErrors, 0);
  assert.equal(rendererExceptions, 0);

  const screenshot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));
  report.screenshotPath = screenshotPath;
  console.log(JSON.stringify(report, null, 2));
  socket.close();
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
