import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function resolvePoolFile() {
  const packaged = path.join(here, 'shape-browser-pool.mjs');
  if (fs.existsSync(packaged)) return packaged;
  return path.join(here, '..', 'native-farmer', 'shape-browser-pool.mjs');
}

let poolPromise;

export function loadGenerationBrowserPool() {
  poolPromise ||= import(pathToFileURL(resolvePoolFile()).href);
  return poolPromise;
}

export function chromeExecutablePaths({
  platform = process.platform,
  homeDir = os.homedir(),
  env = process.env,
} = {}) {
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      path.join(homeDir, 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
    ];
  }
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local');
    const programFiles = env.ProgramFiles || env.PROGRAMFILES || 'C:\\Program Files';
    const programFilesX86 = env['ProgramFiles(x86)'] || env.PROGRAMFILES_X86 || 'C:\\Program Files (x86)';
    return [localAppData, programFiles, programFilesX86]
      .map(root => path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  }
  if (platform === 'linux') {
    return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'];
  }
  return [];
}

export function edgeExecutablePaths({
  platform = process.platform,
  homeDir = os.homedir(),
  env = process.env,
} = {}) {
  if (platform === 'darwin') {
    return [
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      path.join(homeDir, 'Applications', 'Microsoft Edge.app', 'Contents', 'MacOS', 'Microsoft Edge'),
    ];
  }
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local');
    const programFiles = env.ProgramFiles || env.PROGRAMFILES || 'C:\\Program Files';
    const programFilesX86 = env['ProgramFiles(x86)'] || env.PROGRAMFILES_X86 || 'C:\\Program Files (x86)';
    return [localAppData, programFiles, programFilesX86]
      .map(root => path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  }
  if (platform === 'linux') {
    return ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable'];
  }
  return [];
}

export function isGenerationBrowserInstalled(candidate, options = {}) {
  const existsSync = options.existsSync || fs.existsSync;
  if (candidate.installedExecutable) {
    const findInstalled = options.findInstalled;
    return Boolean(findInstalled && findInstalled(candidate.installedExecutable));
  }
  if (candidate.key === 'chrome') return chromeExecutablePaths(options).some(existsSync);
  if (candidate.key === 'msedge') return edgeExecutablePaths(options).some(existsSync);
  if (candidate.key === 'chromium') return options.allowBundled !== false;
  return false;
}

export function pickGenerationBrowser(candidates, selection = 'auto', options = {}) {
  const wanted = String(selection || 'auto').trim().toLowerCase();
  const rng = typeof options.rng === 'function' ? options.rng : Math.random;
  if (wanted !== 'auto') {
    const exact = (Array.isArray(candidates) ? candidates : []).find(item => item.key === wanted);
    if (exact) return exact;
  }
  const installed = (Array.isArray(candidates) ? candidates : [])
    .filter(item => isGenerationBrowserInstalled(item, options));
  const real = installed.filter(item => item.key !== 'chromium');
  const pool = real.length ? real : installed;
  if (!pool.length) {
    return (Array.isArray(candidates) ? candidates : []).find(item => item.key === 'chromium') || null;
  }
  return pool[Math.max(0, Math.min(pool.length - 1, Math.floor(rng() * pool.length)))];
}

export async function generationLaunchOptions(selection, base = {}, options = {}) {
  const pool = await loadGenerationBrowserPool();
  const browser = pickGenerationBrowser(pool.SHAPE_BROWSER_CANDIDATES, selection, {
    ...options,
    findInstalled: options.findInstalled || pool.findInstalledBrowserExecutable,
  });
  if (!browser) throw new Error('No Chromium-based browser is available for Target generation');
  return {
    browser,
    launchOptions: pool.shapeBrowserLaunchOptions(browser, base),
  };
}
