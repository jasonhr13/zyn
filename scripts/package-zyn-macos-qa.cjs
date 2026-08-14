#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { verifyMacReleasePayload } = require('./verify-zyn-release-payload.cjs');

const root = path.resolve(__dirname, '..');
const contract = require(path.join(root, 'config', 'runtime-contract.json'));
const requested = String(process.argv[2] || '').toLowerCase();
const arch = requested === 'x86_64' ? 'x64' : requested;
if (!['arm64', 'x64'].includes(arch)) {
  console.error('Usage: node scripts/package-zyn-macos-qa.cjs <arm64|x64>');
  process.exit(2);
}

const version = contract.product.version;
const app = path.join(root, 'dist', `Zyn-mac-${arch}.app`);
const output = path.join(root, 'release', 'qa', version, arch);
const zip = path.join(output, `Zyn-${version}-QA-${arch}.zip`);
const dmg = path.join(output, `Zyn-${version}-QA-${arch}.dmg`);
const sums = path.join(output, 'SHA256SUMS.txt');

function run(command, args) {
  console.log(`$ ${command} ${args.map(value => JSON.stringify(value)).join(' ')}`);
  execFileSync(command, args, { stdio: 'inherit' });
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

if (!fs.existsSync(app)) throw new Error(`Missing QA app: ${app}`);
if (fs.existsSync(output)) {
  if (process.env.ZYN_OVERWRITE_QA !== '1') {
    throw new Error(`QA output already exists: ${output}. Inspect it or rerun with ZYN_OVERWRITE_QA=1.`);
  }
  fs.rmSync(output, { recursive: true, force: true });
}
fs.mkdirSync(output, { recursive: true });

run(process.execPath, [path.join(__dirname, 'verify-runtime-contract.js'), app]);
run(process.execPath, [path.join(__dirname, 'target-account-generator-packaged-ui-smoke-test.cjs'), app]);

const stage = fs.mkdtempSync(path.join(os.tmpdir(), `zyn-${version}-${arch}-qa-`));
try {
  const stagedApp = path.join(stage, 'Zyn.app');
  run('/bin/cp', ['-cR', app, stagedApp]);
  run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', stagedApp, zip]);
  fs.symlinkSync('/Applications', path.join(stage, 'Applications'));
  run('/usr/bin/hdiutil', [
    'create', '-fs', 'HFS+', '-format', 'UDZO', '-volname', `Zyn ${version} QA`,
    '-srcfolder', stage, dmg,
  ]);
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
run('/usr/bin/hdiutil', ['verify', dmg]);

const payload = verifyMacReleasePayload({
  expectedApp: app,
  zip,
  dmg,
  verifyExtractedApp(extracted) {
    run(process.execPath, [path.join(__dirname, 'target-account-generator-packaged-ui-smoke-test.cjs'), extracted]);
  },
});
if (payload.zip.sha256 !== payload.dmg.sha256) throw new Error('QA ZIP and DMG payloads differ');

const artifacts = [zip, dmg].map(file => ({
  file,
  bytes: fs.statSync(file).size,
  sha256: sha256(file),
}));
fs.writeFileSync(sums, artifacts.map(item => `${item.sha256}  ${path.basename(item.file)}`).join('\n') + '\n');
console.log(JSON.stringify({
  ok: true,
  version,
  arch,
  signed: false,
  notarized: false,
  payloadSha256: payload.zip.sha256,
  artifacts,
  sums,
}, null, 2));
