#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const projectRoot = path.join(__dirname, '..');
const requested = String(process.argv[2] || 'all').toLowerCase();
const normalized = requested === 'windows' || requested === 'win-x64' ? 'windows-x64'
  : (requested === 'x86_64' ? 'x64' : requested);
const architectures = normalized === 'all' ? ['arm64', 'x64', 'windows-x64'] : [normalized];
if (architectures.some(arch => !['arm64', 'x64', 'windows-x64'].includes(arch))) {
  console.error('Usage: node scripts/prepare-zyn-runtime-artifacts.cjs [arm64|x64|windows-x64|all]');
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

function run(command, args, options = {}) {
  console.log(`$ ${command} ${args.map(arg => JSON.stringify(arg)).join(' ')}`);
  execFileSync(command, args, { cwd: projectRoot, stdio: 'inherit', ...options });
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

if (architectures.some(arch => arch !== 'windows-x64')) {
  const identities = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
  if (!identities.includes(identity)) {
    throw new Error(`Missing signing identity: ${identity}. Import its certificate and private key into this Mac's login keychain.`);
  }
}

fs.mkdirSync(artifactsRoot, { recursive: true });

for (const arch of architectures) {
  if (arch === 'windows-x64') {
    const source = path.join(
      projectRoot,
      'dist',
      'Zyn-Runtime-Base.app',
      'Contents',
      'Resources',
      'vendor',
      'ms-playwright',
      `chromium-${chromiumRevision}`,
    );
    const stage = path.join(stagingRoot, arch, 'chromium');
    const destination = path.join(stage, 'ms-playwright', `chromium-${chromiumRevision}`);
    if (!fs.existsSync(path.join(source, 'chrome-win64', 'chrome.exe'))) {
      throw new Error(`Missing Windows Chromium source: ${source}`);
    }
    fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(source, destination, { recursive: true });
    const archiveName = `chromium-playwright-${playwrightVersion}-${chromiumRevision}-windows-x64.tar.gz`;
    const archive = path.join(artifactsRoot, archiveName);
    fs.rmSync(archive, { force: true });
    run('/usr/bin/tar', ['-czf', archive, '-C', stage, 'ms-playwright']);
    console.log(`Prepared ${archiveName} (${(fs.statSync(archive).size / 1048576).toFixed(1)} MiB)`);
    continue;
  }

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

console.log('Zyn Chromium runtime artifacts are ready for manifest signing.');
