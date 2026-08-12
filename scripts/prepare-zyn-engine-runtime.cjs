#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { engineRuntime, projectRoot, release } = require('./zyn-engine-runtime-lib.cjs');

const requested = String(process.argv[2] || 'all').toLowerCase();
const normalized = requested === 'windows' || requested === 'win-x64' ? 'windows-x64'
  : (requested === 'x86_64' ? 'x64' : requested);
const architectures = normalized === 'all' ? ['arm64', 'x64', 'windows-x64'] : [normalized];
if (architectures.some((arch) => !['arm64', 'x64', 'windows-x64'].includes(arch))) {
  console.error('Usage: node scripts/prepare-zyn-engine-runtime.cjs [arm64|x64|windows-x64|all]');
  process.exit(2);
}

const artifactsRoot = path.join(projectRoot, 'release', 'runtime-artifacts');
const stagingRoot = path.join(projectRoot, 'release', 'runtime-staging');
const notaryProfile = process.env.ZYN_NOTARY_PROFILE || 'flume-notary';
const identityName = process.env.ZYN_SIGNING_IDENTITY || 'thwebco, LLC (GXWBXH5M77)';
const identity = identityName.startsWith('Developer ID Application:')
  ? identityName : `Developer ID Application: ${identityName}`;

function run(command, args) {
  console.log(`$ ${command} ${args.map((arg) => JSON.stringify(arg)).join(' ')}`);
  execFileSync(command, args, { cwd: projectRoot, stdio: 'inherit' });
}

function infoPlist(arch) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>backend</string>
  <key>CFBundleIdentifier</key><string>com.thwebco.zyn.engine.${arch}</string>
  <key>CFBundleName</key><string>Zyn Engine</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${release.version}</string>
  <key>CFBundleVersion</key><string>${release.version}</string>
  <key>LSBackgroundOnly</key><true/>
</dict></plist>
`;
}

function notarizeAndStaple(appPath, arch) {
  const submission = path.join(stagingRoot, arch, `Zyn-Engine-${arch}-notarize.zip`);
  fs.rmSync(submission, { force: true });
  run('/usr/bin/ditto', ['-c', '-k', '--keepParent', appPath, submission]);
  run('/usr/bin/xcrun', ['notarytool', 'submit', submission, '--keychain-profile', notaryProfile, '--wait']);
  run('/usr/bin/xcrun', ['stapler', 'staple', appPath]);
  run('/usr/bin/xcrun', ['stapler', 'validate', appPath]);
  run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath]);
  fs.rmSync(submission, { force: true });
}

if (architectures.some((arch) => arch !== 'windows-x64')) {
  const identities = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
  if (!identities.includes(identity)) {
    throw new Error(`Missing signing identity: ${identity}. Import it before publishing an engine.`);
  }
}

fs.mkdirSync(artifactsRoot, { recursive: true });
for (const arch of architectures) {
  const item = engineRuntime(arch);
  const stage = path.join(stagingRoot, arch, 'engine-runtime');
  const engineRoot = path.join(stage, 'engine');
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(engineRoot, { recursive: true });

  if (arch === 'windows-x64') {
    fs.copyFileSync(item.source, path.join(engineRoot, 'backend.exe'));
  } else {
    const appPath = path.join(engineRoot, 'Zyn Engine.app');
    const macos = path.join(appPath, 'Contents', 'MacOS');
    fs.mkdirSync(macos, { recursive: true });
    fs.writeFileSync(path.join(appPath, 'Contents', 'Info.plist'), infoPlist(arch));
    const executable = path.join(macos, 'backend');
    fs.copyFileSync(item.source, executable);
    fs.chmodSync(executable, 0o755);
    run(process.execPath, [path.join(__dirname, 'sign-zyn-runtime.cjs'), appPath]);
    notarizeAndStaple(appPath, arch);
  }

  const archive = path.join(artifactsRoot, item.archive);
  fs.rmSync(archive, { force: true });
  run('/usr/bin/tar', [item.format === 'tar.gz' ? '-czf' : '-cJf', archive, '-C', stage, 'engine']);
  console.log(`Prepared ${item.archive} (${(fs.statSync(archive).size / 1048576).toFixed(1)} MiB)`);
}

console.log(`Zyn engine ${release.version} runtime artifacts are ready for manifest signing.`);
