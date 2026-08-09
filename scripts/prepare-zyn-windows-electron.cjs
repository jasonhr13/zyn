#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Readable } = require('stream');
const { finished } = require('stream/promises');

const projectRoot = path.join(__dirname, '..');
const electronVersion = '43.3.0';
const archiveName = `electron-v${electronVersion}-win32-x64.zip`;
const checksums = fs.readFileSync(
  path.join(projectRoot, 'vendor', `electron-v${electronVersion}-SHASUMS256.txt`),
  'utf8',
);
const match = checksums.match(new RegExp(`^([a-f0-9]{64}) \\*${archiveName.replaceAll('.', '\\.')}\\s*$`, 'm'));
if (!match) throw new Error(`No pinned SHA-256 is available for ${archiveName}.`);
const expectedSha256 = match[1];
const destination = path.join(projectRoot, 'vendor', `electron-v${electronVersion}-win32-x64`);
const marker = path.join(destination, '.zyn-source.sha256');

if (fs.existsSync(path.join(destination, 'electron.exe'))
  && fs.existsSync(marker)
  && fs.readFileSync(marker, 'utf8').trim() === expectedSha256) {
  console.log(destination);
  process.exit(0);
}

async function main() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'zyn-electron-win-'));
  try {
    const archive = path.join(temporary, archiveName);
    const url = `https://github.com/electron/electron/releases/download/v${electronVersion}/${archiveName}`;
    console.log(`Downloading ${url}`);
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok || !response.body) throw new Error(`Electron download failed: HTTP ${response.status}`);
    const stream = fs.createWriteStream(archive, { mode: 0o600 });
    Readable.fromWeb(response.body).pipe(stream);
    await finished(stream);

    const actualSha256 = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
    if (actualSha256 !== expectedSha256) {
      throw new Error(`Electron SHA-256 mismatch: expected ${expectedSha256}, received ${actualSha256}.`);
    }

    const extracted = path.join(temporary, 'runtime');
    fs.mkdirSync(extracted);
    execFileSync('/usr/bin/unzip', ['-q', archive, '-d', extracted], { stdio: 'inherit' });
    if (!fs.existsSync(path.join(extracted, 'electron.exe'))) {
      throw new Error('The verified Electron archive did not contain electron.exe.');
    }
    fs.rmSync(destination, { recursive: true, force: true });
    fs.cpSync(extracted, destination, { recursive: true });
    fs.writeFileSync(marker, `${expectedSha256}\n`, { mode: 0o644 });
    console.log(destination);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
