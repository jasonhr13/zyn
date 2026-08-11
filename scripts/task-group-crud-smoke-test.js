#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const WebSocket = require(path.join(__dirname, '..', 'extracted', 'asar', 'node_modules', 'ws'));

const port = Number(process.argv[2]);
const screenshotPath = process.argv[3];
const dataDirectory = process.argv[4] && path.resolve(process.argv[4]);
if (!port || !screenshotPath || !dataDirectory || !dataDirectory.startsWith('/private/tmp/zyn-r2-')) {
  console.error('Usage: node scripts/task-group-crud-smoke-test.js <debug-port> <screenshot-path> <isolated-/private/tmp/zyn-r2-...-user-data-dir>');
  process.exit(2);
}

const seededFiles = [
  path.join(dataDirectory, 'accounts.json'),
  path.join(dataDirectory, 'profiles.json'),
];
const originalFiles = new Map(seededFiles.map(file => [file, fs.existsSync(file) ? fs.readFileSync(file) : null]));
const smokeEmail = 'r2-smoke@example.com';
const smokeAccountId = 'r2-smoke-target-account';
const smokeProfileId = 'r2-smoke-profile';

function arrayFrom(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function seedIsolatedData() {
  fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const accounts = arrayFrom(seededFiles[0]).filter(item => item.id !== smokeAccountId);
  const profiles = arrayFrom(seededFiles[1]).filter(item => item.id !== smokeProfileId);
  accounts.push({
    id: smokeAccountId,
    email: smokeEmail,
    password: '',
    profileId: smokeProfileId,
    createdAt: 1735689600000,
    source: 'smoke-test',
    site: 'target',
  });
  profiles.push({ id: smokeProfileId, name: 'R2 Smoke', email: smokeEmail });
  fs.writeFileSync(seededFiles[0], `${JSON.stringify(accounts, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(seededFiles[1], `${JSON.stringify(profiles, null, 2)}\n`, { mode: 0o600 });
}

function restoreIsolatedData() {
  for (const [file, original] of originalFiles) {
    if (original === null) {
      try { fs.unlinkSync(file); } catch {}
    } else {
      fs.writeFileSync(file, original, { mode: 0o600 });
    }
  }
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    }).on('error', reject);
  });
}

async function main() {
  seedIsolatedData();
  const targets = await getJson(`http://127.0.0.1:${port}/json`);
  const target = targets.find(entry => entry.type === 'page');
  if (!target) throw new Error('Zyn renderer target was not found');

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

  const prepared = await send('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => {
      const ipc = window.require('electron').ipcRenderer;
      const originalGroups = ipc.sendSync('getTaskGroups') || [];
      const account = (ipc.sendSync('getAccounts') || []).find(item => item.id === ${JSON.stringify(smokeAccountId)});
      const profile = (ipc.sendSync('getProfiles') || []).find(item => item.id === ${JSON.stringify(smokeProfileId)});
      ipc.sendSync('saveTaskGroups', []);
      location.hash = '#/task-groups';
      return { originalGroups, accountId: account && account.id, profileId: profile && profile.id };
    })()`,
  });
  if (prepared.exceptionDetails) throw new Error('Could not prepare isolated R2 data');
  const cleanup = prepared.result.value;
  if (!cleanup.accountId || !cleanup.profileId) throw new Error('Could not create smoke-test account/profile');

  await send('Page.reload');
  await new Promise(resolve => setTimeout(resolve, 900));

  const evaluated = await send('Runtime.evaluate', {
    awaitPromise: true,
    returnByValue: true,
    expression: `(async () => {
      const ipc = window.require('electron').ipcRenderer;
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const clickText = (selector, text) => {
        const element = [...document.querySelectorAll(selector)]
          .find(node => node.textContent.replace(/\\s+/g, ' ').trim().includes(text));
        if (!element) throw new Error('Missing control: ' + text);
        element.click();
        return element;
      };
      const setValue = (element, value) => {
        const owner = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(owner, 'value').set.call(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      };
      location.hash = '#/task-groups';
      await wait(300);
      clickText('button', 'New Group');
      await wait(100);
      const name = document.querySelector('.task-group-modal input.form-input');
      const skus = document.querySelector('.task-group-modal textarea');
      const groupLoop = document.querySelector('.task-group-modal .task-repeat-toggle input[type="checkbox"]');
      if (!name || !skus || !groupLoop) throw new Error('Task group editor did not open');
      setValue(name, 'R2 Verification Drop');
      setValue(skus, '12345678\\nhttps://www.target.com/p/example/-/A-87654321');
      groupLoop.click();
      clickText('.task-group-modal button', 'Create Group');
      await wait(300);
      if (!document.querySelector('.page-title')?.textContent.includes('R2 Verification Drop')) {
        throw new Error('Created group did not open');
      }
      clickText('button', 'Add Tasks');
      await wait(120);
      const newTaskLoop = document.querySelector('.task-create-modal .task-repeat-toggle input[type="checkbox"]');
      if (!newTaskLoop || !newTaskLoop.checked) throw new Error('New tasks did not inherit the group loop-checkout default');
      const account = [...document.querySelectorAll('.task-account-picker button')]
        .find(node => node.textContent.includes('r2-smoke@example.com'));
      if (!account || account.disabled) throw new Error('Smoke-test Target account was not selectable');
      account.click();
      await wait(80);
      clickText('.task-create-modal button', 'Add 1 Task');
      await wait(300);
      let launchPayload = null;
      const originalSend = ipc.send;
      ipc.send = (channel, ...args) => {
        if (channel === 'startTarget') {
          launchPayload = args[0];
          return undefined;
        }
        return originalSend.call(ipc, channel, ...args);
      };
      clickText('button', 'Start All');
      await wait(100);
      ipc.send = originalSend;
      const runningGroup = (ipc.sendSync('getTaskGroups') || []).find(item => item.name === 'R2 Verification Drop');
      const runningTaskId = runningGroup && runningGroup.tasks && runningGroup.tasks[0] && runningGroup.tasks[0].id;
      ipc.emit('targetStatus', {}, {
        taskId: runningTaskId,
        state: 'monitoring',
        label: 'Monitoring products',
        color: '#65d6a6',
        detail: 'Watching Target stock',
        running: true,
      });
      const runStartedAt = Date.now() - 100;
      ipc.emit('targetRunStarted', {}, { taskIds: [runningTaskId], startedAt: runStartedAt });
      ipc.emit('targetOutcome', {}, {
        taskId: runningTaskId,
        eventId: 'r2-checkout-event-0001',
        eventType: 'checkout',
        occurredAt: Date.now(),
      });
      ipc.emit('targetStatus', {}, {
        taskId: runningTaskId, state: 'Successful', label: 'Successful',
        color: '#34ca6e', taskState: 3, running: true,
      });
      ipc.emit('targetStatus', {}, {
        taskId: runningTaskId, state: 'Waiting For Restock', label: 'Waiting For Restock',
        color: '#6DACFF', taskState: 1, running: true,
      });
      await wait(100);
      const watchingToneBeforeDone = Boolean(document.querySelector('.group-task-row:not(.group-task-table-head) .target-task-status-watching'));
      let liveEditPayload = null;
      const originalSendSync = ipc.sendSync;
      ipc.sendSync = (channel, ...args) => {
        if (channel === 'editTargetTasks') {
          liveEditPayload = args[0];
          return { ok: true, updated: (liveEditPayload.tasks || []).length, watched: (liveEditPayload.skus || []).length };
        }
        return originalSendSync.call(ipc, channel, ...args);
      };
      clickText('button', 'Edit Group');
      await wait(100);
      const editName = document.querySelector('.task-group-modal input.form-input');
      const editSkus = document.querySelector('.task-group-modal textarea');
      const editQty = document.querySelector('.task-group-modal input[type="number"]');
      setValue(editName, 'R2 Verified Drop');
      setValue(editSkus, '11223344\n55667788');
      setValue(editQty, '4');
      clickText('.task-group-modal button', 'Save Changes');
      await wait(300);
      ipc.sendSync = originalSendSync;
      ipc.emit('targetDone', {}, { taskId: runningTaskId });
      ipc.emit('targetLog', {}, { lines: ['ENGINE: shape farmer ready', 'MONITOR: watching 2 products'] });
      ipc.emit('targetStatus', {}, { state: 'monitoring', label: 'Monitoring products', color: '#65d6a6', detail: 'Watching Target stock' });
      await wait(150);
      const groups = ipc.sendSync('getTaskGroups') || [];
      const group = groups.find(item => item.name === 'R2 Verified Drop');
      const row = document.querySelector('.group-task-row:not(.group-task-table-head)');
      return {
        groups: groups.length,
        groupName: group && group.name,
        site: group && group.site,
        skuCount: group ? String(group.skus || '').split(/\\n/).filter(Boolean).length : 0,
        tasks: group && group.tasks ? group.tasks.length : 0,
        taskAccountId: group && group.tasks && group.tasks[0] && group.tasks[0].accountId,
        pageTitle: document.querySelector('.page-title')?.textContent.trim(),
        taskRow: Boolean(row),
        taskRowText: row ? row.textContent.replace(/\\s+/g, ' ').trim() : '',
        checkoutHeader: [...document.querySelectorAll('.group-task-table-head > span')].some(node => node.textContent.trim() === 'Checkouts'),
        checkoutCount: row && row.querySelector('.task-checkout-count')?.textContent.trim(),
        checkoutCountPositive: Boolean(row && row.querySelector('.task-checkout-count.has-checkouts')),
        watchingTone: watchingToneBeforeDone,
        rowHasObscuringTitle: Boolean(row && row.hasAttribute('title')),
        enginePanel: document.querySelector('.engine-log-panel')?.textContent.replace(/\\s+/g, ' ').trim() || '',
        engineLines: document.querySelectorAll('.engine-log-view > div:not(.task-log-empty)').length,
        monitorChip: document.querySelector('.engine-monitor-chip')?.textContent.replace(/\\s+/g, ' ').trim() || '',
        scheduleControls: [...document.querySelectorAll('button')].some(button => /schedule/i.test(button.textContent)),
        launchIntercepted: Boolean(launchPayload),
        launchTaskCount: launchPayload && launchPayload.tasks ? launchPayload.tasks.length : 0,
        launchSkuCount: launchPayload && launchPayload.skus ? launchPayload.skus.length : 0,
        launchQuantity: launchPayload && launchPayload.qty,
        launchProfileId: launchPayload && launchPayload.tasks && launchPayload.tasks[0] && launchPayload.tasks[0].profileId,
        launchLoopCheckout: launchPayload && launchPayload.tasks && launchPayload.tasks[0] && launchPayload.tasks[0].loopCheckout,
        persistedLoopCheckout: group && group.loopCheckout,
        persistedTaskLoopCheckout: group && group.tasks && group.tasks[0] && group.tasks[0].loopCheckout,
        liveEditIntercepted: Boolean(liveEditPayload),
        liveEditTaskCount: liveEditPayload && liveEditPayload.tasks ? liveEditPayload.tasks.length : 0,
        liveEditSkus: liveEditPayload && liveEditPayload.skus,
        liveEditQuantity: liveEditPayload && liveEditPayload.qty,
        backendLaunchPrevented: Boolean(launchPayload)
      };
    })()`,
  });
  if (evaluated.exceptionDetails) {
    throw new Error(evaluated.exceptionDetails.exception?.description || evaluated.exceptionDetails.text || 'R2 UI evaluation failed');
  }

  const screenshot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));

  await send('Runtime.evaluate', {
    expression: `(() => {
      const ipc = window.require('electron').ipcRenderer;
      ipc.sendSync('saveTaskGroups', ${JSON.stringify(cleanup.originalGroups)});
    })()`,
  });

  const report = {
    ...evaluated.result.value,
    rendererErrors,
    rendererExceptions,
    screenshotPath,
  };
  console.log(JSON.stringify(report, null, 2));
  socket.close();
  restoreIsolatedData();

  if (report.groupName !== 'R2 Verified Drop'
    || report.site !== 'target'
    || report.skuCount !== 2
    || report.tasks !== 1
    || report.taskAccountId !== cleanup.accountId
    || !report.taskRow
    || !report.taskRowText.includes('Ready')
    || !report.checkoutHeader
    || report.checkoutCount !== '1'
    || !report.checkoutCountPositive
    || !report.watchingTone
    || report.rowHasObscuringTitle
    || !report.enginePanel.includes('Engine & Monitor Log')
    || !report.enginePanel.includes('ENGINE: shape farmer ready')
    || !report.enginePanel.includes('MONITOR: watching 2 products')
    || report.engineLines < 2
    || !report.monitorChip.includes('Monitoring products')
    || report.scheduleControls
    || !report.launchIntercepted
    || report.launchTaskCount !== 1
    || report.launchSkuCount !== 2
    || report.launchQuantity !== 2
    || report.launchProfileId !== cleanup.profileId
    || report.launchLoopCheckout !== true
    || report.persistedLoopCheckout !== true
    || report.persistedTaskLoopCheckout !== true
    || !report.liveEditIntercepted
    || report.liveEditTaskCount !== 1
    || JSON.stringify(report.liveEditSkus) !== JSON.stringify(['11223344', '55667788'])
    || String(report.liveEditQuantity) !== '4'
    || !report.backendLaunchPrevented
    || report.rendererErrors
    || report.rendererExceptions) {
    process.exitCode = 1;
  }
}

main().catch(error => {
  restoreIsolatedData();
  console.error(error.message);
  process.exitCode = 1;
});
