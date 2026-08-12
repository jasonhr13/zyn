#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

const contract = JSON.parse(read('config/runtime-contract.json'));
const flags = read('launcher/feature-flags.js');
const bootstrap = read('launcher/bootstrap.js');
const manager = read('launcher/cloud-backup.js');
const settings = read('frontend/src/components/pages/settings.js');
const authority = read('launcher/license-authority.js');
const worker = read('cloudflare/license/src/index.js');
const macBuilder = read('scripts/build-zyn.sh');
const windowsBuilder = read('scripts/build-zyn-windows.sh');
const runtimePatcher = read('scripts/patch-zyn-runtime-brand.js');

assert.equal(contract.features.cloudBackup, true);
for (const resource of [
  'Contents/Resources/app/cloud-backup.js',
  'Contents/Resources/app/cloud-backup-data.js',
]) {
  assert.ok(contract.requiredResources.includes(resource), `${resource} missing from runtime contract`);
}
assert.match(flags, /cloudBackup:\s*true/);
for (const builder of [macBuilder, windowsBuilder]) {
  assert.match(builder, /cloud-backup\.js cloud-backup-data\.js/);
}

assert.match(bootstrap, /createCloudBackupDataAdapter\([\s\S]*dataDirectory:\s*app\.getPath\('userData'\)/);
assert.match(bootstrap, /getAccountId:\s*\(\)\s*=>\s*authority\.backupAccountId\(\)/);
assert.match(bootstrap, /event\.senderFrame[\s\S]*event\.sender\.mainFrame/,
  'backup IPC does not reject subframes');
assert.match(bootstrap, /app-original\.asar[\s\S]*build[\s\S]*index\.html/,
  'packaged backup IPC is not pinned to the application document');
assert.match(bootstrap, /if \(!trustedCloudBackupSender\(event\)\)/);
assert.doesNotMatch(bootstrap, /cloudBackupRevealKey/,
  'the renderer must not have an IPC route that reveals a stored recovery key');
assert.match(bootstrap, /manager\.copyRecoveryKey\(parentWindow\(\)\)/,
  'copying a recovery key must use the native confirmation window');
assert.match(bootstrap,
  /cloudBackupSetupKey'[\s\S]{0,240}keyFingerprint:\s*manager\.setupKey\(\)\.keyFingerprint[\s\S]{0,120}status:/,
  'setup IPC must return only a fingerprint and status');
const setupFunction = manager.slice(manager.indexOf('function setupKey()'), manager.indexOf('function revealKeyFor'));
assert.doesNotMatch(setupFunction, /recoveryKey:\s*recoveryKeyFor/,
  'setup must not return a raw stored recovery key');
assert.match(bootstrap, /cloudBackupPreview'[\s\S]{0,260}manager\.preview\(request\.backupId, request\.mode\)/);
assert.match(bootstrap,
  /cloudBackupRestore'[\s\S]{0,260}taskGroupScheduler\?\.pause\?\.\(\)[\s\S]{0,180}stopAllRunningForLicense\(\)/,
  'restore does not stop live tasks and schedules before mutation');
assert.match(bootstrap, /onStatus:[\s\S]{0,300}cloudBackupManager\?\.start\(\)/);
assert.match(bootstrap, /onLock:[\s\S]{0,180}cloudBackupManager\?\.pause\(\)/);
assert.match(runtimePatcher, /legacy @electron\/remote main-process initialization/);
assert.match(runtimePatcher, /enableRemoteModule: false/);

assert.match(authority, /backupAccountId:/);
for (const method of ['listBackups', 'uploadBackup', 'downloadBackup', 'deleteBackup']) {
  assert.match(authority, new RegExp(`${method}:`));
}
assert.doesNotMatch(settings, /cloudBackupRevealKey/);
assert.match(settings, /Encrypted cloud backup/);
assert.match(settings, /profiles and payment details/);
assert.match(settings, /site and mailbox passwords/);
assert.match(settings, /Zyn account\/session credentials[\s\S]{0,100}browser session cookies,[\s\S]{0,100}managed-proxy service credentials are excluded/);
assert.match(settings, /cloudBackupPreview', \{ backupId: backup\.id, mode \}/);
assert.match(settings, /Please review:/);
assert.match(settings, /RCART1\.… \(existing backup keys remain compatible\)/);
assert.match(settings, /cloud\.configuredActiveKeyFingerprint/);
assert.match(settings, /htmlFor="cloud-backup-recovery-key"/);
assert.match(settings, /id="cloud-backup-recovery-key"/);
assert.match(settings, /cloudListLoaded:\s*false, cloudListError:\s*''/);
assert.match(settings, /Could not load backups:/);
assert.match(settings, /The backup list is unavailable right now/);

assert.match(worker, /licenseToken:\s*token,[\s\S]{0,80}userId:\s*user\.id/);
assert.match(worker, /ok:\s*true,[\s\S]{0,80}userId:\s*row\.user_id/);
assert.match(worker, /BACKUP_UPLOAD_RATE_MAX_REQUESTS\s*=\s*30/);
assert.match(worker, /onlyIf:\s*\{\s*etagDoesNotMatch:\s*'\*'\s*\}/);
assert.match(worker, /x-rcart-backup-sha256/);

console.log('Encrypted cloud backup integration wiring smoke test passed');
