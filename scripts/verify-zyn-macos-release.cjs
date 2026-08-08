#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const projectRoot = path.join(__dirname, '..');
const contract = require(path.join(projectRoot, 'config', 'runtime-contract.json'));
const requestedArch = String(process.argv[2] || '').toLowerCase();
const arch = requestedArch === 'x86_64' ? 'x64' : requestedArch;
if (!['arm64', 'x64'].includes(arch)) {
  console.error('Usage: node scripts/verify-zyn-macos-release.cjs <arm64|x64>');
  process.exit(2);
}

const version = contract.product.version;
const outputRoot = path.join(projectRoot, 'release', 'dist', arch);
const workApp = path.join(projectRoot, 'release', 'work', arch, 'Zyn.app');
const zipName = `Zyn-${version}-${arch}.zip`;
const dmgName = `Zyn-${version}-${arch}.dmg`;
const metadataPath = path.join(outputRoot, 'latest-mac.yml');

function run(command, args) {
  execFileSync(command, args, { stdio: 'inherit' });
}

for (const file of [workApp, path.join(outputRoot, zipName), path.join(outputRoot, dmgName), metadataPath]) {
  if (!fs.existsSync(file)) throw new Error(`Missing release file: ${file}`);
}
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', workApp]);
run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', workApp]);
run('/usr/bin/xcrun', ['stapler', 'validate', workApp]);
run('/usr/bin/xcrun', ['stapler', 'validate', path.join(outputRoot, dmgName)]);
run('/usr/bin/hdiutil', ['verify', path.join(outputRoot, dmgName)]);

const binary = path.join(workApp, 'Contents', 'MacOS', 'Zyn');
const description = execFileSync('/usr/bin/file', ['-b', binary], { encoding: 'utf8' });
if (!(arch === 'x64' ? /x86_64/.test(description) : /arm64/.test(description))) {
  throw new Error(`Zyn executable does not match ${arch}: ${description.trim()}`);
}
const bundleId = execFileSync('plutil', [
  '-extract', 'CFBundleIdentifier', 'raw', path.join(workApp, 'Contents', 'Info.plist'),
], { encoding: 'utf8' }).trim();
if (bundleId !== contract.product.bundleIdentifier) throw new Error(`Unexpected bundle ID: ${bundleId}`);

const metadata = fs.readFileSync(metadataPath, 'utf8');
for (const name of [zipName, dmgName]) {
  const file = path.join(outputRoot, name);
  const sha512 = crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64');
  if (!metadata.includes(`url: ${name}`) || !metadata.includes(`sha512: ${sha512}`)) {
    throw new Error(`latest-mac.yml does not match ${name}`);
  }
}
if (!metadata.includes(`version: ${version}`)) throw new Error(`latest-mac.yml does not advertise ${version}`);
console.log(`Zyn ${version} ${arch} release verification passed.`);
