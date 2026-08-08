#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  console.error(`Native farmer runtime requires darwin-arm64; received ${process.platform}-${process.arch}`);
  process.exit(1);
}

const project = path.resolve(__dirname, '..');
const browserRoot = path.join(project, 'vendor', 'ms-playwright-mac-arm64');
const playwrightCli = path.join(project, 'extracted', 'app', 'resources', 'node_modules', 'playwright', 'cli.js');
if (!fs.existsSync(playwrightCli)) {
  console.error(`Missing recovered Playwright CLI: ${playwrightCli}`);
  process.exit(1);
}

fs.mkdirSync(browserRoot, { recursive: true });
const result = spawnSync(process.execPath, [playwrightCli, 'install', 'chromium'], {
  cwd: project,
  env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browserRoot },
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
console.log(JSON.stringify({ ok: true, browserRoot, chromium: entries, headlessShellBundled: false }, null, 2));
