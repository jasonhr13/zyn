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
      await wait(350);
      const originalGroups = ipc.sendSync('getTaskGroups') || [];
      const originalInvoke = ipc.invoke.bind(ipc);
      const originalSendSync = ipc.sendSync.bind(ipc);
      let savedSettings = null;
      ipc.invoke = (channel, ...args) => channel === 'targetCookieBank'
        ? Promise.resolve({
          login: 0,
          atc: 0,
          proxies: 1200,
          harvesters: [{
            id: 'ui-stopped-harvester', activeWorkers: 5, configuredWorkers: 5,
            route: 'ISP Proxies', browser: 'chrome', startedAt: Date.now() - 3600000,
            produced: { login: 2, atc: 8 }, lastSuccessAt: Date.now() - 12000,
            bandwidth: {
              available: true, supported: true, uploadEstimated: true,
              attempts: 14, measuredAttempts: 14, cookies: 10,
              downloadBytes: 7200000, uploadBytes: 340000, totalBytes: 7540000,
              proxyBytes: 7540000, directBytes: 0,
              proxyDownloadBytes: 7200000, proxyUploadBytes: 340000, proxyCookies: 10,
              requests: 286, blockedRequests: 92, cachedRequests: 18, failedRequests: 3,
              proxyRequests: 286, proxyBlockedRequests: 92, proxyCachedRequests: 18, proxyFailedRequests: 3,
              byType: {
                login: { attempts: 3, cookies: 2, totalBytes: 3100000 },
                atc: { attempts: 11, cookies: 8, totalBytes: 4440000 },
              },
            },
          }],
        })
        : originalInvoke(channel, ...args);
      ipc.sendSync = (channel, ...args) => {
        if (channel === 'getSettings') {
          return {
            ...(originalSendSync(channel, ...args) || {}),
            targetCookieBank: '64',
            targetHarvestWorkers: '5',
            targetHarvesters: [{
              id: 'ui-stopped-harvester',
              name: 'Target',
              type: 'auto',
              atcMode: 'v2',
              browser: 'auto',
              proxyListName: '',
              workers: 5,
              input: '',
              cookieTtlSec: 600,
              intervalDelaySec: 10,
              startSchedule: '',
              stopSchedule: '',
              enabled: false,
            }],
          };
        }
        if (channel === 'saveSettings') {
          savedSettings = args[0];
          return args[0];
        }
        return originalSendSync(channel, ...args);
      };
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
      const bankMaximum = document.querySelector('[aria-label="Target cookie bank maximum size"]');
      if (!bankMaximum) throw new Error('Cookie bank maximum control was not found');
      const nativeInputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      bankMaximum.focus();
      nativeInputSetter.call(bankMaximum, '80');
      bankMaximum.dispatchEvent(new Event('input', { bubbles: true }));
      bankMaximum.dispatchEvent(new Event('change', { bubbles: true }));
      await wait(60);
      bankMaximum.blur();
      bankMaximum.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      await wait(100);
      ipc.emit('targetLog', {}, { lines: [
        '[shape] started 3 farmer worker(s): chrome, msedge, chromium',
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
      const cookieBank = document.querySelector('.cookie-bank-prominent');
      const harvesterRail = document.querySelector('.target-harvester-rail');
      if (!harvesterRail) throw new Error('Collapsed harvester rail was not rendered');
      const harvesterRailText = harvesterRail.textContent.replace(/\\s+/g, ' ').trim();
      harvesterRail.click();
      await wait(180);
      const harvesterDrawer = document.querySelector('.target-harvester-drawer');
      const harvesterCard = harvesterDrawer?.querySelector('.target-harvester-card');
      const result = {
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
        cookieBankText: cookieBank?.textContent.replace(/\\s+/g, ' ').trim() || '',
        harvesterRailText,
        harvesterDrawerText: harvesterDrawer?.textContent.replace(/\\s+/g, ' ').trim() || '',
        harvesterText: harvesterCard?.textContent.replace(/\\s+/g, ' ').trim() || '',
        harvesterDrawerOpen: Boolean(harvesterDrawer && !document.querySelector('.target-harvester-rail')),
        cookieBankMaximum: bankMaximum.value,
        savedCookieBankMaximum: savedSettings && savedSettings.targetCookieBank,
        cookieBankAboveTasks: Boolean(cookieBank && document.querySelector('.group-task-panel')
          && (cookieBank.compareDocumentPosition(document.querySelector('.group-task-panel')) & Node.DOCUMENT_POSITION_FOLLOWING)),
      };
      ipc.invoke = originalInvoke;
      ipc.sendSync = originalSendSync;
      return result;
    })()`,
  });
  if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.exception?.description || evaluated.exceptionDetails.text);
  const result = evaluated.result.value;
  const screenshot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));
  await send('Runtime.evaluate', {
    awaitPromise: true,
    expression: `(async () => {
      document.querySelector('[aria-label="Close Cookie Harvesters"]')?.click();
      await new Promise(resolve => setTimeout(resolve, 180));
    })()`,
  });
  const collapsedScreenshotPath = screenshotPath.replace(/(\.[a-z0-9]+)$/i, '-collapsed$1');
  const collapsedScreenshot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(collapsedScreenshotPath, Buffer.from(collapsedScreenshot.data, 'base64'));
  await send('Runtime.evaluate', {
    expression: `window.require('electron').ipcRenderer.sendSync('saveTaskGroups', ${JSON.stringify(result.originalGroups)})`,
  });
  delete result.originalGroups;
  socket.close();

  const report = { ...result, rendererExceptions, rendererErrors, screenshotPath, collapsedScreenshotPath };
  console.log(JSON.stringify(report, null, 2));
  assert.equal(report.gate.badge, 'ZYN');
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
  assert.match(report.cookieBankText, /Cookie Bank/);
  assert.match(report.cookieBankText, /Harvesters stopped/);
  assert.match(report.cookieBankText, /0\s*Login/);
  assert.match(report.cookieBankText, /0\s*ATC/);
  assert.match(report.cookieBankText, /Per-type limit/);
  assert.match(report.cookieBankText, /Broker online/);
  assert.doesNotMatch(report.cookieBankText, /Workers|Run output|Cooling routes|Top failure/);
  assert.equal(report.harvesterDrawerOpen, true);
  assert.match(report.harvesterRailText, /0\/1/);
  assert.match(report.harvesterRailText, /0\s*Login/);
  assert.match(report.harvesterRailText, /0\s*ATC/);
  assert.match(report.harvesterDrawerText, /Cookie Harvesters/);
  assert.match(report.harvesterDrawerText, /0\/1\s*Running/);
  assert.match(report.harvesterDrawerText, /New Harvester/);
  assert.match(report.harvesterDrawerText, /Proxy bandwidth/);
  assert.match(report.harvesterDrawerText, /7\.54 MB/);
  assert.match(report.harvesterDrawerText, /754 KB/);
  assert.match(report.harvesterText, /5 configured/);
  assert.match(report.harvesterText, /92 heavy assets blocked/);
  assert.doesNotMatch(report.harvesterText, /5\/5/);
  assert.equal(report.cookieBankMaximum, '80');
  assert.equal(report.savedCookieBankMaximum, '80');
  assert.equal(report.cookieBankAboveTasks, true);
  assert.equal(rendererExceptions, 0);
  assert.equal(rendererErrors, 0);
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
