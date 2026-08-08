#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { MANIFEST_PUBLIC_KEY, MANIFEST_PATH } = require('../launcher/runtime-manager');

const projectRoot = path.join(__dirname, '..');
const contract = require(path.join(projectRoot, 'config', 'runtime-contract.json'));
const artifactsRoot = path.join(projectRoot, 'release', 'runtime-artifacts');
const manifestName = path.basename(MANIFEST_PATH);
const keychainService = 'com.thwebco.zyn.runtime-signing';
const keychainAccount = 'manifest-private-key';
const playwrightVersion = '1.61.0';
const chromiumRevision = '1228';
const wineName = 'wine-stable-11.0_1-macos-x64.tar.xz';
const engineSourceSha256 = contract.immutableResources
  .find(item => item.path.endsWith('/engine/backend.exe'))?.sha256;
const engineName = `checkout-engine-${engineSourceSha256.slice(0, 16)}-windows-x64.tar.gz`;

function chromiumName(arch) {
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
const wine = fileInfo(wineName);
const engine = fileInfo(engineName);

function chromium(arch, info) {
  const folder = arch === 'x64' ? 'chrome-mac-x64' : 'chrome-mac-arm64';
  const archive = chromiumName(arch);
  return {
    label: 'Chromium',
    version: `playwright-${playwrightVersion}-chromium-${chromiumRevision}`,
    archive,
    url: `/runtimes/${archive}`,
    size: info.size,
    sha256: info.sha256,
    root: 'ms-playwright',
    entry: `ms-playwright/chromium-${chromiumRevision}/${folder}/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
    verify: `ms-playwright/chromium-${chromiumRevision}/${folder}/Google Chrome for Testing.app`,
    format: 'tar.xz',
  };
}

function wineItem(requiresRosetta) {
  return {
    label: 'Wine',
    version: '11.0_1',
    archive: wineName,
    url: `/runtimes/${wineName}`,
    size: wine.size,
    sha256: wine.sha256,
    entry: 'Wine Stable.app/Contents/Resources/wine/bin/wine',
    verify: 'Wine Stable.app',
    format: 'tar.xz',
    ...(requiresRosetta ? { requiresRosetta: true } : {}),
  };
}

const payload = {
  generatedAt: new Date().toISOString(),
  platforms: {
    'darwin-arm64': { chromium: chromium('arm64', chromiumArm), wine: wineItem(true) },
    'darwin-x64': { chromium: chromium('x64', chromiumX64), wine: wineItem(false) },
  },
  engine: {
    label: 'Checkout engine',
    version: `sha256-${engineSourceSha256.slice(0, 16)}`,
    archive: engineName,
    url: `/runtimes/${engineName}`,
    size: engine.size,
    sha256: engine.sha256,
    sourceSha256: engineSourceSha256,
    entry: 'engine/backend.exe',
    verify: 'engine/backend.exe',
    format: 'tar.gz',
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
console.log(`ARM runtime ${(chromiumArm.size + wine.size + engine.size) / 1048576 | 0} MiB`);
console.log(`Intel runtime ${(chromiumX64.size + wine.size + engine.size) / 1048576 | 0} MiB`);
