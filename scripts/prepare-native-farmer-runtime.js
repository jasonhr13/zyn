#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const project = path.resolve(__dirname, '..');
const requestedArch = String(process.env.ZYN_ARCH || (process.platform === 'win32' ? 'windows-x64' : process.arch)).toLowerCase();
const runtimeArch = requestedArch === 'x86_64' ? 'x64' : requestedArch;
if (!['arm64', 'x64', 'windows-x64'].includes(runtimeArch)) {
  console.error(`Unsupported native farmer architecture: ${runtimeArch}`);
  process.exit(1);
}
const browserRoot = path.join(project, 'vendor', runtimeArch === 'windows-x64'
  ? 'ms-playwright-windows-x64'
  : `ms-playwright-mac-${runtimeArch}`);
const playwrightCli = path.join(project, 'bot-runtime', 'node_modules', 'playwright', 'cli.js');
if (!fs.existsSync(playwrightCli)) {
  console.error(`Missing bot-runtime Playwright CLI: ${playwrightCli}. Run npm ci in bot-runtime/.`);
  process.exit(1);
}

fs.mkdirSync(browserRoot, { recursive: true });
const x64Electron = path.join(project, 'vendor', 'electron-v43.3.0-darwin-x64', 'Electron.app', 'Contents', 'MacOS', 'Electron');
const runtimeExecutable = runtimeArch === 'x64' && process.arch !== 'x64' ? x64Electron : process.execPath;
if (!fs.existsSync(runtimeExecutable)) {
  console.error(`Missing ${runtimeArch} Node-compatible runtime: ${runtimeExecutable}`);
  process.exit(1);
}
const result = spawnSync(runtimeExecutable, [playwrightCli, 'install', 'chromium'], {
  cwd: project,
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: runtimeExecutable === x64Electron ? '1' : process.env.ELECTRON_RUN_AS_NODE,
    PLAYWRIGHT_HOST_PLATFORM_OVERRIDE: runtimeArch === 'windows-x64'
      ? 'win64'
      : (runtimeArch === 'x64' ? 'mac26' : process.env.PLAYWRIGHT_HOST_PLATFORM_OVERRIDE),
    PLAYWRIGHT_BROWSERS_PATH: browserRoot,
  },
  stdio: 'inherit',
});
if (result.status !== 0) process.exit(result.status || 1);

const entries = fs.readdirSync(browserRoot).filter(name => name.startsWith('chromium-'));
if (!entries.length) {
  console.error('Playwright completed without installing regular Chromium.');
  process.exit(1);
}
// `channel: 'chromium'` is enforced and verified, so New Headless uses the regular browser above.
// Playwright also downloads its legacy headless-shell product; it is intentionally not bundled.
for (const name of fs.readdirSync(browserRoot).filter(entry => entry.startsWith('chromium_headless_shell-'))) {
  fs.rmSync(path.join(browserRoot, name), { recursive: true, force: true });
}
console.log(JSON.stringify({ ok: true, arch: runtimeArch, browserRoot, chromium: entries, headlessShellBundled: false }, null, 2));
