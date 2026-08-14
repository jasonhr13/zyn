#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const project = path.resolve(__dirname, '..');
const helperDir = path.join(project, 'runtime-app', 'public', 'helpers');
const read = name => fs.readFileSync(path.join(helperDir, name), 'utf8');
const dataManager = read('data-manager.js');
const targetEngine = read('target-engine.js');
const taskHandler = read('task-handler.js');
const profileImap = fs.readFileSync(path.join(project, 'launcher', 'profile-imap-control.js'), 'utf8');

for (const source of [dataManager, targetEngine, taskHandler]) {
  assert.doesNotMatch(source, /Zyn-Runtime-Base|extracted\/asar/);
}

assert.match(dataManager, /accountGenWebhook/);
for (const field of ['host', 'port', 'user', 'password']) {
  assert.match(profileImap, new RegExp(field), `profile IMAP storage is missing ${field}`);
}
assert.match(profileImap, /getProfileImap/);
assert.match(profileImap, /createProfileImapControl/);
assert.match(profileImap, /PROFILE_PAYMENT_MIGRATION_VERSION/);
assert.match(profileImap, /\['cardNumber', 'cardCvv'\]/);

assert.match(targetEngine, /fetchAuthCode/);
assert.match(targetEngine, /fetchAuthCodeViaAycd/);
assert.match(targetEngine, /dm\.getProfileImap/);
assert.match(targetEngine, /case 'analytics-event':/);
assert.match(targetEngine, /nodeEnvironment\(/);
assert.doesNotMatch(targetEngine, /vendor[^\n]*node(?:\.exe)?/);

assert.match(taskHandler, /nodeExecutable/);
assert.equal((taskHandler.match(/= nodeEnvironment\(/g) || []).length, 5);
assert.doesNotMatch(taskHandler, /bundledNode|vendor[^\n]*node(?:\.exe)?/);

for (const name of ['data-manager.js', 'target-engine.js', 'task-handler.js']) {
  execFileSync(process.execPath, ['--check', path.join(helperDir, name)], { stdio: 'pipe' });
}

console.log('Canonical runtime profile, IMAP, analytics, and Electron-as-Node wiring passed');
