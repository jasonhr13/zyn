import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Browser selection for the Shape farmer. Fixed worker leases are distributed round-robin across
// the detected pool; a low route ceiling still rotates through every proven channel.
export const SHAPE_BROWSER_CANDIDATES = Object.freeze([
  Object.freeze({ key: 'chrome', label: 'Chrome', channel: 'chrome' }),
  Object.freeze({ key: 'msedge', label: 'Edge', channel: 'msedge' }),
  // Playwright does not expose a Brave channel. We find Brave's installed executable and launch it
  // through the explicit Chromium channel so headless runs use the full browser's New Headless.
  Object.freeze({ key: 'brave', label: 'Brave', channel: 'chromium', installedExecutable: 'brave' }),
  Object.freeze({ key: 'vivaldi', label: 'Vivaldi', channel: 'chromium', installedExecutable: 'vivaldi' }),
  Object.freeze({ key: 'yandex', label: 'Yandex', channel: 'chromium', installedExecutable: 'yandex' }),
  Object.freeze({ key: 'chromium', label: 'Chromium', channel: 'chromium' }),
]);

export function braveExecutablePaths({
  platform = process.platform,
  env = process.env,
  homeDir = os.homedir(),
} = {}) {
  if (platform === 'darwin') {
    return [
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      path.join(homeDir, 'Applications', 'Brave Browser.app', 'Contents', 'MacOS', 'Brave Browser'),
    ];
  }
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local');
    const programFiles = env.ProgramFiles || env.PROGRAMFILES || 'C:\\Program Files';
    const programFilesX86 = env['ProgramFiles(x86)'] || env.PROGRAMFILES_X86 || 'C:\\Program Files (x86)';
    return [localAppData, programFiles, programFilesX86]
      .map(root => path.win32.join(root, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'));
  }
  if (platform === 'linux') {
    return [
      '/usr/bin/brave-browser',
      '/usr/bin/brave',
      '/opt/brave.com/brave/brave-browser',
      '/snap/bin/brave',
    ];
  }
  return [];
}

export function findBraveExecutable(options = {}) {
  const existsSync = options.existsSync || fs.existsSync;
  return braveExecutablePaths(options).find(candidate => existsSync(candidate)) || '';
}

export function installedBrowserExecutablePaths(name, options = {}) {
  if (name === 'brave') return braveExecutablePaths(options);

  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const homeDir = options.homeDir || os.homedir();
  if (platform === 'darwin') {
    const macExecutables = {
      vivaldi: ['Vivaldi.app', 'Vivaldi'],
      yandex: ['Yandex.app', 'Yandex'],
    };
    const executable = macExecutables[name];
    if (!executable) return [];

    const [appName, executableName] = executable;
    return [
      path.join('/Applications', appName, 'Contents', 'MacOS', executableName),
      path.join(homeDir, 'Applications', appName, 'Contents', 'MacOS', executableName),
    ];
  }

  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || path.win32.join(homeDir, 'AppData', 'Local');
    const programFiles = env.ProgramFiles || env.PROGRAMFILES || 'C:\\Program Files';
    const programFilesX86 = env['ProgramFiles(x86)'] || env.PROGRAMFILES_X86 || 'C:\\Program Files (x86)';
    if (name === 'vivaldi') {
      return [localAppData, programFiles, programFilesX86]
        .map(root => path.win32.join(root, 'Vivaldi', 'Application', 'vivaldi.exe'));
    }
    if (name === 'yandex') {
      return [localAppData, programFiles, programFilesX86]
        .map(root => path.win32.join(root, 'Yandex', 'YandexBrowser', 'Application', 'browser.exe'));
    }
  }

  return [];
}

export function findInstalledBrowserExecutable(name, options = {}) {
  const existsSync = options.existsSync || fs.existsSync;
  return installedBrowserExecutablePaths(name, options)
    .find(candidate => existsSync(candidate)) || '';
}

// Supplying an explicit channel is important for every browser. With headless: true, Chrome and
// Edge use their regular browser's New Headless implementation; installed Chromium-family browsers
// and bundled Chromium use the explicit Chromium channel instead of the headless-shell binary.
export function shapeBrowserLaunchOptions(
  browser,
  base = {},
  findInstalledExecutable = findInstalledBrowserExecutable,
) {
  const options = { ...base, channel: browser.channel };
  if (browser.installedExecutable) {
    const executablePath = findInstalledExecutable(browser.installedExecutable);
    if (!executablePath) throw new Error(`${browser.label} is not installed`);
    options.executablePath = executablePath;
  }
  return options;
}

export function shapeBrowserCandidates(selection = 'auto') {
  return selection === 'chromium'
    ? SHAPE_BROWSER_CANDIDATES.filter(candidate => candidate.key === 'chromium')
    : SHAPE_BROWSER_CANDIDATES;
}

export async function detectShapeBrowsers(
  launch,
  onUnavailable = () => {},
  selection = 'auto',
  findInstalledExecutable = findInstalledBrowserExecutable,
) {
  const detected = [];
  for (const candidate of shapeBrowserCandidates(selection)) {
    let probe = null;
    try {
      probe = await launch(shapeBrowserLaunchOptions(candidate, { headless: true }, findInstalledExecutable));
      await probe.close();
      probe = null;
      detected.push(candidate);
    } catch (error) {
      if (probe) await probe.close().catch(() => {});
      onUnavailable(candidate, error);
    }
  }
  return detected;
}

export function distributeShapeWorkerBrowsers(detected, workerCount) {
  if (!detected.length) return [];
  const count = Math.max(0, Math.floor(Number(workerCount) || 0));
  return Array.from({ length: count }, (_, index) => detected[index % detected.length]);
}

// Scheduler slots are idle loops, not concurrent browsers. Keeping one for every detected channel
// lets a low concurrency ceiling rotate across the whole proven browser pool.
export function shapeBrowserSchedulerSlotCount(detected, hardLimit) {
  const detectedCount = Array.isArray(detected)
    ? detected.length
    : Math.max(0, Math.floor(Number(detected) || 0));
  if (!detectedCount) return 0;
  return Math.max(detectedCount, Math.max(1, Math.floor(Number(hardLimit) || 1)));
}
