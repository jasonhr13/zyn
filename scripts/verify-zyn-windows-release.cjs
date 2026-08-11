#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const PELibrary = require('../release-tools/node_modules/pe-library');
const ResEdit = require('../release-tools/node_modules/resedit');
const { assertNoLegacyBrand } = require('./verify-zyn-packaged-brand-boundary.cjs');
const { verifyWindowsReleasePayload } = require('./verify-zyn-release-payload.cjs');

const projectRoot = path.join(__dirname, '..');
const contract = require(path.join(projectRoot, 'config', 'runtime-contract.json'));
const version = contract.product.version;
const appPath = path.join(projectRoot, 'dist', 'Zyn-win32-x64');
const outputRoot = path.join(projectRoot, 'release', 'dist', 'windows-x64');
const installerName = `Zyn-Setup-${version}-x64.exe`;
const installer = path.join(outputRoot, installerName);
const blockmap = path.join(outputRoot, `${installerName}.blockmap`);
const metadataPath = path.join(outputRoot, 'latest.yml');
const allowDirty = process.env.ZYN_ALLOW_DIRTY_RELEASE === '1';

for (const file of [appPath, installer, blockmap, metadataPath]) {
  if (!fs.existsSync(file)) throw new Error(`Missing Windows release file: ${file}`);
}
execFileSync(process.execPath, [path.join(__dirname, 'verify-zyn-windows-build.cjs'), appPath], {
  cwd: projectRoot,
  stdio: 'inherit',
});

function sha512(file) {
  return crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64');
}
function peCertificateSize(file) {
  const body = fs.readFileSync(file);
  assert.equal(body.subarray(0, 2).toString('ascii'), 'MZ', 'installer is not a Windows executable');
  const pe = body.readUInt32LE(0x3c);
  assert.equal(body.subarray(pe, pe + 4).toString('binary'), 'PE\u0000\u0000', 'installer PE header is missing');
  const optional = pe + 24;
  const magic = body.readUInt16LE(optional);
  const dataDirectories = optional + (magic === 0x20b ? 112 : 96);
  return body.readUInt32LE(dataDirectories + 8 * 4 + 4);
}

assert.equal(peCertificateSize(installer), 0,
  'Windows installer unexpectedly contains an Authenticode certificate; this channel is intentionally unsigned');
assert.ok(fs.statSync(installer).size > 1024 * 1024, 'Windows installer is unexpectedly small');
assert.ok(fs.statSync(blockmap).size > 0, 'Windows blockmap is empty');
const installerExecutable = PELibrary.NtExecutable.from(fs.readFileSync(installer), { ignoreCert: true });
const installerResources = PELibrary.NtExecutableResource.from(installerExecutable);
function iconFingerprints(items) {
  return items.map((item) => {
    const icon = item.data || item;
    return crypto.createHash('sha256').update(Buffer.from(icon.bin)).digest('hex');
  }).sort();
}
const reviewedIconFingerprints = iconFingerprints(
  ResEdit.Data.IconFile.from(fs.readFileSync(path.join(projectRoot, 'assets', 'brand', 'Zyn.ico'))).icons,
);
const installerIconGroups = ResEdit.Resource.IconGroupEntry.fromEntries(installerResources.entries);
assert.ok(installerIconGroups.length > 0, 'Windows installer has no icon resources');
for (const group of installerIconGroups) {
  assert.deepEqual(
    iconFingerprints(group.getIconItemsFromEntries(installerResources.entries)),
    reviewedIconFingerprints,
    'Windows installer icon resources do not match the reviewed Zyn application icon',
  );
}
const installerVersions = ResEdit.Resource.VersionInfo.fromEntries(installerResources.entries);
assert.ok(installerVersions.length > 0, 'Windows installer has no version information');
const installerVersionStrings = installerVersions.flatMap((entry) => entry
  .getAllLanguagesForStringValues()
  .map((language) => entry.getStringValues(language)));
assert.ok(installerVersionStrings.length > 0, 'Windows installer has no localized version strings');
for (const values of installerVersionStrings) {
  assert.equal(values.ProductName, 'Zyn', 'Windows installer ProductName must be Zyn');
  assert.equal(values.FileDescription, 'Zyn desktop application',
    'Windows installer FileDescription must identify Zyn');
  assert.equal(values.FileVersion, version, 'Windows installer FileVersion is incorrect');
  assert.equal(values.ProductVersion, version, 'Windows installer ProductVersion is incorrect');
  assertNoLegacyBrand(JSON.stringify(values), 'Windows installer version information');
}
const metadata = fs.readFileSync(metadataPath, 'utf8');
assert.match(metadata, new RegExp(`^version:\\s*${version.replaceAll('.', '\\.')}\\s*$`, 'm'));
assert.match(metadata, new RegExp(`^path:\\s*${installerName.replaceAll('.', '\\.')}\\s*$`, 'm'));
assert.ok(metadata.includes(`url: ${installerName}`), 'latest.yml does not reference the installer');
assert.ok(metadata.includes(`sha512: ${sha512(installer)}`), 'latest.yml installer hash is incorrect');
assert.ok(metadata.includes(`size: ${fs.statSync(installer).size}`), 'latest.yml installer size is incorrect');

const receipt = JSON.parse(fs.readFileSync(path.join(appPath, 'resources', 'zyn-build.json'), 'utf8'));
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' }).trim();
if (!allowDirty) {
  assert.equal(receipt.source.dirty, false, 'Windows release build was created from a dirty worktree');
  assert.equal(receipt.source.commit, head, 'Windows release build does not match HEAD');
}
const payload = verifyWindowsReleasePayload({
  expectedApp: appPath,
  installer,
  verifyExtractedApp(extractedApp) {
    execFileSync(process.execPath, [path.join(__dirname, 'verify-zyn-windows-build.cjs'), extractedApp], {
      cwd: projectRoot,
      stdio: 'inherit',
    });
  },
});
console.log(`Verified NSIS embedded app payload (${payload.entries} entries, sha256 ${payload.sha256}).`);
console.log(`Zyn ${version} Windows x64 unsigned release verification passed.`);
