const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function electronApp() {
  try { return require('electron').app; } catch { return null; }
}

function isPackaged() {
  return !!electronApp()?.isPackaged;
}

// Bot scripts must be real files because they run in a child Node process. electron-builder unpacks
// both bot/ and production node_modules/ beside app.asar, preserving normal ESM resolution without
// copying a second dependency tree or leaving the rest of the app unarchived.
function botDir() {
  const app = electronApp();
  if (app) {
    const appPath = app.getAppPath();
    const runtimePath = app.isPackaged && appPath.endsWith('.asar') ? `${appPath}.unpacked` : appPath;
    return path.join(runtimePath, 'bot');
  }
  return path.join(__dirname, '..', '..', 'bot');
}

function nodeExecutable() {
  const app = electronApp();
  if (app?.isPackaged) {
    // Electron can run the bot scripts as Node when ELECTRON_RUN_AS_NODE is set.
    // Reusing the signed app executable avoids bundling a second runtime and
    // means a clean Windows machine does not need Node installed separately.
    return process.execPath;
  }

  const lookup = process.platform === 'win32' ? ['where', ['node']] : ['/usr/bin/which', ['node']];
  try {
    const found = execFileSync(lookup[0], lookup[1], { encoding: 'utf8', timeout: 3000 })
      .trim().split(/\r?\n/)[0].trim();
    if (found && fs.existsSync(found)) return found;
  } catch {}

  if (process.platform === 'win32') {
    const candidates = [
      'C:\\Program Files\\nodejs\\node.exe',
      process.env.APPDATA && path.join(process.env.APPDATA, 'nvm', 'current', 'node.exe'),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'nvm', 'current', 'node.exe'),
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'nodejs', 'node.exe'),
    ].filter(Boolean);
    for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  }
  return 'node';
}

function nodeEnvironment(extra = {}) {
  const env = { ...process.env, ...extra };
  if (isPackaged()) {
    env.PLAYWRIGHT_BROWSERS_PATH = process.env.HOPE_PLAYWRIGHT_BROWSERS_PATH
      || path.join(process.resourcesPath, 'vendor', 'ms-playwright');
    env.ELECTRON_RUN_AS_NODE = '1';
  }
  return env;
}

function userDataDir(name) {
  const app = electronApp();
  if (!app) return '';
  const dir = path.join(app.getPath('userData'), name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = { botDir, isPackaged, nodeEnvironment, nodeExecutable, userDataDir };
