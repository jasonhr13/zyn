#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const projectRoot = path.join(__dirname, '..');
const contract = require(path.join(projectRoot, 'config', 'runtime-contract.json'));
const requestedArch = String(process.argv[2] || '').toLowerCase();
const arch = requestedArch === 'x86_64' ? 'x64' : requestedArch;
if (!['arm64', 'x64'].includes(arch)) {
  console.error('Usage: node scripts/release-zyn-macos.cjs <arm64|x64>');
  process.exit(2);
}

const version = contract.product.version;
const identityName = process.env.ZYN_SIGNING_IDENTITY || 'thwebco, LLC (GXWBXH5M77)';
const identity = identityName.startsWith('Developer ID Application:')
  ? identityName
  : `Developer ID Application: ${identityName}`;
const notaryProfile = process.env.ZYN_NOTARY_PROFILE || 'flume-notary';
const inputApp = path.join(projectRoot, 'dist', `Zyn-mac-${arch}.app`);
const workRoot = path.join(projectRoot, 'release', 'work', arch);
const workApp = path.join(workRoot, 'Zyn.app');
const outputRoot = path.join(projectRoot, 'release', 'dist', arch);
const zipName = `Zyn-${version}-${arch}.zip`;
const dmgName = `Zyn-${version}-${arch}.dmg`;
const zipPath = path.join(outputRoot, zipName);
const dmgPath = path.join(outputRoot, dmgName);
const metadataPath = path.join(outputRoot, 'latest-mac.yml');

function run(command, args, options = {}) {
  console.log(`$ ${command} ${args.map(value => JSON.stringify(value)).join(' ')}`);
  return execFileSync(command, args, { stdio: 'inherit', ...options });
}

if (!fs.existsSync(inputApp)) throw new Error(`Missing ${inputApp}; build ${arch} first.`);
const inputReceipt = JSON.parse(fs.readFileSync(
  path.join(inputApp, 'Contents', 'Resources', 'zyn-build.json'),
  'utf8',
));
if (inputReceipt.runtime?.delivery !== 'remote') {
  throw new Error(`Refusing to release a ${inputReceipt.runtime?.delivery || 'legacy'} runtime build. Rebuild ${arch} with ZYN_RUNTIME_MODE=remote.`);
}
const identities = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
if (!identities.includes(identity)) {
  throw new Error(`Missing signing identity: ${identity}. Import its certificate and private key into this Mac's login keychain.`);
}
if ((fs.existsSync(outputRoot) || fs.existsSync(workRoot)) && process.env.ZYN_OVERWRITE_RELEASE !== '1') {
  throw new Error(`Release staging already exists for ${arch}. Inspect it, then rerun with ZYN_OVERWRITE_RELEASE=1 to replace generated release files.`);
}

fs.rmSync(workRoot, { recursive: true, force: true });
fs.rmSync(outputRoot, { recursive: true, force: true });
fs.mkdirSync(workRoot, { recursive: true });
fs.mkdirSync(outputRoot, { recursive: true });
run('/bin/cp', ['-cR', inputApp, workApp]);

run(process.execPath, [path.join(__dirname, 'sign-zyn-bundle.cjs'), workApp]);

const notaryArchive = path.join(workRoot, `Zyn-${arch}-notarize.zip`);
run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', workApp, notaryArchive]);
run('/usr/bin/xcrun', ['notarytool', 'submit', notaryArchive, '--keychain-profile', notaryProfile, '--wait']);
run('/usr/bin/xcrun', ['stapler', 'staple', workApp]);
run('/usr/bin/xcrun', ['stapler', 'validate', workApp]);
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', workApp]);
run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', workApp]);

run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', workApp, zipPath]);

const dmgStage = fs.mkdtempSync(path.join(os.tmpdir(), `zyn-${arch}-dmg-`));
try {
  run('/bin/cp', ['-cR', workApp, path.join(dmgStage, 'Zyn.app')]);
  fs.symlinkSync('/Applications', path.join(dmgStage, 'Applications'));
  run('/usr/bin/hdiutil', [
    'create', '-fs', 'HFS+', '-format', 'UDZO', '-volname', 'Zyn',
    '-srcfolder', dmgStage, dmgPath,
  ]);
} finally {
  fs.rmSync(dmgStage, { recursive: true, force: true });
}
run('/usr/bin/xcrun', ['notarytool', 'submit', dmgPath, '--keychain-profile', notaryProfile, '--wait']);
run('/usr/bin/xcrun', ['stapler', 'staple', dmgPath]);
run('/usr/bin/xcrun', ['stapler', 'validate', dmgPath]);
run('/usr/bin/hdiutil', ['verify', dmgPath]);

function artifact(file, name) {
  const data = fs.readFileSync(file);
  return {
    name,
    size: data.length,
    sha512: crypto.createHash('sha512').update(data).digest('base64'),
  };
}

const zip = artifact(zipPath, zipName);
const dmg = artifact(dmgPath, dmgName);
const metadata = [
  `version: ${version}`,
  'files:',
  `  - url: ${zip.name}`,
  `    sha512: ${zip.sha512}`,
  `    size: ${zip.size}`,
  `  - url: ${dmg.name}`,
  `    sha512: ${dmg.sha512}`,
  `    size: ${dmg.size}`,
  `path: ${zip.name}`,
  `sha512: ${zip.sha512}`,
  `releaseDate: '${new Date().toISOString()}'`,
  '',
].join('\n');
fs.writeFileSync(metadataPath, metadata, { mode: 0o644 });
run(process.execPath, [path.join(__dirname, 'verify-zyn-macos-release.cjs'), arch]);
console.log(`Zyn ${version} ${arch} is signed, notarized, stapled, and ready to upload from ${outputRoot}`);
