'use strict';

// The original Electron application is kept byte-for-byte in app-original.asar.
// This bootstrap supplies Zyn's cross-platform licensing, scheduling, native-engine,
// runtime-download, and update integration while preserving the reviewed application shell.

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const { APP_RELEASE, FEATURES } = require('./feature-flags');
const { MIN_WINDOW_SIZE, loadWindowSize, saveWindowSize } = require('./window-size-state');
const { createTaskGroupStore } = require('./task-group-store');
const { createTaskGroupScheduler } = require('./task-group-scheduler');
const { installLicenseObservation } = require('./license-observer');
const { installLicenseAuthority } = require('./license-authority');
const { installTaskTypeIpcGuard } = require('./task-type-ipc-guard');
const { createProfileImapControl } = require('./profile-imap-control');
const { testImapConnection } = require('./imap-connection');
const { createManagedProxyControl } = require('./managed-proxy-control');
const { installManagedProxyIpcGuard } = require('./managed-proxy-ipc-guard');
const { installCheckoutReporting } = require('./checkout-reporting');
const { createPokemonQueueEvents } = require('./pokemon-queue-events');
const { RuntimeManager, DEFAULT_RUNTIME_ORIGIN } = require('./runtime-manager');

// Main-process-only release metadata, intentionally unavailable to renderer globals.
Object.defineProperty(global, '__zynApp', {
  value: Object.freeze({ release: APP_RELEASE, features: FEATURES }),
  enumerable: false,
  configurable: false,
  writable: false,
});

const resources = process.resourcesPath;
const bundledWine = path.join(resources, 'wine', 'bin', 'wine');
const originalAsar = path.join(resources, 'app-original.asar');
const nativeBackend = path.join(resources, 'engine', process.platform === 'win32' ? 'backend.exe' : 'backend');
const originalSpawn = childProcess.spawn.bind(childProcess);
const originalSpawnSync = childProcess.spawnSync.bind(childProcess);
const localDeveloperIdentity = process.env.ZYN_DEVELOPER_EMAIL || 'developer@localhost';
const nativePlaywrightBrowsers = path.join(resources, 'vendor', 'ms-playwright-mac');
if (fs.existsSync(nativePlaywrightBrowsers)) {
  // The native farmer reuses this signed Electron executable as Node. Point Playwright at the
  // matching macOS Chromium bundle; the original Windows runtime remains available to backend.exe.
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
    return fs.existsSync(bundledWine) ? 'bundled' : 'remote';
  }
}

const runtimeMode = packagedRuntimeMode();
let runtimeBootstrapStarted = false;
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

async function waitForRuntime(names) {
  if (!runtimeManager.enabled) return true;
  try {
    await runtimeInitialization;
    runtimeBootstrapStarted = true;
    await runtimeManager.waitFor(names);
    return true;
  } catch (error) {
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

function winePath() {
  return process.env.ZYN_WINE_PATH || bundledWine;
}

function wineserverPath() {
  return path.join(path.dirname(winePath()), 'wineserver');
}

const windowsLaunchers = new Set([
  path.normalize(path.join(resources, 'vendor', 'node')),
  path.normalize(path.join(resources, 'vendor', 'node.exe')),
]);

function winePrefix() {
  return path.join(app.getPath('userData'), 'wine-prefix');
}

function wineEnvironment(environment) {
  const prefix = winePrefix();
  fs.mkdirSync(prefix, { recursive: true });
  return {
    ...process.env,
    ...(environment || {}),
    WINEPREFIX: prefix,
    WINEARCH: 'win64',
    WINEDEBUG: '-all',
    WINEDLLOVERRIDES: 'winemenubuilder.exe=d',
    // Wine's Vulkan bridge is very chatty by default. The backend and Node do
    // not need those diagnostics, and they otherwise flood Zyn's task logs.
    MVK_CONFIG_LOG_LEVEL: '0',
  };
}

function shouldUseWine(command) {
  if (process.platform === 'win32') return false;
  if (typeof command !== 'string') return false;
  const normalized = path.normalize(path.resolve(command));
  return windowsLaunchers.has(normalized);
}

childProcess.spawn = function spawnWithBundledWine(command, args, options) {
  if (!shouldUseWine(command)) return originalSpawn(command, args, options);

  const launchArgs = [command, ...(Array.isArray(args) ? args : [])];
  const launchOptions = {
    ...(options || {}),
    env: wineEnvironment(options && options.env),
  };
  return originalSpawn(winePath(), launchArgs, launchOptions);
};

function configureUpdater() {
  try {
    const { autoUpdater } = require(path.join(
      originalAsar,
      'node_modules',
      'electron-updater',
    ));
    const updateArch = process.arch === 'x64' ? 'x64' : 'arm64';
    const updateUrl = process.platform === 'win32'
      ? 'https://updates.rcart.app/windows'
      : `https://updates.rcart.app/mac/${updateArch}`;
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
let pokemonQueueEvents = null;

function installTaskGroups() {
  if (!FEATURES.taskGroups) return;
  const { ipcMain } = require('electron');
  taskGroupStore = createTaskGroupStore(app.getPath('userData'));

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
      taskGroupStore.save(groups);
      taskGroupScheduler?.sync();
      event.returnValue = taskGroupStore.load();
    } catch (error) {
      console.error(`Could not save Zyn task groups: ${error.message}`);
      try { event.returnValue = taskGroupStore.load(); } catch { event.returnValue = []; }
    }
  });
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

function validateScheduledTargetProxies(config, dataManager, managedProxyControl) {
  const settings = dataManager.getSettings?.() || {};
  const refs = [
    ...(Array.isArray(config?.tasks) ? config.tasks.map(task => task.proxyListName) : []),
    settings.targetHarvesterProxyList,
    settings.targetThrottleFallbackGroup,
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

function installProfileImapIpc(authority) {
  if (!FEATURES.profileImap) return;
  const { ipcMain } = require('electron');
  ipcMain.removeHandler('testProfileImap');
  ipcMain.handle('testProfileImap', async (_event, config = {}) => {
    if (authority && authority.cached().ok !== true) {
      pushLicenseStatus(authority.cached());
      return { ok: false, message: 'Sign in to Zyn before testing a mailbox.' };
    }
    return testImapConnection(config);
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
  try { require(path.join(originalAsar, 'public', 'helpers', 'walmart-engine.js')).stopWalmart(); } catch {}
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
  const TASK_TYPE_METHODS = Object.freeze({ startRound1: 'round1', startPokemonCenter: 'pokemoncenter' });
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
    ['walmart-engine.js', 'startWalmart', ''],
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

function installReplacementLicenseEnforcement(managedProxyControl) {
  if (!FEATURES.licenseEnforce) return null;
  const { ipcMain, safeStorage } = require('electron');
  const authority = installLicenseAuthority({
    app,
    ipcMain,
    safeStorage,
    onStatus: status => {
      pushLicenseStatus(status);
      try { pokemonQueueEvents?.update(status); } catch (error) { console.error(`[queue-monitor] status: ${error.message}`); }
      if (status && status.ok === true) {
        beginRuntimeBootstrap();
        try { taskGroupScheduler?.sync(); } catch (error) { console.error(`[schedule] sync: ${error.message}`); }
      }
    },
    onLock: stopAllRunningForLicense,
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

// Wine keeps one server per prefix. Stop that private server after Zyn's own
// teardown handlers close their child pipes so no backend or browser can linger.
app.on('will-quit', () => {
  try { taskGroupScheduler?.dispose(); } catch {}
  try { pokemonQueueEvents?.dispose(); } catch {}
  if (process.platform === 'win32') return;
  const prefix = winePrefix();
  const wineserver = wineserverPath();
  if (!fs.existsSync(prefix) || !fs.existsSync(wineserver)) return;
  try {
    originalSpawnSync(wineserver, ['-k'], {
      env: wineEnvironment(),
      stdio: 'ignore',
      timeout: 4000,
    });
  } catch {}
});

if (!fs.existsSync(originalAsar) || !fs.existsSync(nativeBackend)) {
  const missing = !fs.existsSync(originalAsar) ? 'original application archive' : 'native checkout backend';
  dialog.showErrorBox('Zyn could not start', `The ${missing} is missing from the app bundle.`);
  app.quit();
} else if (process.env.ZYN_ENGINE_SELFTEST === '1' || process.env.ZYN_WINE_SELFTEST === '1') {
  runNativeEngineSelfTest();
} else {
  isolateModernChromiumStorage();
  preserveMacHardwareAcceleration();
  installWindowSizePersistence();
  installTaskGroups();
  installProfileImap();
  const managedProxyControl = installManagedProxies();
  const licenseAuthority = FEATURES.licenseEnforce ? installReplacementLicenseEnforcement(managedProxyControl) : null;
  installNativeHyperAuthority(licenseAuthority);
  pokemonQueueEvents = installPokemonQueueEventStream(licenseAuthority);
  installProfileImapIpc(licenseAuthority);
  if (!FEATURES.licenseEnforce) {
    installReplacementLicensePreview();
    enableLocalDeveloperLicense();
  }
  installTaskGroupScheduling(licenseAuthority, managedProxyControl);
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
