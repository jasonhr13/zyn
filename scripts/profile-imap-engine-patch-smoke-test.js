#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const project = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zyn-imap-engines-'));
for (const filename of ['target-engine.js', 'walmart-engine.js', 'plain-log.js']) {
  fs.copyFileSync(path.join(project, 'extracted', 'asar', 'public', 'helpers', filename), path.join(directory, filename));
}

execFileSync(process.execPath, [path.join(__dirname, 'patch-profile-imap-engines.js'), directory], { stdio: 'inherit' });
const target = fs.readFileSync(path.join(directory, 'target-engine.js'), 'utf8');
const walmart = fs.readFileSync(path.join(directory, 'walmart-engine.js'), 'utf8');
const plainLog = fs.readFileSync(path.join(directory, 'plain-log.js'), 'utf8');
assert.match(target, /dm\.getProfileImap\(profileId, email\)/);
assert.match(target, /'--headless=true'/);
assert.doesNotMatch(target, /'--headless=false'/);
assert.match(target, /`--capturesPerLoad=\$\{capturesPerLoad\}`/);
assert.match(target, /`--loadsPerBrowser=\$\{loadsPerBrowser\}`/);
assert.match(target, /`--blockHeavyResources=\$\{blockHeavyResources\}`/);
assert.match(target, /`--browsers=auto`/);
assert.match(target, /`--sessionReady=\$\{hasSession\}`/);
assert.match(target, /nodeEnvironment/);
assert.match(target, /const findNodeExe = nodeExecutable/);
assert.match(target, /signalFarmerSessionReady\(\)/);
assert.match(target, /health: j\.health \|\| null/);
assert.match(target, /function latestBankedAt\(\)/);
assert.match(target, /lastBankedAt: latestBankedAt\(\)/);
assert.match(target, /taskProfileById\.set\(t\.id, t\.profileId/);
assert.match(target, /useOtpLogin: otpEnabled\(t\.profileId\)/);
assert.match(target, /profileId: first\.profileId/);
assert.match(target, /const otpFetches = new Map\(\)/);
assert.match(target, /receivedAfter/);
assert.match(target, /cancelOtpForTask\(taskId\)/);
assert.match(target, /cancelAllOtpFetches\('Target engine exited'\)/);
assert.match(target, /onLog: \(line\) => log\(String\(line\), taskId\)/);
assert.match(target, /Object\.assign\(sentConfigs\.proxies, buildProxyMap\(group\)\)/);
assert.match(target, /buildProxyMap\(group\)\);\s+sendConfigs\(\);\s+}\s+return sendToEngine\(\{ type: 'set-task-proxy'/,
  'live proxy edits must configure the selected group before switching');
assert.doesNotMatch(target, /const otpInFlight = new Set\(\)/);
assert.doesNotMatch(target, /log\(`\[otp\] code \$\{code\}/);
assert.doesNotMatch(target, /function getImapConfig\(\) \{/);
assert.match(walmart, /dm\.getProfileImap\(activeConfig && activeConfig\.profileId, addr\)/);
assert.match(walmart, /activeConfig = config/);
assert.match(walmart, /dm\.getProfileImap\(config\.profileId, ''\)/);
assert.doesNotMatch(walmart, /useOtpLogin: false/);
assert.match(plainLog, /Mailbox connected — waiting for the email code/);
assert.match(plainLog, /Email code found — submitting/);
assert.match(plainLog, /Could not find the new email code — enter it manually/);

for (const filename of ['target-engine.js', 'walmart-engine.js', 'plain-log.js']) {
  execFileSync(process.execPath, ['--check', path.join(directory, filename)]);
}
const repeat = spawnSync(process.execPath, [path.join(__dirname, 'patch-profile-imap-engines.js'), directory], { encoding: 'utf8' });
assert.notEqual(repeat.status, 0, 'hash gate accepted an already-modified engine');
assert.match(`${repeat.stdout}${repeat.stderr}`, /does not match the reviewed R5 source/);

console.log(JSON.stringify({ ok: true, hashGated: true, targetProfileRouting: true, walmartProfileRouting: true }, null, 2));
