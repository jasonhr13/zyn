#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  EXPECTED_ENGINE_PROTOCOL,
  MANIFEST_PUBLIC_KEY,
  MANIFEST_PATH,
} = require('../launcher/runtime-manager');
const { engineRuntime } = require('./zyn-engine-runtime-lib.cjs');

const projectRoot = path.join(__dirname, '..');
const artifactsRoot = path.join(projectRoot, 'release', 'runtime-artifacts');
const manifestName = path.basename(MANIFEST_PATH);
const keychainService = 'com.thwebco.zyn.runtime-signing';
const keychainAccount = 'manifest-private-key';
const playwrightVersion = '1.61.0';
const chromiumRevision = '1228';

function chromiumName(arch) {
  if (arch === 'windows-x64') {
    return `chromium-playwright-${playwrightVersion}-${chromiumRevision}-windows-x64.tar.gz`;
  }
  return `chromium-playwright-${playwrightVersion}-${chromiumRevision}-macos-${arch}.tar.xz`;
}

function fileInfo(name) {
  const file = path.join(artifactsRoot, name);
  if (!fs.existsSync(file)) throw new Error(`Missing runtime artifact: ${file}`);
  const body = fs.readFileSync(file);
  return { size: body.length, sha256: crypto.createHash('sha256').update(body).digest('hex') };
}

let privateKeyValue;
try {
  privateKeyValue = execFileSync('security', [
    'find-generic-password', '-a', keychainAccount, '-s', keychainService, '-w',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
} catch {
  console.error(`Zyn runtime signing key is missing from Keychain service ${keychainService}.`);
  console.error('Do not publish an unsigned manifest. Provision or recover the key first.');
  process.exit(1);
}

const privateKey = crypto.createPrivateKey({
  key: Buffer.from(privateKeyValue, 'base64'),
  format: 'der',
  type: 'pkcs8',
});
const actualPublicKey = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).trim();
if (actualPublicKey !== MANIFEST_PUBLIC_KEY.trim()) {
  throw new Error('The Keychain runtime signing key does not match the public key embedded in Zyn.');
}
if (process.argv.includes('--verify-key')) {
  const publicDer = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const fingerprint = crypto.createHash('sha256').update(publicDer).digest('hex');
  console.log(`Zyn runtime signing key matches the embedded public key (${fingerprint}).`);
  process.exit(0);
}

const chromiumArm = fileInfo(chromiumName('arm64'));
const chromiumX64 = fileInfo(chromiumName('x64'));
const chromiumWindowsX64 = fileInfo(chromiumName('windows-x64'));

function chromium(arch, info) {
  const windows = arch === 'windows-x64';
  const folder = windows ? 'chrome-win64' : (arch === 'x64' ? 'chrome-mac-x64' : 'chrome-mac-arm64');
  const archive = chromiumName(arch);
  return {
    label: 'Chromium',
    version: `playwright-${playwrightVersion}-chromium-${chromiumRevision}`,
    archive,
    url: `/runtimes/${archive}`,
    size: info.size,
    sha256: info.sha256,
    root: 'ms-playwright',
    entry: windows
      ? `ms-playwright/chromium-${chromiumRevision}/${folder}/chrome.exe`
      : `ms-playwright/chromium-${chromiumRevision}/${folder}/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
    verify: windows
      ? `ms-playwright/chromium-${chromiumRevision}/${folder}/chrome.exe`
      : `ms-playwright/chromium-${chromiumRevision}/${folder}/Google Chrome for Testing.app`,
    format: windows ? 'tar.gz' : 'tar.xz',
  };
}

function engine(arch) {
  const runtime = engineRuntime(arch);
  if (runtime.protocol !== EXPECTED_ENGINE_PROTOCOL) {
    throw new Error(`Engine protocol ${runtime.protocol} does not match desktop protocol ${EXPECTED_ENGINE_PROTOCOL}.`);
  }
  const info = fileInfo(runtime.archive);
  return {
    label: 'Checkout Engine',
    version: runtime.version,
    protocol: runtime.protocol,
    archive: runtime.archive,
    url: `/runtimes/${runtime.archive}`,
    size: info.size,
    sha256: info.sha256,
    sourceSha256: runtime.sourceSha256,
    entry: runtime.entry,
    verify: runtime.verify,
    format: runtime.format,
  };
}

const payload = {
  generatedAt: new Date().toISOString(),
  platforms: {
    'darwin-arm64': { chromium: chromium('arm64', chromiumArm), engine: engine('arm64') },
    'darwin-x64': { chromium: chromium('x64', chromiumX64), engine: engine('x64') },
    'win32-x64': { chromium: chromium('windows-x64', chromiumWindowsX64), engine: engine('windows-x64') },
  },
};
const document = {
  schema: 1,
  payload,
  signature: crypto.sign(null, Buffer.from(JSON.stringify(payload)), privateKey).toString('base64'),
};
const output = path.join(artifactsRoot, manifestName);
fs.writeFileSync(output, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
console.log(`Signed Zyn runtime manifest: ${output}`);
console.log(`ARM runtime ${chromiumArm.size / 1048576 | 0} MiB`);
console.log(`Intel runtime ${chromiumX64.size / 1048576 | 0} MiB`);
console.log(`Windows runtime ${chromiumWindowsX64.size / 1048576 | 0} MiB`);
