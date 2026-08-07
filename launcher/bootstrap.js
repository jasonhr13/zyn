'use strict';

// The original Electron application is kept byte-for-byte in app-original.asar.
// This small bootstrap only translates launches of its bundled Windows binaries
// into equivalent launches through the Wine runtime carried in the app bundle.

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const { app, dialog } = require('electron');
const { CONTROL_PLANE_RELEASE, FEATURES } = require('./feature-flags');
const { MIN_WINDOW_SIZE, loadWindowSize, saveWindowSize } = require('./window-size-state');
const { createTaskGroupStore } = require('./task-group-store');
const { installLicenseObservation } = require('./license-observer');
const { installLicenseAuthority } = require('./license-authority');

// Main-process-only release metadata. The original app does not consume it in R0; future phases
// can query the same frozen object without smuggling configuration through renderer globals.
Object.defineProperty(global, '__hopeControlPlane', {
  value: Object.freeze({ release: CONTROL_PLANE_RELEASE, features: FEATURES }),
  enumerable: false,
  configurable: false,
  writable: false,
});

const resources = process.resourcesPath;
const wine = path.join(resources, 'wine', 'bin', 'wine');
const wineserver = path.join(resources, 'wine', 'bin', 'wineserver');
const originalAsar = path.join(resources, 'app-original.asar');
const originalSpawn = childProcess.spawn.bind(childProcess);
const originalSpawnSync = childProcess.spawnSync.bind(childProcess);
const developerIdentity = 'seaniepokie';

const windowsLaunchers = new Set([
  path.normalize(path.join(resources, 'engine', 'backend')),
  path.normalize(path.join(resources, 'engine', 'backend.exe')),
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
    // not need those diagnostics, and they otherwise flood Hope's task logs.
    MVK_CONFIG_LOG_LEVEL: '0',
  };
}

function shouldUseWine(command) {
  if (typeof command !== 'string') return false;
  return windowsLaunchers.has(path.normalize(path.resolve(command)));
}

childProcess.spawn = function spawnWithBundledWine(command, args, options) {
  if (!shouldUseWine(command)) return originalSpawn(command, args, options);

  const launchArgs = [command, ...(Array.isArray(args) ? args : [])];
  const launchOptions = {
    ...(options || {}),
    env: wineEnvironment(options && options.env),
  };
  return originalSpawn(wine, launchArgs, launchOptions);
};

function disableWindowsOnlyUpdater() {
  try {
    const { autoUpdater } = require(path.join(
      originalAsar,
      'node_modules',
      'electron-updater',
    ));
    autoUpdater.checkForUpdates = function checkForMacWrapperUpdates() {
      setImmediate(() => this.emit('update-not-available', { version: app.getVersion() }));
      return Promise.resolve(null);
    };
    autoUpdater.quitAndInstall = () => {};
  } catch {}
}

function isolateModernChromiumStorage() {
  const electronMajor = Number(String(process.versions.electron || '').split('.')[0]);
  if (!Number.isFinite(electronMajor) || electronMajor <= 19) return;

  // Chromium storage formats are not downgrade-compatible: opening Electron
  // 43 against Electron 19's Cookies/cache databases makes the rollback build
  // reject them as too new. Keep Hope's JSON data and Wine prefix in the same
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
  // patching Electron's constructor. Only the first top-level window is the Hope control plane.
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
          try { persist(); } catch (error) { console.error(`Could not save Hope window size: ${error.message}`); }
        }, 250);
      });
      window.once('close', () => {
        clearTimeout(saveTimer);
        try { persist(); } catch (error) { console.error(`Could not save Hope window size: ${error.message}`); }
      });
      window.once('closed', () => clearTimeout(saveTimer));
    } catch (error) {
      console.error(`Could not restore Hope window size: ${error.message}`);
    }
  });
}

function installTaskGroupControlPlane() {
  if (!FEATURES.taskGroups) return;
  const { ipcMain } = require('electron');
  const store = createTaskGroupStore(app.getPath('userData'));

  ipcMain.on('getTaskGroups', (event) => {
    try {
      event.returnValue = store.load();
    } catch (error) {
      console.error(`Could not load Hope task groups: ${error.message}`);
      event.returnValue = [];
    }
  });
  ipcMain.on('saveTaskGroups', (event, groups) => {
    try {
      event.returnValue = store.save(groups);
    } catch (error) {
      console.error(`Could not save Hope task groups: ${error.message}`);
      try { event.returnValue = store.load(); } catch { event.returnValue = []; }
    }
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

function stopAllRunningForLicense() {
  // Use recoverable stop methods here. Engine shutdown() is reserved for app quit and sets a
  // one-way latch that would prevent a freshly signed-in user from starting again this run.
  try {
    const taskHandler = require(path.join(originalAsar, 'public', 'helpers', 'task-handler.js'));
    for (const name of ['stopAllTasks', 'stopAllBotScripts', 'stopAllPbandai', 'stopAllRound1', 'stopAllPokemonCenter']) {
      try { taskHandler[name]?.(); } catch {}
    }
  } catch {}
  try { require(path.join(originalAsar, 'public', 'helpers', 'target-engine.js')).stopTarget(); } catch {}
  try { require(path.join(originalAsar, 'public', 'helpers', 'walmart-engine.js')).stopWalmart(); } catch {}
  try {
    const { BrowserWindow } = require('electron');
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) { window.show(); window.focus(); }
    }
  } catch {}
}

function guardTaskHelpers(authority) {
  const allowed = () => authority.cached().ok === true;
  const blocked = name => {
    const status = authority.cached();
    console.warn(`Blocked ${name} — license: ${status.reason || 'not active'}`);
    pushLicenseStatus(status);
  };

  try {
    const taskHandler = require(path.join(originalAsar, 'public', 'helpers', 'task-handler.js'));
    for (const name of ['startTask', 'startPbandai', 'forcePbandai', 'startRound1', 'startPokemonCenter']) {
      if (typeof taskHandler[name] !== 'function') continue;
      const original = taskHandler[name].bind(taskHandler);
      taskHandler[name] = (...args) => {
        if (!allowed()) { blocked(name); return undefined; }
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

  for (const [file, method] of [['target-engine.js', 'startTarget'], ['walmart-engine.js', 'startWalmart']]) {
    try {
      const engine = require(path.join(originalAsar, 'public', 'helpers', file));
      const original = engine[method].bind(engine);
      engine[method] = (...args) => {
        if (!allowed()) { blocked(method); return undefined; }
        return original(...args);
      };
    } catch (error) {
      console.error(`Could not guard ${method} with the replacement license: ${error.message}`);
    }
  }
}

function installReplacementLicenseEnforcement() {
  if (!FEATURES.licenseEnforce) return null;
  const { ipcMain, safeStorage } = require('electron');
  const authority = installLicenseAuthority({
    app,
    ipcMain,
    safeStorage,
    onStatus: pushLicenseStatus,
    onLock: stopAllRunningForLicense,
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

function replaceRetiredLicenseIpc(authority) {
  const { ipcMain } = require('electron');
  // The legacy status handler appends the retired key from settings. Replace the whole handler so
  // renderer state contains only the Cloudflare authority's safe status object.
  ipcMain.removeHandler('licenseStatus');
  ipcMain.handle('licenseStatus', (_event, options = {}) => authority.status({ force: options.force === true }));
  ipcMain.removeHandler('activateLicense');
  ipcMain.handle('activateLicense', () => ({ ok: false, reason: 'License keys have been replaced by rCart account sign-in.' }));
}

function enableLocalDeveloperLicense() {
  const now = () => Date.now();
  const verdict = () => ({
    ok: true,
    reason: 'local developer mode',
    expires: null,
    discord: { username: developerIdentity, id: '' },
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
          if (onIdentity) onIdentity({ username: developerIdentity, id: '' });
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

function configureDeveloperReporting() {
  // Central Target/Walmart reporting. Always discard credentials belonging to the retired license
  // service and preserve the requested development identity independently of license authority.
  try {
    const reporter = require(path.join(originalAsar, 'public', 'helpers', 'checkout-reporter.js'));
    const configureReporter = reporter.configure.bind(reporter);
    reporter.configure = (next = {}) => configureReporter({
      ...next,
      key: '',
      token: '',
      discord: developerIdentity,
      discordId: '',
    });
    reporter.configure();
  } catch (error) {
    console.error(`Could not configure the local reporter identity: ${error.message}`);
  }

  // P-Bandai reports from its Windows Node child instead of checkout-reporter, so enforce the same
  // identity at that process boundary as well.
  try {
    const taskHandler = require(path.join(originalAsar, 'public', 'helpers', 'task-handler.js'));
    const startPbandai = taskHandler.startPbandai.bind(taskHandler);
    taskHandler.startPbandai = (options, ...rest) => startPbandai({
      ...(options || {}),
      buyerDiscord: developerIdentity,
      dashboardKey: '',
    }, ...rest);
  } catch (error) {
    console.error(`Could not configure the P-Bandai reporter identity: ${error.message}`);
  }
}

function runWineSelfTest() {
  app.whenReady().then(() => {
    const backend = path.join(resources, 'engine', 'backend');
    const child = childProcess.spawn(backend, ['-h'], {
      cwd: path.dirname(backend),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    child.on('error', (error) => {
      console.error(`HOPE_WINE_SELFTEST failed: ${error.message}`);
      app.exit(1);
    });
    child.on('exit', (code) => {
      console.log(output.trim());
      console.log(`HOPE_WINE_SELFTEST exit=${code}`);
      app.exit(code || 0);
    });
    setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      console.error('HOPE_WINE_SELFTEST timed out');
      app.exit(124);
    }, 30000).unref();
  });
}

// Wine keeps one server per prefix. Stop that private server after Hope's own
// teardown handlers close their child pipes so no backend or browser can linger.
app.on('will-quit', () => {
  const prefix = winePrefix();
  if (!fs.existsSync(prefix) || !fs.existsSync(wineserver)) return;
  try {
    originalSpawnSync(wineserver, ['-k'], {
      env: wineEnvironment(),
      stdio: 'ignore',
      timeout: 4000,
    });
  } catch {}
});

if (!fs.existsSync(wine) || !fs.existsSync(originalAsar)) {
  const missing = !fs.existsSync(wine) ? 'bundled Wine runtime' : 'original application archive';
  dialog.showErrorBox('Hope could not start', `The ${missing} is missing from the app bundle.`);
  app.quit();
} else if (process.env.HOPE_WINE_SELFTEST === '1') {
  runWineSelfTest();
} else {
  // The published update feed contains an NSIS/Windows build and no macOS
  // artifact. Letting electron-updater poll it produces a 404 every hour and,
  // if a mismatched artifact appeared, could replace this custom wrapper.
  isolateModernChromiumStorage();
  preserveMacHardwareAcceleration();
  installWindowSizePersistence();
  installTaskGroupControlPlane();
  const licenseAuthority = FEATURES.licenseEnforce ? installReplacementLicenseEnforcement() : null;
  if (!FEATURES.licenseEnforce) {
    installReplacementLicensePreview();
    enableLocalDeveloperLicense();
  }
  disableWindowsOnlyUpdater();
  configureDeveloperReporting();
  require(path.join(originalAsar, 'public', 'electron.js'));
  if (licenseAuthority) replaceRetiredLicenseIpc(licenseAuthority);
}
