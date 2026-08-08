'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const WebSocket = require(path.join(
  __dirname,
  '..',
  'extracted',
  'asar',
  'node_modules',
  'ws',
));

const port = Number(process.argv[2]);
const screenshotPath = process.argv[3];

if (!port || !screenshotPath) {
  console.error('Usage: node scripts/runtime-smoke-test.js <debug-port> <screenshot-path>');
  process.exit(2);
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    }).on('error', reject);
  });
}

async function main() {
  const targets = await getJson(`http://127.0.0.1:${port}/json`);
  const target = targets.find((entry) => entry.type === 'page');
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

  socket.on('message', (data) => {
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
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
      rendererErrors += 1;
    }
  });

  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Page.bringToFront');
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });

  const evaluated = await send('Runtime.evaluate', {
    awaitPromise: true,
    returnByValue: true,
    expression: `(async () => {
      const waitForPaint = () => new Promise(resolve => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        setTimeout(finish, 120);
        requestAnimationFrame(() => requestAnimationFrame(finish));
      });
      const electron = window.require('electron');
      const ipc = electron.ipcRenderer;
      const routePaths = [
        '/task-groups', '/target', '/profiles', '/accounts', '/proxies', '/settings'
      ];
      const routes = [];

      for (const route of routePaths) {
        location.hash = '#' + route;
        await waitForPaint();
        await new Promise(resolve => setTimeout(resolve, 30));
        routes.push({
          route,
          rendered: Boolean(document.querySelector('.page-area')),
          errorBoundary: document.body.textContent.includes('Something went wrong'),
          title: (document.querySelector('.page-title')?.textContent || '').trim().slice(0, 80)
        });
      }

      location.hash = '#/task-groups';
      await waitForPaint();
      const shell = {
        brand: (document.querySelector('.title-bar-name')?.textContent || '').trim(),
        navigation: [...document.querySelectorAll('.sidebar-label')]
          .map(element => element.textContent.trim()),
        moduleCards: [...document.querySelectorAll('.module-card-copy strong')]
          .map(element => element.textContent.trim()),
        activeNavigation: (document.querySelector('.sidebar-link.active .sidebar-label')?.textContent || '').trim(),
        theme: document.body.classList.contains('theme-night') ? 'night' : 'day'
      };

      location.hash = '#/accounts';
      await waitForPaint();
      [...document.querySelectorAll('button')]
        .find(button => button.textContent.includes('Add Accounts'))?.click();
      await waitForPaint();
      const siteSelect = document.querySelector('select[aria-label="Account site"]');
      const accountUi = {
        site: siteSelect?.value || '',
        siteOptions: [...(siteSelect?.options || [])].map(option => option.textContent.trim()),
        hasFilterChips: [...document.querySelectorAll('.page-area button')]
          .some(button => /^(All|Bandai|Target(?: \(\d+\))?|iCloud)$/.test(button.textContent.trim())),
        hasRetiredSiteText: /Bandai|Walmart|Pokémon|Round1|Riot|Secret Lair/.test(
          document.querySelector('.page-area')?.textContent || ''
        )
      };

      const safeLength = (channel) => {
        try {
          const value = ipc.sendSync(channel);
          return Array.isArray(value) ? value.length : (value && typeof value === 'object' ? Object.keys(value).length : 0);
        } catch {
          return -1;
        }
      };

      const license = await ipc.invoke('licenseStatus');
      location.hash = '#/settings';
      await waitForPaint();
      const replacementLicense = await ipc.invoke('controlPlaneLicenseObservationStatus');
      const replacementLicensePanel = {
        present: Boolean(document.querySelector('[data-control-plane-license="observe"]')),
        badge: (document.querySelector('.license-observer-badge')?.textContent || '').trim(),
        warnsAboutReplacement: (document.querySelector('.license-observer-warning')?.textContent || '').includes('revokes this account'),
        rendererKeys: Object.keys(replacementLicense || {}).sort()
      };
      location.hash = '#/profiles';
      await waitForPaint();
      const openButton = [...document.querySelectorAll('button')]
        .find(button => button.textContent.includes('New Profile'));
      if (!openButton) throw new Error('New Profile button was not found');
      openButton.click();
      await waitForPaint();
      await new Promise(resolve => setTimeout(resolve, 500));

      const input = document.querySelector('.modal input.form-input');
      if (!input) throw new Error('Profile input was not found');
      input.focus();
      const initialCharacters = input.value.length;
      const nativeSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value'
      ).set;
      const frameTimes = [];
      for (let index = 0; index < 60; index += 1) {
        const started = performance.now();
        nativeSetter.call(input, input.value + 'a');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(resolve => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            resolve();
          };
          setTimeout(finish, 120);
          requestAnimationFrame(finish);
        });
        frameTimes.push(performance.now() - started);
      }
      const sorted = [...frameTimes].sort((a, b) => a - b);
      await new Promise(resolve => setTimeout(resolve, 300));
      const modal = document.querySelector('.modal');
      const rect = (element) => {
        const value = element.getBoundingClientRect();
        return {
          x: value.x,
          y: value.y,
          width: value.width,
          height: value.height
        };
      };
      const inputStyle = getComputedStyle(input);

      return {
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
        appVersion: ipc.sendSync('getAppVersion'),
        channel: ipc.sendSync('getChannel'),
        licenseOk: Boolean(license && license.ok),
        replacementLicense: {
          mode: replacementLicense && replacementLicense.mode,
          enforcing: replacementLicense && replacementLicense.enforcing,
          signedIn: replacementLicense && replacementLicense.signedIn,
          panel: replacementLicensePanel
        },
        electronBridge: {
          ipcRenderer: typeof electron.ipcRenderer === 'object',
          clipboard: typeof electron.clipboard?.writeText === 'function',
          shell: typeof electron.shell?.openExternal === 'function'
        },
        storedDataReads: {
          tasks: safeLength('getTasks'),
          taskGroups: safeLength('getTaskGroups'),
          profiles: safeLength('getProfiles'),
          accounts: safeLength('getAccounts'),
          proxies: safeLength('getProxies'),
          settings: safeLength('getSettings')
        },
        shell,
        accountUi,
        routes,
        layout: {
          viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
          modal: rect(modal),
          profileInput: rect(input),
          inputFont: inputStyle.font,
          inputPadding: inputStyle.padding,
          inputBorderRadius: inputStyle.borderRadius
        },
        profileInput: {
          insertedCharacters: input.value.length - initialCharacters,
          averageFrameMs: frameTimes.reduce((sum, value) => sum + value, 0) / frameTimes.length,
          p95FrameMs: sorted[Math.floor(sorted.length * 0.95)],
          maximumFrameMs: sorted[sorted.length - 1]
        }
      };
    })()`,
  });

  if (evaluated.exceptionDetails) {
    throw new Error(evaluated.exceptionDetails.text || 'Renderer evaluation failed');
  }

  await send('Runtime.evaluate', {
    awaitPromise: true,
    expression: `(async () => {
      document.querySelector('.modal-close')?.click();
      location.hash = '#/task-groups';
      await new Promise(resolve => setTimeout(resolve, 350));
    })()`,
  });

  const screenshot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));

  const report = {
    ...evaluated.result.value,
    rendererExceptions,
    rendererErrors,
    screenshotPath,
  };
  console.log(JSON.stringify(report, null, 2));
  socket.close();

  const routeFailed = report.routes.some((route) => !route.rendered || route.errorBoundary);
  const bridgeFailed = Object.values(report.electronBridge).some((value) => !value);
  const shellFailed = report.shell.brand !== 'Hope'
    || report.shell.activeNavigation !== 'Tasks'
    || JSON.stringify(report.shell.navigation) !== JSON.stringify([
      'Tasks', 'Profiles', 'Accounts', 'Proxies', 'Settings'
    ])
    || JSON.stringify(report.shell.moduleCards) !== JSON.stringify([]);
  const replacementLicenseFailed = report.replacementLicense.mode !== 'observe'
    || report.replacementLicense.enforcing !== false
    || !report.replacementLicense.panel.present
    || report.replacementLicense.panel.badge !== 'R3 · OBSERVE ONLY'
    || !report.replacementLicense.panel.warnsAboutReplacement
    || report.replacementLicense.panel.rendererKeys.some(key => /token|password|device/i.test(key));
  const accountUiFailed = report.accountUi.site !== 'target'
    || JSON.stringify(report.accountUi.siteOptions) !== JSON.stringify(['Target'])
    || report.accountUi.hasFilterChips
    || report.accountUi.hasRetiredSiteText;
  if (!report.licenseOk || report.profileInput.insertedCharacters !== 60 || routeFailed || bridgeFailed || shellFailed || accountUiFailed || replacementLicenseFailed) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
