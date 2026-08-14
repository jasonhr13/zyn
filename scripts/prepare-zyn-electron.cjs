#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Readable } = require('node:stream');
const { finished } = require('node:stream/promises');

const project = path.resolve(__dirname, '..');
const contract = require(path.join(project, 'config', 'electron-runtime.json'));
const requested = process.argv[2] || (process.platform === 'win32'
  ? 'windows-x64'
  : (process.arch === 'arm64' ? 'arm64' : 'x64'));
const targets = requested === 'all' ? Object.keys(contract.platforms) : [requested];

for (const target of targets) {
  if (!contract.platforms[target]) {
    console.error(`Unsupported Electron runtime ${target}; expected ${Object.keys(contract.platforms).join(', ')}, or all.`);
    process.exit(2);
  }
}

async function download(target) {
  const item = contract.platforms[target];
  const destination = path.join(project, 'vendor', item.destination);
  const marker = path.join(destination, '.zyn-source.sha256');
  const executable = path.join(destination, item.executable);
  if (fs.existsSync(executable)
    && fs.existsSync(marker)
    && fs.readFileSync(marker, 'utf8').trim() === item.sha256) {
    console.log(destination);
    return;
  }

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), `zyn-electron-${target}-`));
  try {
    const archive = path.join(temporary, item.archive);
    const url = `${contract.releaseBaseUrl}/v${contract.version}/${item.archive}`;
    console.log(`Downloading ${url}`);
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok || !response.body) throw new Error(`Electron download failed: HTTP ${response.status}`);
    const stream = fs.createWriteStream(archive, { mode: 0o600 });
    Readable.fromWeb(response.body).pipe(stream);
    await finished(stream);

    const actual = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
    if (actual !== item.sha256) {
      throw new Error(`Electron SHA-256 mismatch for ${item.archive}: expected ${item.sha256}, received ${actual}.`);
    }

    const extracted = path.join(temporary, 'runtime');
    fs.mkdirSync(extracted);
    execFileSync('/usr/bin/unzip', ['-q', archive, '-d', extracted], { stdio: 'inherit' });
    if (!fs.existsSync(path.join(extracted, item.executable))) {
      throw new Error(`The verified Electron archive did not contain ${item.executable}.`);
    }
    fs.rmSync(destination, { recursive: true, force: true });
    fs.cpSync(extracted, destination, { recursive: true });
    fs.writeFileSync(marker, `${item.sha256}\n`, { mode: 0o644 });
    console.log(destination);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

(async () => {
  for (const target of targets) await download(target);
})().catch(error => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
