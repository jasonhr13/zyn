#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const project = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hope-imap-engines-'));
for (const filename of ['target-engine.js', 'walmart-engine.js']) {
  fs.copyFileSync(path.join(project, 'extracted', 'asar', 'public', 'helpers', filename), path.join(directory, filename));
}

execFileSync(process.execPath, [path.join(__dirname, 'patch-profile-imap-engines.js'), directory], { stdio: 'inherit' });
const target = fs.readFileSync(path.join(directory, 'target-engine.js'), 'utf8');
const walmart = fs.readFileSync(path.join(directory, 'walmart-engine.js'), 'utf8');
assert.match(target, /dm\.getProfileImap\(profileId, email\)/);
assert.match(target, /taskProfileById\.set\(t\.id, t\.profileId/);
assert.match(target, /useOtpLogin: otpEnabled\(t\.profileId\)/);
assert.match(target, /profileId: first\.profileId/);
assert.doesNotMatch(target, /function getImapConfig\(\) \{/);
assert.match(walmart, /dm\.getProfileImap\(activeConfig && activeConfig\.profileId, addr\)/);
assert.match(walmart, /activeConfig = config/);
assert.match(walmart, /dm\.getProfileImap\(config\.profileId, ''\)/);
assert.doesNotMatch(walmart, /useOtpLogin: false/);

for (const filename of ['target-engine.js', 'walmart-engine.js']) {
  execFileSync(process.execPath, ['--check', path.join(directory, filename)]);
}
const repeat = spawnSync(process.execPath, [path.join(__dirname, 'patch-profile-imap-engines.js'), directory], { encoding: 'utf8' });
assert.notEqual(repeat.status, 0, 'hash gate accepted an already-modified engine');
assert.match(`${repeat.stdout}${repeat.stderr}`, /does not match the reviewed R5 source/);

console.log(JSON.stringify({ ok: true, hashGated: true, targetProfileRouting: true, walmartProfileRouting: true }, null, 2));
