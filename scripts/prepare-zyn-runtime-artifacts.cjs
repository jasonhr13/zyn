#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const projectRoot = path.join(__dirname, '..');
const contract = require(path.join(projectRoot, 'config', 'runtime-contract.json'));
const requested = String(process.argv[2] || 'all').toLowerCase();
const architectures = requested === 'all' ? ['arm64', 'x64'] : [requested === 'x86_64' ? 'x64' : requested];
if (architectures.some(arch => !['arm64', 'x64'].includes(arch))) {
  console.error('Usage: node scripts/prepare-zyn-runtime-artifacts.cjs [arm64|x64|all]');
  process.exit(2);
}

const artifactsRoot = path.join(projectRoot, 'release', 'runtime-artifacts');
const stagingRoot = path.join(projectRoot, 'release', 'runtime-staging');
const notaryProfile = process.env.ZYN_NOTARY_PROFILE || 'flume-notary';
const identityName = process.env.ZYN_SIGNING_IDENTITY || 'thwebco, LLC (GXWBXH5M77)';
const identity = identityName.startsWith('Developer ID Application:')
  ? identityName
  : `Developer ID Application: ${identityName}`;
const playwrightVersion = '1.61.0';
const chromiumRevision = '1228';
const wineName = 'wine-stable-11.0_1-macos-x64.tar.xz';
const wineUrl = `https://updates.rcart.app/runtimes/${wineName}`;
const wineSha256 = 'b84ecd14bfb23929b195c874cc2ae45c9218dc7fed002af8c0d108774c9677f9';
const wineSize = 204981544;

function run(command, args, options = {}) {
  console.log(`$ ${command} ${args.map(arg => JSON.stringify(arg)).join(' ')}`);
  execFileSync(command, args, { cwd: projectRoot, stdio: 'inherit', ...options });
}

function sha256(file) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
  try {
    let read = 0;
    do {
      read = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (read) hash.update(buffer.subarray(0, read));
    } while (read);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

function notarizeAndStaple(appPath, arch) {
  const archive = path.join(stagingRoot, arch, `Chromium-${arch}-notarize.zip`);
  fs.rmSync(archive, { force: true });
  run('/usr/bin/ditto', ['-c', '-k', '--keepParent', appPath, archive]);
  run('/usr/bin/xcrun', ['notarytool', 'submit', archive, '--keychain-profile', notaryProfile, '--wait']);
  run('/usr/bin/xcrun', ['stapler', 'staple', appPath]);
  run('/usr/bin/xcrun', ['stapler', 'validate', appPath]);
  run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath]);
  fs.rmSync(archive, { force: true });
}

const identities = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
if (!identities.includes(identity)) {
  throw new Error(`Missing signing identity: ${identity}. Import its certificate and private key into this Mac's login keychain.`);
}

fs.mkdirSync(artifactsRoot, { recursive: true });

for (const arch of architectures) {
  const sourceRoot = path.join(projectRoot, 'vendor', `ms-playwright-mac-${arch}`);
  const chromiumSource = path.join(sourceRoot, `chromium-${chromiumRevision}`);
  if (!fs.existsSync(chromiumSource)) throw new Error(`Missing native Chromium source: ${chromiumSource}`);
  const archFolder = arch === 'x64' ? 'chrome-mac-x64' : 'chrome-mac-arm64';
  const stage = path.join(stagingRoot, arch, 'chromium');
  const destination = path.join(stage, 'ms-playwright', `chromium-${chromiumRevision}`);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  // Node resolves copied symlink targets to absolute source paths unless verbatimSymlinks is set.
  // A macOS framework requires its conventional relative Versions/Current links; absolute links
  // escape the staged framework and codesign rejects it as having unsealed root contents.
  fs.cpSync(chromiumSource, destination, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
  });
  const chromeApp = path.join(destination, archFolder, 'Google Chrome for Testing.app');
  if (!fs.existsSync(chromeApp)) throw new Error(`Chromium app is missing: ${chromeApp}`);
  run(process.execPath, [path.join(__dirname, 'sign-zyn-runtime.cjs'), chromeApp]);
  notarizeAndStaple(chromeApp, arch);

  const archiveName = `chromium-playwright-${playwrightVersion}-${chromiumRevision}-macos-${arch}.tar.xz`;
  const archive = path.join(artifactsRoot, archiveName);
  fs.rmSync(archive, { force: true });
  run('/usr/bin/tar', ['-cJf', archive, '-C', stage, 'ms-playwright']);
  console.log(`Prepared ${archiveName} (${(fs.statSync(archive).size / 1048576).toFixed(1)} MiB)`);
}

const wineArchive = path.join(artifactsRoot, wineName);
if (!fs.existsSync(wineArchive) || fs.statSync(wineArchive).size !== wineSize || sha256(wineArchive) !== wineSha256) {
  fs.rmSync(wineArchive, { force: true });
  run('/usr/bin/curl', ['--fail', '--location', '--show-error', wineUrl, '-o', wineArchive]);
}
if (fs.statSync(wineArchive).size !== wineSize || sha256(wineArchive) !== wineSha256) {
  throw new Error('The established signed Wine archive failed its pinned size/SHA-256 check.');
}

const engineSource = path.join(projectRoot, 'dist', 'Zyn-Runtime-Base.app', 'Contents', 'Resources', 'engine', 'backend.exe');
const expectedBackend = contract.immutableResources.find(item => item.path.endsWith('/engine/backend.exe'))?.sha256;
if (!fs.existsSync(engineSource) || sha256(engineSource) !== expectedBackend) {
  throw new Error('The runtime base backend.exe does not match the frozen Zyn contract.');
}
const engineStage = path.join(stagingRoot, 'engine');
fs.rmSync(engineStage, { recursive: true, force: true });
fs.mkdirSync(path.join(engineStage, 'engine'), { recursive: true });
fs.copyFileSync(engineSource, path.join(engineStage, 'engine', 'backend.exe'));
const engineName = `checkout-engine-${expectedBackend.slice(0, 16)}-windows-x64.tar.gz`;
const engineArchive = path.join(artifactsRoot, engineName);
fs.rmSync(engineArchive, { force: true });
run('/usr/bin/tar', ['-czf', engineArchive, '-C', engineStage, 'engine']);
console.log(`Prepared ${engineName} (${(fs.statSync(engineArchive).size / 1048576).toFixed(1)} MiB)`);
console.log('Zyn runtime artifacts are ready for manifest signing.');
