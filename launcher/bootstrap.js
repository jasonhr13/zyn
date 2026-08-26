'use strict';

// The original Electron application is kept byte-for-byte in app-original.asar.
// This bootstrap supplies Zyn's cross-platform licensing, scheduling, native-engine,
// runtime-download, and update integration while preserving the reviewed application shell.

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');
const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const { APP_RELEASE, FEATURES } = require('./feature-flags');
const { MIN_WINDOW_SIZE, loadWindowSize, saveWindowSize } = require('./window-size-state');
const { createTaskGroupStore } = require('./task-group-store');
const { createTaskGroupScheduler } = require('./task-group-scheduler');
const { evaluateTargetReadiness } = require('./target-readiness');
const { createTargetProductHistoryStore } = require('./target-product-history');
const { targetGroupStandbyTaskCount } = require('./target-cookie-standby');
const { installLicenseObservation } = require('./license-observer');
const { installLicenseAuthority } = require('./license-authority');
const { installTaskTypeIpcGuard } = require('./task-type-ipc-guard');
const { createProfileImapControl } = require('./profile-imap-control');
const { testImapConnection } = require('./imap-connection');
const { createManagedProxyControl } = require('./managed-proxy-control');
const { createProxyGroupControl } = require('./proxy-group-control');
const { createProxyTestControl } = require('./proxy-test-control');
const { createResiFactoryControl, installResiFactoryIpc } = require('./resifactory-control');
const { createEvomiControl, installEvomiIpc } = require('./evomi-control');
const { createIpfistControl, installIpfistIpc } = require('./ipfist-control');
const hcaptchaAutosolver = require('./hcaptcha-autosolver');
const { createAccountGroupControl } = require('./account-group-control');
const { installManagedProxyIpcGuard } = require('./managed-proxy-ipc-guard');
const { installCheckoutReporting } = require('./checkout-reporting');
const { createAnalyticsService } = require('./analytics-recorder');
const { createPokemonQueueEvents } = require('./pokemon-queue-events');
const { createHarvesterExtensionBridge } = require('./harvester-extension-bridge');
const { createMobileHarvesterBridge } = require('./mobile-harvester-bridge');
const { createCloudBackupManager } = require('./cloud-backup');
const { createCloudBackupDataAdapter } = require('./cloud-backup-data');
const { RuntimeManager, DEFAULT_RUNTIME_ORIGIN } = require('./runtime-manager');

// Main-process-only release metadata, intentionally unavailable to renderer globals.
Object.defineProperty(global, '__zynApp', {
  value: Object.freeze({ release: APP_RELEASE, features: FEATURES }),
  enumerable: false,
  configurable: false,
  writable: false,
});

const resources = process.resourcesPath;
const originalAsar = path.join(resources, 'app-original.asar');
const nativeBackend = path.join(resources, 'engine', process.platform === 'win32' ? 'backend.exe' : 'backend');
const localDeveloperIdentity = process.env.ZYN_DEVELOPER_EMAIL || 'developer@localhost';
const nativePlaywrightBrowsers = path.join(resources, 'vendor', 'ms-playwright-mac');
if (fs.existsSync(nativePlaywrightBrowsers)) {
  // The native farmer reuses this signed Electron executable as Node. Point Playwright at the
  // matching architecture-native Chromium bundle.
  process.env.ZYN_PLAYWRIGHT_BROWSERS_PATH = nativePlaywrightBrowsers;
}

function configureZynUserData() {
  if (process.env.ZYN_USER_DATA_DIR) {
    const testDirectory = path.resolve(process.env.ZYN_USER_DATA_DIR);
    fs.mkdirSync(testDirectory, { recursive: true });
    app.setPath('userData', testDirectory);
    return;
  }
  const applicationSupport = app.getPath('appData');
  const currentDirectory = path.join(applicationSupport, 'Zyn');
  // Copy the previous release's data once so profiles, settings, licenses, cookies, and the Wine
  // prefix survive the product rename. Keep the old directory as a recoverable rollback copy.
  const previousName = String.fromCharCode(72, 111, 112, 101);
  const previousDirectory = path.join(applicationSupport, previousName);
  if (!fs.existsSync(currentDirectory) && fs.existsSync(previousDirectory)) {
    try {
      fs.cpSync(previousDirectory, currentDirectory, { recursive: true, errorOnExist: false });
    } catch (error) {
      console.error(`Could not migrate Zyn application data: ${error.message}`);
    }
  }
  fs.mkdirSync(currentDirectory, { recursive: true });
  app.setPath('userData', currentDirectory);
}

configureZynUserData();

function packagedRuntimeMode() {
  try {
    const receipt = JSON.parse(fs.readFileSync(path.join(resources, 'zyn-build.json'), 'utf8'));
    return receipt.runtime && receipt.runtime.delivery === 'remote' ? 'remote' : 'bundled';
  } catch {
    return 'remote';
  }
}

const runtimeMode = packagedRuntimeMode();
const RUNTIME_UPDATE_POLL_MS = 15 * 60 * 1000;
let runtimeBootstrapStarted = false;
let runtimeUpdatePollTimer = null;
const runtimeOrigin = !app.isPackaged && process.env.ZYN_RUNTIME_ORIGIN
  ? process.env.ZYN_RUNTIME_ORIGIN
  : DEFAULT_RUNTIME_ORIGIN;
const runtimeManager = new RuntimeManager({
  app,
  enabled: app.isPackaged && runtimeMode === 'remote',
  origin: runtimeOrigin,
  log: console,
  onStatus: pushRuntimeStatus,
});
const runtimeInitialization = runtimeManager.initialize();

function pushRuntimeStatus(status) {
  try {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send('runtimeStatus', status || runtimeManager.getStatus());
      }
    }
  } catch {}
}

function beginRuntimeBootstrap({ force = false } = {}) {
  if (!runtimeManager.enabled || (!force && runtimeBootstrapStarted)) return;
  runtimeBootstrapStarted = true;
  runtimeInitialization
    .then(() => runtimeManager.ensureAll({ force }))
    .catch((error) => console.error(`[runtime] background setup: ${error.message}`));
}

function pollRuntimeUpdates() {
  runtimeInitialization
    .then(() => runtimeManager.ensureAll({ background: true }))
    .catch((error) => console.error(`[runtime] update poll: ${error.message}`));
}

function startRuntimeUpdatePolling() {
  if (!runtimeManager.enabled) return;
  beginRuntimeBootstrap();
  if (runtimeUpdatePollTimer) return;
  runtimeUpdatePollTimer = setInterval(pollRuntimeUpdates, RUNTIME_UPDATE_POLL_MS);
  runtimeUpdatePollTimer.unref?.();
}

function stopRuntimeUpdatePolling() {
  if (!runtimeUpdatePollTimer) return;
  clearInterval(runtimeUpdatePollTimer);
  runtimeUpdatePollTimer = null;
}

async function waitForRuntime(names) {
  if (!runtimeManager.enabled) return true;
  try {
    await runtimeInitialization;
    runtimeBootstrapStarted = true;
    // A task start is also an update boundary. Fetch and install the complete signed manifest so a
    // drained engine uses the newest available binary. If only an engine update fails, Chromium
    // and the bundled/previous engine remain valid fallbacks and the task does not become unusable.
    await runtimeManager.ensureAll();
    return true;
  } catch (error) {
    const status = runtimeManager.getStatus();
    const requiredReady = names.every((name) => status.items[name]?.state === 'ready');
    if (requiredReady && fs.existsSync(nativeBackend)) {
      console.warn(`[runtime] using the previous engine after update failure: ${error.message}`);
      return true;
    }
    console.error(`[runtime] task launch blocked: ${error.message}`);
    return false;
  }
}

ipcMain.removeHandler('runtimeStatus');
ipcMain.handle('runtimeStatus', () => runtimeManager.getStatus());
ipcMain.removeHandler('retryRuntimeSetup');
ipcMain.handle('retryRuntimeSetup', async () => {
  await runtimeInitialization;
  runtimeBootstrapStarted = true;
  return runtimeManager.ensureAll({ force: true });
});

function configureUpdater() {
  try {
    const { autoUpdater } = require(path.join(
      originalAsar,
      'node_modules',
      'electron-updater',
    ));
    const updateArch = process.arch === 'x64' ? 'x64' : 'arm64';
    const updateUrl = process.platform === 'win32'
      ? 'https://updates.zynbot.app/windows'
      : `https://updates.zynbot.app/mac/${updateArch}`;
    autoUpdater.setFeedURL({ provider: 'generic', url: updateUrl });
    console.info(`Zyn auto-update feed: ${updateUrl}`);
  } catch (error) {
    console.error(`Could not configure Zyn auto-update feed: ${error.message}`);
  }
}

function isolateModernChromiumStorage() {
  const electronMajor = Number(String(process.versions.electron || '').split('.')[0]);
  if (!Number.isFinite(electronMajor) || electronMajor <= 19) return;

  // Chromium storage formats are not downgrade-compatible: opening Electron
  // 43 against Electron 19's Cookies/cache databases makes the rollback build
  // reject them as too new. Keep Zyn's JSON data and Wine prefix in the same
  // userData directory, but give each modern Electron major its own browser
  // session storage so a canary can never damage the working runtime's state.
  const sessionData = path.join(app.getPath('userData'), `chromium-${electronMajor}`);
  fs.mkdirSync(sessionData, { recursive: true });
  app.setPath('sessionData', sessionData);
}

function preserveMacHardwareAcceleration() {
  if (process.platform !== 'darwin') return;

  // Upstream disables Chromium's GPU process to work around a Windows-only
  // black-window-on-restore issue. On macOS that sends every blur, shadow and
  // keystroke repaint through SwiftShader/CPU compositing, which makes even a
  // controlled text input feel delayed. Keep Chromium's normal Metal-backed
  // acceleration by neutralizing the call before the original main process is
  // loaded. Chromium can still choose software rendering itself if necessary.
  app.disableHardwareAcceleration = () => {};
}

function installWindowSizePersistence() {
  if (!FEATURES.designShell) return;
  let attached = false;

  // The original main process still owns BrowserWindow construction. Its main window starts hidden,
  // so this event can restore validated dimensions before the first paint without replacing or
  // patching Electron's constructor. Only the first top-level window is Zyn's primary window.
  app.on('browser-window-created', (_event, window) => {
    if (attached || window.getParentWindow()) return;
    attached = true;

    try {
      const { screen } = require('electron');
      const statePath = path.join(app.getPath('userData'), 'window-size.json');
      const display = screen.getDisplayMatching(window.getBounds());
      const size = loadWindowSize(statePath, display && display.workAreaSize);
      window.setMinimumSize(MIN_WINDOW_SIZE.width, MIN_WINDOW_SIZE.height);
      window.setSize(size.width, size.height, false);

      let saveTimer = null;
      const persist = () => {
        if (window.isDestroyed()) return;
        saveWindowSize(statePath, window.getNormalBounds());
      };
      window.on('resize', () => {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
          saveTimer = null;
          try { persist(); } catch (error) { console.error(`Could not save Zyn window size: ${error.message}`); }
        }, 250);
      });
      window.once('close', () => {
        clearTimeout(saveTimer);
        try { persist(); } catch (error) { console.error(`Could not save Zyn window size: ${error.message}`); }
      });
      window.once('closed', () => clearTimeout(saveTimer));
    } catch (error) {
      console.error(`Could not restore Zyn window size: ${error.message}`);
    }
  });
}

let taskGroupStore = null;
let taskGroupScheduler = null;
let targetProductHistoryStore = null;
let pokemonQueueEvents = null;
let analyticsService = null;
let harvesterExtensionBridge = null;
let mobileHarvesterBridge = null;
let cloudBackupManager = null;

function disarmPersistedTargetHarvesters() {
  try {
    const dataManager = require(path.join(originalAsar, 'public', 'helpers', 'data-manager.js'));
    const settings = dataManager.getSettings?.() || {};
    if (!Array.isArray(settings.targetHarvesters)) return 0;
    let disarmed = 0;
    const targetHarvesters = settings.targetHarvesters.map(harvester => {
      if (!harvester || typeof harvester !== 'object' || harvester.enabled !== true) return harvester;
      disarmed += 1;
      return { ...harvester, enabled: false };
    });
    if (disarmed) dataManager.saveSettings({ ...settings, targetHarvesters });
    return disarmed;
  } catch (error) {
    console.error(`Could not disarm saved Target harvesters: ${error.message}`);
    return 0;
  }
}

function installHarvesterExtensionCompatibility(authority) {
  try {
    const dataManager = require(path.join(originalAsar, 'public', 'helpers', 'data-manager.js'));
    const targetEngine = require(path.join(originalAsar, 'public', 'helpers', 'target-engine.js'));
    const selected = () => {
      if (authority && authority.cached().ok !== true) return false;
      let settings = {};
      try { settings = dataManager.getSettings?.() || {}; } catch {}
      return /^harvester$/i.test(String(settings.shapeMethod || '').trim());
    };
    const configuredCookieTtl = () => {
      let settings = {};
      try { settings = dataManager.getSettings?.() || {}; } catch {}
      const seconds = Number.parseInt(String(settings.targetCookieTtlSec || ''), 10);
      return Math.max(30, Math.min(86400, Number.isFinite(seconds) && seconds > 0 ? seconds : 600)) * 1000;
    };
    const configuredExtensionIds = () => {
      let settings = {};
      try { settings = dataManager.getSettings?.() || {}; } catch {}
      return [settings.targetHarvesterExtensionIds, settings.targetHarvesterExtensionId]
        .filter(Boolean);
    };
    const bridge = createHarvesterExtensionBridge({
      enabled: selected,
      ensureBroker: () => targetEngine.ensureHarvesterBroker?.(),
      allowedExtensionIds: configuredExtensionIds,
      saveCookie: cookie => {
        if (typeof targetEngine.saveHarvesterCookie !== 'function') {
          throw new Error('Target engine does not expose authenticated extension saves');
        }
        return targetEngine.saveHarvesterCookie(cookie);
      },
      // User-owned lists only. localProxyGroups drops managed lists so ResiFactory/Evomi
      // credentials never leave the main process.
      getProxyCatalog: () => {
        try {
          if (typeof dataManager.getProxyCatalog === 'function') return dataManager.getProxyCatalog();
          return dataManager.getProxies?.() || { lists: [] };
        } catch {
          return { lists: [] };
        }
      },
      allowProxyImport: () => true,
      cookieTtlMs: configuredCookieTtl,
      logger: console,
    });
    // Settings uses this no-payload signal only when the selected mode or pinned extension IDs change.
    // Reset immediately so an Off -> On cycle cannot revive a recent save from the prior session.
    ipcMain.on('resetHarvesterExtensionActivity', () => bridge.resetActivity());
    // The broker reports managed producer telemetry, but the external extension terminates at this
    // main-process bridge. Add its safe activity snapshot at the existing cookie-bank boundary so
    // the renderer can distinguish a configured/recently-saving extension without receiving the
    // extension IDs, broker token, captured headers, or proxy credentials.
    if (typeof targetEngine.getCookieBank === 'function') {
      const getCookieBank = targetEngine.getCookieBank.bind(targetEngine);
      targetEngine.getCookieBank = async (...args) => {
        const bank = await getCookieBank(...args);
        return bank && typeof bank === 'object'
          ? { ...bank, extensionHarvester: bridge.activity() }
          : bank;
      };
    }
    app.whenReady().then(() => bridge.start()).then(address => {
      console.info(`[harvester-extension] compatibility bridge listening on ${address.address}:${address.port}`);
    }).catch(error => {
      console.warn(`[harvester-extension] compatibility bridge unavailable: ${error.message}`);
    });
    return bridge;
  } catch (error) {
    console.warn(`[harvester-extension] compatibility bridge could not start: ${error.message}`);
    return null;
  }
}

function installMobileHarvesterCompanion(authority) {
  if (!authority) return null;
  try {
    const dataManager = require(path.join(originalAsar, 'public', 'helpers', 'data-manager.js'));
    const targetEngine = require(path.join(originalAsar, 'public', 'helpers', 'target-engine.js'));
    const enabled = () => {
      let settings = {};
      try { settings = dataManager.getSettings?.() || {}; } catch {}
      return settings.mobileHarvesterEnabled === true;
    };
    const configuredCookieTtl = () => {
      let settings = {};
      try { settings = dataManager.getSettings?.() || {}; } catch {}
      const seconds = Number.parseInt(String(settings.targetCookieTtlSec || ''), 10);
      return Math.max(30, Math.min(86400, Number.isFinite(seconds) && seconds > 0 ? seconds : 600)) * 1000;
    };
    const bridge = createMobileHarvesterBridge({
      dataDirectory: app.getPath('userData'),
      authority,
      enabled,
      ensureBroker: () => targetEngine.ensureHarvesterBroker?.(),
      getCookieBank: () => (typeof targetEngine.getCookieBank === 'function'
        ? targetEngine.getCookieBank() : {}),
      saveCookie: cookie => {
        if (typeof targetEngine.saveHarvesterCookie !== 'function') {
          throw new Error('Target engine does not expose authenticated mobile saves');
        }
        return targetEngine.saveHarvesterCookie(cookie);
      },
      getProxyCatalog: () => {
        try {
          if (typeof dataManager.getProxyCatalog === 'function') return dataManager.getProxyCatalog();
          return dataManager.getProxies?.() || { lists: [] };
        } catch {
          return { lists: [] };
        }
      },
      cookieTtlMs: configuredCookieTtl,
      logger: console,
    });
    ipcMain.handle('mobileHarvesterStatus', () => bridge.snapshot());
    ipcMain.handle('mobileHarvesterPair', () => bridge.pair());
    ipcMain.handle('mobileHarvesterReset', () => bridge.reset());
    ipcMain.handle('mobileHarvesterUpdate', () => bridge.update());
    if (typeof targetEngine.getCookieBank === 'function') {
      const getCookieBank = targetEngine.getCookieBank.bind(targetEngine);
      targetEngine.getCookieBank = async (...args) => {
        const bank = await getCookieBank(...args);
        return bank && typeof bank === 'object'
          ? { ...bank, mobileHarvester: bridge.activity() }
          : bank;
      };
    }
    app.whenReady().then(() => bridge.start());
    app.once('will-quit', () => bridge.stop());
    return bridge;
  } catch (error) {
    console.warn(`[mobile-harvester] companion unavailable: ${error.message}`);
    return null;
  }
}

function syncTargetGroupCookieStandby(groups) {
  try {
    const targetEngine = require(path.join(originalAsar, 'public', 'helpers', 'target-engine.js'));
    targetEngine.setTargetCookieStandbyTasks?.('task-groups', targetGroupStandbyTaskCount(groups));
  } catch (error) {
    console.error(`Could not update Target cookie-bank standby demand: ${error.message}`);
  }
}

function setTargetHarvestAuthorization(authorized) {
  try {
    const targetEngine = require(path.join(originalAsar, 'public', 'helpers', 'target-engine.js'));
    targetEngine.setTargetHarvestAuthorized?.(authorized === true);
    if (authorized === true && taskGroupStore) {
      targetEngine.setTargetCookieStandbyTasks?.(
        'task-groups', targetGroupStandbyTaskCount(taskGroupStore.load()),
      );
    }
  } catch (error) {
    console.error(`Could not ${authorized ? 'resume' : 'pause'} Target cookie harvesting: ${error.message}`);
  }
}

function installTaskGroups() {
  if (!FEATURES.taskGroups) return;
  const { ipcMain } = require('electron');
  taskGroupStore = createTaskGroupStore(app.getPath('userData'));
  try { syncTargetGroupCookieStandby(taskGroupStore.load()); } catch {}

  ipcMain.on('getTaskGroups', (event) => {
    try {
      event.returnValue = taskGroupStore.load();
    } catch (error) {
      console.error(`Could not load Zyn task groups: ${error.message}`);
      event.returnValue = [];
    }
  });
  ipcMain.on('saveTaskGroups', (event, groups) => {
    try {
      const saved = taskGroupStore.save(groups);
      syncTargetGroupCookieStandby(saved);
      taskGroupScheduler?.sync();
      event.returnValue = saved;
    } catch (error) {
      console.error(`Could not save Zyn task groups: ${error.message}`);
      try { event.returnValue = taskGroupStore.load(); } catch { event.returnValue = []; }
    }
  });
}

async function targetReadinessForGroup(group, taskIds, options = {}) {
  const dataManager = require(path.join(originalAsar, 'public', 'helpers', 'data-manager.js'));
  const targetEngine = require(path.join(originalAsar, 'public', 'helpers', 'target-engine.js'));
  const candidate = group && typeof group === 'object' ? group : {};
  const selected = Array.isArray(taskIds) ? new Set(taskIds.map(String)) : null;
  const tasks = (Array.isArray(candidate.tasks) ? candidate.tasks : [])
    .filter(task => !selected || selected.has(String(task && task.id)));
  const refs = new Set(tasks.map(task => String(task.proxyListName || candidate.proxyListName || '').trim())
    .filter(ref => ref && !/^local$/i.test(ref)));
  const { resolveProxyAssignment, assignmentLineCount } = require('./proxy-resolve');
  const proxyCounts = {};
  for (const ref of refs) {
    try {
      const resolved = resolveProxyAssignment(ref, {
        getProxyLines: name => dataManager.getProxyLines?.(name) || [],
        getProxies: () => dataManager.getProxies?.() || { lists: [] },
      });
      const count = assignmentLineCount(resolved);
      const emptyMembers = resolved.kind === 'group'
        ? (resolved.sources.length ? '' : 'no usable lists in this folder')
        : '';
      proxyCounts[ref] = {
        ok: count > 0,
        count,
        error: count > 0 ? '' : (emptyMembers || 'missing or empty'),
      };
    } catch (error) {
      proxyCounts[ref] = { ok: false, count: 0, error: String(error && error.message || error).slice(0, 300) };
    }
  }
  let bank = null;
  if (options.includeBank !== false) {
    try { bank = await targetEngine.getCookieBank?.(); } catch {}
  }
  return evaluateTargetReadiness(candidate, {
    taskIds: Array.isArray(taskIds) ? taskIds : undefined,
    accounts: dataManager.getAccounts?.() || [],
    profiles: dataManager.getProfiles?.() || [],
    settings: dataManager.getSettings?.() || {},
    proxyCounts,
    bank,
  });
}

function installTargetReadiness() {
  if (!FEATURES.taskGroups || !taskGroupStore) return;
  try { ipcMain.removeHandler('targetReadiness'); } catch {}
  ipcMain.handle('targetReadiness', async (_event, payload = {}) => {
    const group = taskGroupStore.load().find(candidate => String(candidate.id) === String(payload.groupId));
    if (!group) {
      return {
        ok: false,
        level: 'blocked',
        blockers: [{ code: 'group-missing', title: 'Task group unavailable', detail: 'The Target task group no longer exists.' }],
        warnings: [],
        checks: [],
        counts: { tasks: 0, skus: 0 },
      };
    }
    return targetReadinessForGroup(group, Array.isArray(payload.taskIds) ? payload.taskIds : undefined, {
      includeBank: payload.includeBank !== false,
    });
  });
}

function pushTargetProductHistory(items) {
  try {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send('targetProductHistory', { items: Array.isArray(items) ? items : [] });
      }
    }
  } catch {}
}

function installTargetProductHistory() {
  if (!FEATURES.taskGroups || !taskGroupStore) return null;
  try {
    const store = createTargetProductHistoryStore(app.getPath('userData'));
    const targetEngine = require(path.join(originalAsar, 'public', 'helpers', 'target-engine.js'));
    const skuTitles = require(path.join(originalAsar, 'public', 'helpers', 'sku-titles.js'));
    let groups = [];
    let titles = {};
    try { groups = taskGroupStore.load(); } catch {}
    try { titles = skuTitles.getTitles?.() || {}; } catch {}
    store.initialize({ groups, titles });

    const publish = result => {
      if (result && result.changed) pushTargetProductHistory(result.items);
      return result;
    };
    const touch = config => {
      try { return publish(store.touchSkus(config && config.skus)); }
      catch (error) {
        console.error(`Could not update Target product history: ${error.message}`);
        return null;
      }
    };

    // Wrap the shared engine API rather than a renderer page. Every Target launch path—including
    // scheduled task groups and the legacy workspace—calls this same exported function.
    if (!targetEngine.__zynProductHistoryWrapped) {
      for (const method of ['startTarget', 'editTargetTasks']) {
        if (typeof targetEngine[method] !== 'function') continue;
        const original = targetEngine[method].bind(targetEngine);
        targetEngine[method] = (config, ...args) => {
          const result = original(config, ...args);
          if (method !== 'editTargetTasks' || (result && result.ok === true)) touch(config);
          return result;
        };
      }
      Object.defineProperty(targetEngine, '__zynProductHistoryWrapped', { value: true });
    }

    // The native monitor already resolves titles and writes the legacy title cache. Mirror only
    // the affected, normalized entries into the richer history after that existing merge succeeds.
    if (!skuTitles.__zynProductHistoryWrapped && typeof skuTitles.mergeTitles === 'function') {
      const originalMergeTitles = skuTitles.mergeTitles.bind(skuTitles);
      skuTitles.mergeTitles = incoming => {
        const merged = originalMergeTitles(incoming);
        try {
          const cached = skuTitles.getTitles?.() || {};
          const resolved = {};
          for (const sku of Object.keys(incoming || {})) {
            if (cached[sku]) resolved[sku] = cached[sku];
          }
          publish(store.mergeTitles(resolved));
        } catch (error) {
          console.error(`Could not save Target product names to history: ${error.message}`);
        }
        return merged;
      };
      Object.defineProperty(skuTitles, '__zynProductHistoryWrapped', { value: true });
    }

    ipcMain.on('getTargetProductHistory', (event) => {
      try { event.returnValue = store.list(); }
      catch (error) {
        console.error(`Could not load Target product history: ${error.message}`);
        event.returnValue = [];
      }
    });
    return store;
  } catch (error) {
    console.error(`Could not install Target product history: ${error.message}`);
    return null;
  }
}

function pushTaskGroupSchedule(payload = {}) {
  try {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
      window.webContents.send('taskGroupSchedule', payload);
      if (payload.line) window.webContents.send('targetLog', { taskId: '', line: payload.line });
    }
  } catch {}
}

function pushAnalyticsUpdated(payload = {}) {
  try {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send('analyticsUpdated', payload);
      }
    }
  } catch {}
}

function installAnalytics(authority) {
  if (!authority) return null;
  try {
    const service = createAnalyticsService({
      dataDirectory: app.getPath('userData'),
      authority,
      ipcMain,
      onUpdated: pushAnalyticsUpdated,
      logger: console,
    });
    const bridgeRecorder = require(path.join(originalAsar, 'public', 'helpers', 'analytics-recorder.js'));
    bridgeRecorder.setService(service);
    app.once('will-quit', () => service.dispose());
    return service;
  } catch (error) {
    console.error(`Could not install Zyn analytics: ${error.message}`);
    return null;
  }
}

function validateScheduledTargetProxies(config, dataManager, managedProxyControl) {
  const settings = dataManager.getSettings?.() || {};
  const refs = [
    ...(Array.isArray(config?.tasks) ? config.tasks.map(task => task.proxyListName) : []),
    settings.targetHarvesterProxyList,
    ...(Array.isArray(settings.targetHarvesters)
      ? settings.targetHarvesters.map(harvester => harvester && harvester.proxyListName) : []),
  ].map(value => String(value || '')).filter(value => value.startsWith('managed:'));
  for (const ref of new Set(refs)) {
    if (!managedProxyControl) throw new Error('Managed proxy access is unavailable.');
    managedProxyControl.getProxyLines(ref);
  }
}

function installTaskGroupScheduling(authority, managedProxyControl) {
  if (!FEATURES.taskScheduling || !taskGroupStore) return null;
  const dataManager = require(path.join(originalAsar, 'public', 'helpers', 'data-manager.js'));
  const targetEngine = require(path.join(originalAsar, 'public', 'helpers', 'target-engine.js'));
  taskGroupScheduler = createTaskGroupScheduler({
    getGroups: () => taskGroupStore.load(),
    saveGroups: groups => taskGroupStore.save(groups),
    getAccounts: () => dataManager.getAccounts?.() || [],
    getProfiles: () => dataManager.getProfiles?.() || [],
    getReadiness: group => targetReadinessForGroup(group, undefined, { includeBank: false }),
    isTaskRunning: taskId => targetEngine.isTaskRunning?.(taskId) === true,
    canStart: () => (!authority || authority.cached().ok === true)
      && BrowserWindow.getAllWindows().some(window => !window.isDestroyed()),
    startTarget: config => {
      validateScheduledTargetProxies(config, dataManager, managedProxyControl);
      const window = BrowserWindow.getAllWindows().find(candidate => !candidate.isDestroyed());
      if (!window) throw new Error('The Zyn window is not ready.');
      return targetEngine.startTarget(config, window);
    },
    stopTarget: taskId => targetEngine.stopTarget(taskId),
    notify: pushTaskGroupSchedule,
    log: line => console.info(line),
  });
  const syncWhenWindowReady = () => {
    taskGroupScheduler?.sync();
    const armed = taskGroupScheduler?.describeArmed() || [];
    if (armed.length) console.info('[schedule] armed', armed.map(item => `${item.name}: ${item.detail}`).join(' | '));
  };
  if (BrowserWindow.getAllWindows().some(window => !window.isDestroyed())) syncWhenWindowReady();
  else app.once('browser-window-created', () => setTimeout(syncWhenWindowReady, 0));
  return taskGroupScheduler;
}

function installProfileImap() {
  if (!FEATURES.profileImap) return null;
  try {
    const { safeStorage } = require('electron');
    const dataManager = require(path.join(originalAsar, 'public', 'helpers', 'data-manager.js'));
    return createProfileImapControl({
      dataDirectory: app.getPath('userData'),
      safeStorage,
      dataManager,
      logger: console,
    });
  } catch (error) {
    console.error(`Could not install profile mailbox storage: ${error.message}`);
    return null;
  }
}

function installProfileImapIpc(authority, profileControl) {
  if (!FEATURES.profileImap) return;
  const { ipcMain } = require('electron');
  if (profileControl) {
    ipcMain.on('createProfileGroup', (event, name) => {
      try { event.returnValue = { ok: true, group: profileControl.createProfileGroup(name) }; }
      catch (error) { event.returnValue = { ok: false, error: error.message }; }
    });
    ipcMain.on('renameProfileGroup', (event, { from, to } = {}) => {
      try { event.returnValue = { ok: true, group: profileControl.renameProfileGroup(from, to) }; }
      catch (error) { event.returnValue = { ok: false, error: error.message }; }
    });
    ipcMain.on('deleteProfileGroup', (event, name) => {
      try { event.returnValue = { ok: true, affected: profileControl.deleteProfileGroup(name) }; }
      catch (error) { event.returnValue = { ok: false, error: error.message }; }
    });
  }
  ipcMain.removeHandler('testProfileImap');
  ipcMain.handle('testProfileImap', async (_event, config = {}) => {
    if (authority && authority.cached().ok !== true) {
      pushLicenseStatus(authority.cached());
      return { ok: false, message: 'Sign in to Zyn before testing a mailbox.' };
    }
    return testImapConnection(config);
  });
}

function installProxyGroups() {
  try {
    const dataManager = require(path.join(originalAsar, 'public', 'helpers', 'data-manager.js'));
    return createProxyGroupControl({ dataDirectory: app.getPath('userData'), dataManager, logger: console });
  } catch (error) {
    console.error(`Could not install proxy groups: ${error.message}`);
    return null;
  }
}

function installAccountGroups() {
  try {
    const dataManager = require(path.join(originalAsar, 'public', 'helpers', 'data-manager.js'));
    return createAccountGroupControl({ dataDirectory: app.getPath('userData'), dataManager });
  } catch (error) {
    console.error(`Could not install account groups: ${error.message}`);
    return null;
  }
}

function installAccountGroupIpc(accountGroupControl) {
  if (!accountGroupControl) return;
  ipcMain.on('getAccountGroups', event => { event.returnValue = accountGroupControl.getGroups(); });
  ipcMain.on('createAccountGroup', (event, name) => {
    try { event.returnValue = { ok: true, group: accountGroupControl.createGroup(name) }; }
    catch (error) { event.returnValue = { ok: false, error: error.message }; }
  });
  ipcMain.on('renameAccountGroup', (event, { from, to } = {}) => {
    try { event.returnValue = { ok: true, group: accountGroupControl.renameGroup(from, to) }; }
    catch (error) { event.returnValue = { ok: false, error: error.message }; }
  });
  ipcMain.on('deleteAccountGroup', (event, name) => {
    try { event.returnValue = { ok: true, affected: accountGroupControl.deleteGroup(name) }; }
    catch (error) { event.returnValue = { ok: false, error: error.message }; }
  });
  ipcMain.on('addAccountsToGroup', (event, { ids, group } = {}) => {
    try { event.returnValue = { ok: true, affected: accountGroupControl.addAccountsToGroup(ids || [], group) }; }
    catch (error) { event.returnValue = { ok: false, error: error.message }; }
  });
  ipcMain.on('removeAccountsFromGroup', (event, { ids, group } = {}) => {
    try { event.returnValue = { ok: true, affected: accountGroupControl.removeAccountsFromGroup(ids || [], group) }; }
    catch (error) { event.returnValue = { ok: false, error: error.message }; }
  });
}

function installProxyTests() {
  try {
    const dataManager = require(path.join(originalAsar, 'public', 'helpers', 'data-manager.js'));
    return createProxyTestControl({
      dataDirectory: app.getPath('userData'),
      getProxyLines: ref => dataManager.getProxyLines?.(ref) || [],
    });
  } catch (error) {
    console.error(`Could not install proxy tests: ${error.message}`);
    return null;
  }
}

function pushProxyTestProgress(payload) {
  try {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send('proxyTestProgress', payload);
      }
    }
  } catch {}
}

function installProxyTestIpc(proxyTestControl) {
  if (!proxyTestControl) return;
  ipcMain.on('getProxyTestSummaries', event => {
    try { event.returnValue = proxyTestControl.getSummaries(); }
    catch { event.returnValue = {}; }
  });
  ipcMain.on('getProxyTestReport', (event, ref) => {
    try { event.returnValue = proxyTestControl.getReport(ref); }
    catch (error) { event.returnValue = { error: error.message, rows: [] }; }
  });
  ipcMain.on('stopProxyTest', (event, ref) => {
    try { event.returnValue = { ok: proxyTestControl.stop(ref) }; }
    catch (error) { event.returnValue = { ok: false, error: error.message }; }
  });
  ipcMain.removeHandler('startProxyTest');
  ipcMain.handle('startProxyTest', async (_event, payload = {}) => {
    try {
      return await proxyTestControl.start(payload, pushProxyTestProgress);
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
}

function installProxyGroupIpc(proxyGroupControl) {
  if (!proxyGroupControl) return;
  ipcMain.on('getProxyGroups', event => { event.returnValue = proxyGroupControl.getGroups(); });
  ipcMain.on('createProxyGroup', (event, name) => {
    try { event.returnValue = { ok: true, group: proxyGroupControl.createGroup(name) }; }
    catch (error) { event.returnValue = { ok: false, error: error.message }; }
  });
  ipcMain.on('renameProxyGroup', (event, { from, to } = {}) => {
    try { event.returnValue = { ok: true, group: proxyGroupControl.renameGroup(from, to) }; }
    catch (error) { event.returnValue = { ok: false, error: error.message }; }
  });
  ipcMain.on('deleteProxyGroup', (event, name) => {
    try { event.returnValue = { ok: true, affected: proxyGroupControl.deleteGroup(name) }; }
    catch (error) { event.returnValue = { ok: false, error: error.message }; }
  });
  ipcMain.on('addProxyListsToGroup', (event, { refs, group } = {}) => {
    try { event.returnValue = { ok: true, affected: proxyGroupControl.addListsToGroup(refs || [], group) }; }
    catch (error) { event.returnValue = { ok: false, error: error.message }; }
  });
  ipcMain.on('removeProxyListsFromGroup', (event, { refs, group } = {}) => {
    try { event.returnValue = { ok: true, affected: proxyGroupControl.removeListsFromGroup(refs || [], group) }; }
    catch (error) { event.returnValue = { ok: false, error: error.message }; }
  });
}

function installReplacementLicensePreview() {
  if (!FEATURES.licenseObserve || FEATURES.licenseEnforce) return;
  try {
    const { ipcMain, safeStorage } = require('electron');
    installLicenseObservation({ app, ipcMain, safeStorage, logger: console });
  } catch (error) {
    // R3 is deliberately observe-only. A preview initialization failure must never change the
    // existing local developer session, task launches, module access, or reporter identity.
    console.error(`Could not install the replacement license preview: ${error.message}`);
  }
}

function pushLicenseStatus(status) {
  try {
    const { BrowserWindow } = require('electron');
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send('licenseStatus', status);
      }
    }
  } catch {}
}

function pushProxyCatalog(catalog) {
  try {
    const { BrowserWindow } = require('electron');
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send('proxiesUpdated', catalog);
      }
    }
  } catch {}
}

function stopAllRunningForLicense() {
  // Use recoverable stop methods here. Engine shutdown() is reserved for app quit and sets a
  // one-way latch that would prevent a freshly signed-in user from starting again this run.
  try {
    const taskHandler = require(path.join(originalAsar, 'public', 'helpers', 'task-handler.js'));
    for (const name of ['stopAllTasks', 'stopAllBotScripts', 'stopAllPbandai', 'stopAllRound1', 'stopAllPokemonCenter']) {
      try { taskHandler[name]?.(); } catch {}
    }
  } catch {}
  try {
    const nativeEngine = require(path.join(originalAsar, 'public', 'helpers', 'target-engine.js'));
    nativeEngine.stopTarget?.();
    nativeEngine.stopPokemonCenter?.();
  } catch {}
  try {
    const { BrowserWindow } = require('electron');
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) { window.show(); window.focus(); }
    }
  } catch {}
}

function stopRemovedTaskTypes({ removed = [] } = {}) {
  let taskHandler = null;
  try { taskHandler = require(path.join(originalAsar, 'public', 'helpers', 'task-handler.js')); } catch {}
  for (const taskType of removed) {
    if (taskType === 'round1') {
      console.warn('[license] Round1 access removed; stopping its running tasks');
      try { taskHandler?.stopAllRound1?.(); } catch {}
    }
    if (taskType === 'pokemoncenter') {
      console.warn('[license] Pokémon Center access removed; stopping its running tasks');
      try { taskHandler?.stopAllPokemonCenter?.(); } catch {}
      try {
        require(path.join(originalAsar, 'public', 'helpers', 'target-engine.js')).stopPokemonCenter?.();
      } catch {}
    }
    if (taskType === 'walmart') {
      console.warn('[license] Walmart access removed; stopping its running tasks');
      try {
        require(path.join(originalAsar, 'public', 'helpers', 'target-engine.js')).stopWalmart?.();
      } catch {}
    }
  }
}

let pendingTargetRuntimeLaunch = 0;

function targetTaskIds(config = {}) {
  const tasks = Array.isArray(config.tasks) ? config.tasks : [config];
  return tasks.map((task) => String(task?.id || task?.taskId || '')).filter(Boolean);
}

function pushTargetRuntimeState(config, state, color, detail) {
  const ids = targetTaskIds(config);
  const payloads = ids.length ? ids : [''];
  try {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
      for (const taskId of payloads) {
        window.webContents.send('targetStatus', {
          taskId,
          state,
          label: state,
          color,
          detail,
          running: state === 'Preparing Runtime',
        });
      }
    }
  } catch {}
}

async function launchTargetAfterRuntime(original, args, authority) {
  const generation = ++pendingTargetRuntimeLaunch;
  const config = args[0] || {};
  const status = runtimeManager.getStatus();
  if (!status.ready) {
    pushTargetRuntimeState(
      config,
      'Preparing Runtime',
      '#f5c96b',
      status.state === 'downloading' ? `Downloading runtime · ${status.percent || 0}%` : 'Preparing Chromium…',
    );
  }
  const ready = await waitForRuntime(['chromium']);
  if (generation !== pendingTargetRuntimeLaunch || authority.cached().ok !== true) return undefined;
  if (!ready) {
    pushTargetRuntimeState(config, 'Runtime Error', '#ff7b83', 'Runtime setup is paused. Use Retry above.');
    return undefined;
  }
  return original(...args);
}

function guardTaskHelpers(authority) {
  const allowed = () => authority.cached().ok === true;
  const TASK_TYPE_METHODS = Object.freeze({
    startRound1: 'round1', startPokemonCenter: 'pokemoncenter', startWalmart: 'walmart',
  });
  const entitled = taskType => authority.cached().taskTypes?.[taskType] === true;
  const blocked = (name, taskType = '') => {
    const status = authority.cached();
    console.warn(taskType
      ? `Blocked ${name} — optional task type ${taskType} is not enabled for this account`
      : `Blocked ${name} — license: ${status.reason || 'not active'}`);
    pushLicenseStatus(status);
  };

  try {
    const taskHandler = require(path.join(originalAsar, 'public', 'helpers', 'task-handler.js'));
    for (const name of ['startTask', 'startPbandai', 'forcePbandai', 'startRound1', 'startPokemonCenter']) {
      if (typeof taskHandler[name] !== 'function') continue;
      const original = taskHandler[name].bind(taskHandler);
      taskHandler[name] = (...args) => {
        if (!allowed()) { blocked(name); return undefined; }
        const taskType = TASK_TYPE_METHODS[name];
        if (taskType && !entitled(taskType)) { blocked(name, taskType); return undefined; }
        return original(...args);
      };
    }
    if (typeof taskHandler.runBotScript === 'function') {
      const runBotScript = taskHandler.runBotScript.bind(taskHandler);
      taskHandler.runBotScript = (...args) => {
        if (!allowed()) {
          blocked('runBotScript');
          return Promise.resolve({ success: false, error: 'Sign in to continue.' });
        }
        return runBotScript(...args);
      };
    }
  } catch (error) {
    console.error(`Could not guard task helpers with the replacement license: ${error.message}`);
  }

  for (const [file, method, taskType] of [
    ['target-engine.js', 'startTarget', ''],
    ['target-engine.js', 'startPokemonCenter', 'pokemoncenter'],
    ['target-engine.js', 'startWalmart', 'walmart'],
  ]) {
    try {
      const engine = require(path.join(originalAsar, 'public', 'helpers', file));
      if (typeof engine[method] !== 'function') continue;
      const original = engine[method].bind(engine);
      engine[method] = (...args) => {
        if (!allowed()) { blocked(method); return undefined; }
        if (taskType && !entitled(taskType)) { blocked(method, taskType); return undefined; }
        if (method === 'startTarget' && runtimeManager.enabled) {
          return launchTargetAfterRuntime(original, args, authority);
        }
        return original(...args);
      };
      if (method === 'startTarget' && typeof engine.stopTarget === 'function') {
        const stopTarget = engine.stopTarget.bind(engine);
        engine.stopTarget = (...args) => {
          pendingTargetRuntimeLaunch += 1;
          return stopTarget(...args);
        };
      }
    } catch (error) {
      console.error(`Could not guard ${method} with the replacement license: ${error.message}`);
    }
  }
}

function pushResiFactoryStatus(status) {
  try {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send('resiFactoryUpdated', status);
      }
    }
  } catch {}
}

function installResiFactory() {
  if (!FEATURES.resiFactory) return null;
  try {
    const { shell } = require('electron');
    const dataManager = require(path.join(originalAsar, 'public', 'helpers', 'data-manager.js'));
    const control = createResiFactoryControl({
      dataManager,
      logger: console,
      onStatus: pushResiFactoryStatus,
    });
    installResiFactoryIpc({ ipcMain, control, shell, logger: console });
    control.refresh().catch(error => console.warn(`[resifactory] startup refresh: ${error.message}`));
    return control;
  } catch (error) {
    console.error(`Could not install ResiFactory: ${error.message}`);
    return null;
  }
}

function pushEvomiStatus(status) {
  try {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send('evomiUpdated', status);
      }
    }
  } catch {}
}

function installEvomi() {
  if (!FEATURES.evomi) return null;
  try {
    const dataManager = require(path.join(originalAsar, 'public', 'helpers', 'data-manager.js'));
    const control = createEvomiControl({
      dataManager,
      logger: console,
      onStatus: pushEvomiStatus,
    });
    installEvomiIpc({ ipcMain, control, logger: console });
    control.refresh().catch(error => console.warn(`[evomi] startup refresh: ${error.message}`));
    return control;
  } catch (error) {
    console.error(`Could not install Evomi: ${error.message}`);
    return null;
  }
}

function pushIpfistStatus(status) {
  try {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send('ipfistUpdated', status);
      }
    }
  } catch {}
}

function installHcaptchaAutosolver() {
  try {
    hcaptchaAutosolver.start();
  } catch (error) {
    console.warn(`[hcaptcha] could not start model preload: ${error.message}`);
  }
}

function installIpfist() {
  if (!FEATURES.ipfist) return null;
  try {
    const dataManager = require(path.join(originalAsar, 'public', 'helpers', 'data-manager.js'));
    const control = createIpfistControl({
      dataManager,
      logger: console,
      onStatus: pushIpfistStatus,
    });
    installIpfistIpc({ ipcMain, control, logger: console });
    control.refresh().catch(error => console.warn(`[ipfist] startup refresh: ${error.message}`));
    return control;
  } catch (error) {
    console.error(`Could not install IPFist: ${error.message}`);
    return null;
  }
}

function installManagedProxies() {
  if (!FEATURES.managedProxies) return null;
  try {
    const dataManager = require(path.join(originalAsar, 'public', 'helpers', 'data-manager.js'));
    return createManagedProxyControl({
      dataManager,
      onCatalog: pushProxyCatalog,
      onCredentialsChanged: stopAllRunningForLicense,
      logger: console,
    });
  } catch (error) {
    console.error(`Could not install managed proxy storage: ${error.message}`);
    return null;
  }
}

function pushCloudBackupStatus(status) {
  try {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send('cloudBackupStatus', status || cloudBackupManager?.status());
      }
    }
  } catch {}
}

function trustedCloudBackupSender(event) {
  try {
    if (!event || !event.sender || event.sender.isDestroyed()) return false;
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner || owner.isDestroyed()) return false;
    if (event.senderFrame && event.sender.mainFrame && event.senderFrame !== event.sender.mainFrame) return false;
    if (!app.isPackaged) return true;
    const frameUrl = String((event.senderFrame && event.senderFrame.url) || event.sender.getURL() || '');
    const actual = path.resolve(fileURLToPath(frameUrl));
    const expected = path.resolve(originalAsar, 'build', 'index.html');
    return process.platform === 'win32'
      ? actual.toLowerCase() === expected.toLowerCase()
      : actual === expected;
  } catch {
    return false;
  }
}

function installCloudBackup(authority) {
  if (!FEATURES.cloudBackup || !authority) return null;
  try {
    const { clipboard, powerMonitor, safeStorage } = require('electron');
    const dataManager = require(path.join(originalAsar, 'public', 'helpers', 'data-manager.js'));
    const backupData = createCloudBackupDataAdapter({
      dataManager,
      taskGroupStore,
      dataDirectory: app.getPath('userData'),
      onTaskGroupsChanged: savedGroups => {
        syncTargetGroupCookieStandby(savedGroups);
        try { taskGroupScheduler?.sync(); } catch (error) { console.error(`[backup] schedule sync: ${error.message}`); }
      },
    });
    const manager = createCloudBackupManager({
      app,
      safeStorage,
      dataManager: backupData,
      api: authority,
      getAccountId: () => authority.backupAccountId(),
      dialog,
      clipboard,
      log: console,
      onStatus: pushCloudBackupStatus,
    });
    const backupCall = async operation => {
      try { return await operation(); }
      catch (error) {
        console.warn(`[backup] ${error && error.message || error}`);
        return { ok: false, error: String(error && error.message || error).slice(0, 500) };
      }
    };
    const parentWindow = () => BrowserWindow.getFocusedWindow()
      || BrowserWindow.getAllWindows().find(window => !window.isDestroyed())
      || undefined;
    const handle = (channel, operation) => {
      try { ipcMain.removeHandler(channel); } catch {}
      ipcMain.handle(channel, (event, ...args) => {
        if (!trustedCloudBackupSender(event)) {
          console.warn(`[backup] rejected ${channel} from an untrusted renderer`);
          return { ok: false, error: 'Encrypted backup is available only from the Zyn settings window.' };
        }
        return operation(event, ...args);
      });
    };

    handle('cloudBackupStatus', () => manager.status());
    handle('cloudBackupClaimLegacy', () => backupCall(() => manager.claimLegacyState()));
    handle('cloudBackupSetupKey', () => backupCall(async () => ({
      ok: true,
      keyFingerprint: manager.setupKey().keyFingerprint,
      status: manager.status(),
    })));
    handle('cloudBackupCopyKey', () => backupCall(() => manager.copyRecoveryKey(parentWindow())));
    handle('cloudBackupSaveKey', () => backupCall(() => manager.saveRecoveryKey(parentWindow())));
    handle('cloudBackupImportKey', (_event, payload = {}) => backupCall(async () => ({
      ...manager.importRecoveryKey(payload.recoveryKey, payload.expectedFingerprint),
      status: manager.status(),
    })));
    handle('cloudBackupEnable', (_event, intervalMs) => backupCall(async () => {
      manager.confirmKey(intervalMs);
      const uploaded = await manager.uploadNow({ force: true, reason: 'setup' });
      return { ok: true, uploaded, status: manager.status() };
    }));
    handle('cloudBackupSetSchedule', (_event, intervalMs) => backupCall(async () => ({
      ok: true,
      status: manager.setSchedule(intervalMs),
    })));
    handle('cloudBackupRun', () => backupCall(async () => ({
      ...await manager.uploadNow({ force: true, reason: 'manual' }),
      status: manager.status(),
    })));
    handle('cloudBackupList', () => backupCall(async () => ({ ok: true, backups: await manager.listBackups() })));
    handle('cloudBackupPreview', (_event, payload = {}) => backupCall(() => {
      const request = typeof payload === 'string' ? { backupId: payload } : payload;
      return manager.preview(request.backupId, request.mode);
    }));
    handle('cloudBackupRestore', (_event, payload = {}) => backupCall(async () => {
      taskGroupScheduler?.pause?.();
      setTargetHarvestAuthorization(false);
      stopAllRunningForLicense();
      try {
        return await manager.restore(payload.backupId, payload.mode);
      } finally {
        const authorized = authority.cached().ok === true;
        setTargetHarvestAuthorization(authorized);
        if (authorized) taskGroupScheduler?.resume?.();
      }
    }));
    handle('cloudBackupDelete', (_event, backupId) => backupCall(() => manager.deleteBackup(backupId)));

    const resume = () => manager.triggerDue();
    app.whenReady().then(() => {
      powerMonitor.on('resume', resume);
      if (authority.cached().ok === true) manager.start();
    });
    app.once('will-quit', () => {
      try { powerMonitor.removeListener('resume', resume); } catch {}
      manager.pause();
    });
    return manager;
  } catch (error) {
    console.error(`Could not install encrypted cloud backup: ${error.message}`);
    return null;
  }
}

function installReplacementLicenseEnforcement(managedProxyControl) {
  if (!FEATURES.licenseEnforce) return null;
  const { ipcMain, safeStorage } = require('electron');
  const authority = installLicenseAuthority({
    app,
    ipcMain,
    safeStorage,
    onStatus: status => {
      setTargetHarvestAuthorization(status && status.ok === true);
      if (status && status.ok === true) cloudBackupManager?.start();
      else cloudBackupManager?.pause();
      pushLicenseStatus(status);
      try { analyticsService?.sessionChanged(); } catch (error) { console.error(`[analytics] session: ${error.message}`); }
      try { pokemonQueueEvents?.update(status); } catch (error) { console.error(`[queue-monitor] status: ${error.message}`); }
      try { mobileHarvesterBridge?.update(); } catch (error) { console.warn(`[mobile-harvester] status: ${error.message}`); }
      if (status && status.ok === true) {
        startRuntimeUpdatePolling();
        try { taskGroupScheduler?.resume?.(); } catch (error) { console.error(`[schedule] sync: ${error.message}`); }
      } else stopRuntimeUpdatePolling();
    },
    onLock: () => {
      stopRuntimeUpdatePolling();
      setTargetHarvestAuthorization(false);
      cloudBackupManager?.pause();
      taskGroupScheduler?.pause?.();
      stopAllRunningForLicense();
    },
    onEntitlementsChanged: stopRemovedTaskTypes,
    onManagedProxies: result => {
      if (!managedProxyControl) return null;
      const count = managedProxyControl.applyLicenseResult(result);
      return { count, revision: managedProxyControl.revision() };
    },
    logger: console,
  });

  // The original main process already checks license.js before every checkout launcher. Replace
  // only that verdict source so those mature launch boundaries now enforce the Cloudflare session.
  const legacyLicense = require(path.join(originalAsar, 'public', 'helpers', 'license.js'));
  legacyLicense.verifyLicense = (_key, options = {}) => authority.status({ force: options.force === true });
  legacyLicense.cached = () => authority.cached();
  legacyLicense.invalidate = reason => authority.invalidate(reason);

  // Remove the retired key from settings during the authority migration. The original status IPC
  // appends this field to its response, so leaving it in place would unnecessarily expose an
  // obsolete credential to the renderer even though Cloudflare no longer uses it.
  try {
    const dataManager = require(path.join(originalAsar, 'public', 'helpers', 'data-manager.js'));
    const settings = dataManager.getSettings() || {};
    if (settings.licenseKey) dataManager.saveSettings({ ...settings, licenseKey: '' });
  } catch (error) {
    console.error(`Could not clear the retired license key: ${error.message}`);
  }

  // Retire the old dashboard claim/heartbeat without touching its surrounding main-process code.
  // The Cloudflare client owns device binding and session revocation now.
  const legacyClient = require(path.join(originalAsar, 'public', 'helpers', 'license-client.js'));
  legacyClient.startLicense = () => ({
    token: '', hwid: '', start: async () => 'skip', stop: () => {}, release: async () => {}, isActive: () => false,
  });

  guardTaskHelpers(authority);
  return authority;
}

function installNativeHyperAuthority(authority) {
  if (!authority) return;
  try {
    const broker = require(path.join(originalAsar, 'public', 'helpers', 'native-hyper-broker.js'));
    broker.setAuthority(authority);
  } catch (error) {
    console.error(`Could not connect the native Hyper broker to the license authority: ${error.message}`);
  }
}

function installPokemonQueueEventStream(authority) {
  if (!authority) return null;
  try {
    const engine = require(path.join(originalAsar, 'public', 'helpers', 'target-engine.js'));
    const monitor = createPokemonQueueEvents({
      authority,
      setHealth: health => engine.setPokemonQueueStreamHealth?.(health),
      publish: event => engine.publishPokemonQueueProtection?.(event) === true,
      onSolverConfig: key => engine.setSolverLucaKey?.(key),
    });
    monitor.update(authority.cached());
    return monitor;
  } catch (error) {
    console.error(`Could not start the Pokémon Center queue event stream: ${error.message}`);
    return null;
  }
}

function replaceRetiredLicenseIpc(authority) {
  const { ipcMain } = require('electron');
  // The legacy status handler appends the retired key from settings. Replace the whole handler so
  // renderer state contains only the Cloudflare authority's safe status object.
  ipcMain.removeHandler('licenseStatus');
  ipcMain.handle('licenseStatus', (_event, options = {}) => authority.status({ force: options.force === true }));
  ipcMain.removeHandler('activateLicense');
  ipcMain.handle('activateLicense', () => ({ ok: false, reason: 'License keys have been replaced by Zyn account sign-in.' }));
}

function enableLocalDeveloperLicense() {
  const now = () => Date.now();
  const verdict = () => ({
    ok: true,
    reason: 'local developer mode',
    expires: null,
    discord: { username: localDeveloperIdentity, id: '' },
    at: now(),
    lastGood: now(),
  });

  try {
    const license = require(path.join(originalAsar, 'public', 'helpers', 'license.js'));
    license.verifyLicense = async () => verdict();
    license.cached = () => verdict();
    license.invalidate = () => {};
  } catch (error) {
    console.error(`Could not install the local developer license: ${error.message}`);
  }

  // Avoid claims and heartbeats to the retired dashboard when an old key is
  // still present in the user's settings. The local session only supplies the
  // temporary identity expected by electron.js.
  try {
    const licenseClient = require(path.join(originalAsar, 'public', 'helpers', 'license-client.js'));
    licenseClient.startLicense = function startLocalLicense({ onIdentity, onFleetControl } = {}) {
      let active = false;
      return {
        token: 'local-development',
        hwid: 'local-development',
        start: async () => {
          active = true;
          if (onIdentity) onIdentity({ username: localDeveloperIdentity, id: '' });
          if (onFleetControl) onFleetControl({ disabledModules: [], notice: '' });
          return 'ok';
        },
        stop: () => { active = false; },
        release: async () => {},
        isActive: () => active,
      };
    };
  } catch (error) {
    console.error(`Could not install the local license session: ${error.message}`);
  }

}

function configureAccountReporting(licenseAuthority) {
  let reporter = null;
  let taskHandler = null;
  try {
    reporter = require(path.join(originalAsar, 'public', 'helpers', 'checkout-reporter.js'));
  } catch (error) {
    console.error(`Could not load the central checkout reporter: ${error.message}`);
  }
  try {
    taskHandler = require(path.join(originalAsar, 'public', 'helpers', 'task-handler.js'));
  } catch (error) {
    console.error(`Could not load the P-Bandai checkout reporter: ${error.message}`);
  }

  installCheckoutReporting({
    reporter,
    taskHandler,
    getLicenseStatus: () => licenseAuthority ? licenseAuthority.cached() : null,
  });
}

function runNativeEngineSelfTest() {
  app.whenReady().then(async () => {
    const child = childProcess.spawn(nativeBackend, ['-h'], {
      cwd: path.dirname(nativeBackend),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    child.on('error', (error) => {
      console.error(`ZYN_ENGINE_SELFTEST failed: ${error.message}`);
      app.exit(1);
    });
    child.on('exit', (code) => {
      console.log(output.trim());
      console.log(`ZYN_ENGINE_SELFTEST exit=${code}`);
      app.exit(code || 0);
    });
    setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      console.error('ZYN_ENGINE_SELFTEST timed out');
      app.exit(124);
    }, 30000).unref();
  });
}

app.on('will-quit', () => {
  stopRuntimeUpdatePolling();
  try { harvesterExtensionBridge?.stop(); } catch {}
  try { taskGroupScheduler?.dispose(); } catch {}
  try { pokemonQueueEvents?.dispose(); } catch {}
});

if (!fs.existsSync(originalAsar) || !fs.existsSync(nativeBackend)) {
  const missing = !fs.existsSync(originalAsar) ? 'original application archive' : 'native checkout backend';
  dialog.showErrorBox('Zyn could not start', `The ${missing} is missing from the app bundle.`);
  app.quit();
} else if (process.env.ZYN_ENGINE_SELFTEST === '1') {
  runNativeEngineSelfTest();
} else {
  isolateModernChromiumStorage();
  preserveMacHardwareAcceleration();
  installWindowSizePersistence();
  // `enabled` existed as persisted run state in earlier builds. Clear it before the original app,
  // license authority, or cookie broker can load; configurations and schedules remain intact.
  disarmPersistedTargetHarvesters();
  installTaskGroups();
  targetProductHistoryStore = installTargetProductHistory();
  const profileImapControl = installProfileImap();
  const accountGroupControl = installAccountGroups();
  const proxyGroupControl = installProxyGroups();
  const managedProxyControl = installManagedProxies();
  const proxyTestControl = installProxyTests();
  installResiFactory();
  installEvomi();
  installIpfist();
  installHcaptchaAutosolver();
  installTargetReadiness();
  const licenseAuthority = FEATURES.licenseEnforce ? installReplacementLicenseEnforcement(managedProxyControl) : null;
  if (!licenseAuthority) setTargetHarvestAuthorization(true);
  harvesterExtensionBridge = installHarvesterExtensionCompatibility(licenseAuthority);
  mobileHarvesterBridge = installMobileHarvesterCompanion(licenseAuthority);
  analyticsService = installAnalytics(licenseAuthority);
  installNativeHyperAuthority(licenseAuthority);
  pokemonQueueEvents = installPokemonQueueEventStream(licenseAuthority);
  installProfileImapIpc(licenseAuthority, profileImapControl);
  installAccountGroupIpc(accountGroupControl);
  installProxyGroupIpc(proxyGroupControl);
  installProxyTestIpc(proxyTestControl);
  if (!FEATURES.licenseEnforce) {
    installReplacementLicensePreview();
    enableLocalDeveloperLicense();
  }
  installTaskGroupScheduling(licenseAuthority, managedProxyControl);
  cloudBackupManager = installCloudBackup(licenseAuthority);
  configureUpdater();
  configureAccountReporting(licenseAuthority);
  const restoreTaskTypeIpc = licenseAuthority && FEATURES.apiModuleAccess
    ? installTaskTypeIpcGuard({
        ipcMain: require('electron').ipcMain,
        authority: licenseAuthority,
        onBlocked: ({ channel, taskType, status }) => {
          console.warn(`Blocked ${channel} — optional task type ${taskType} is not enabled for this account`);
          pushLicenseStatus(status);
        },
      })
    : () => {};
  const restoreManagedProxyIpc = licenseAuthority && managedProxyControl && FEATURES.managedProxies
    ? installManagedProxyIpcGuard({
        ipcMain: require('electron').ipcMain,
        dataManager: require(path.join(originalAsar, 'public', 'helpers', 'data-manager.js')),
        control: managedProxyControl,
        onBlocked: ({ channel, message }) => console.warn(`Blocked ${channel} — ${message}`),
      })
    : () => {};
  try { require(path.join(originalAsar, 'public', 'electron.js')); }
  finally {
    // Guards are nested in registration order, so restore them in reverse.
    restoreManagedProxyIpc();
    restoreTaskTypeIpc();
  }
  if (licenseAuthority) replaceRetiredLicenseIpc(licenseAuthority);
}
