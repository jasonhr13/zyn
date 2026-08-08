#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createProfileImapControl } = require('../launcher/profile-imap-control');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zyn-profile-imap-'));
const write = (name, value) => fs.writeFileSync(path.join(directory, name), `${JSON.stringify(value, null, 2)}\n`);
const read = name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));

write('profiles.json', [
  { id: 'one', profileName: 'One', email: 'one@example.com' },
  { id: 'two', profileName: 'Two', email: 'two@example.com' },
]);
write('settings.json', {
  imapHost: 'imap.legacy.example',
  imapPort: 993,
  imapUser: 'legacy@example.com',
  imapPass: 'legacy secret',
  aycdApiKey: 'preserved',
});

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(`protected:${value}`, 'utf8'),
  decryptString: buffer => buffer.toString('utf8').replace(/^protected:/, ''),
};
let importedWithoutProfiles = null;
const dataManager = {
  exportAll: () => ({ app: 'secret-lair-bot', kind: 'settings-export', profiles: [{ id: 'raw' }], settings: {} }),
  importAll: (bundle, mode) => {
    importedWithoutProfiles = { bundle, mode };
    return { settings: { keys: 0 } };
  },
};

const control = createProfileImapControl({ dataDirectory: directory, safeStorage, dataManager });
const migrated = dataManager.getProfiles();
assert.equal(migrated.length, 2);
assert.equal(migrated[0].imap.password, 'legacy secret');
assert.equal(dataManager.getProfileImap('one', '').user, 'legacy@example.com');
assert.equal(dataManager.getProfileImap('', 'TWO@example.com').profileId, 'two');

const rawAfterMigration = fs.readFileSync(path.join(directory, 'profiles.json'), 'utf8');
assert.equal(rawAfterMigration.includes('legacy secret'), false, 'profile file contains a plaintext mailbox password');
assert.match(read('profiles.json')[0].imap.password, /^enc:/);
assert.equal(read('settings.json').imapPass, undefined);
assert.equal(read('settings.json').profileImapMigrationVersion, 1);
assert.equal(read('settings.json').aycdApiKey, 'preserved');
assert.equal(fs.existsSync(path.join(directory, 'profiles.json.pre-profile-imap-r6.bak')), true);
assert.equal(fs.existsSync(path.join(directory, 'settings.json.pre-profile-imap-r6.bak')), true);
assert.equal(fs.statSync(path.join(directory, 'profiles.json')).mode & 0o777, 0o600);

dataManager.updateProfile('one', {
  imap: { host: ' imap.one.example ', port: '993', user: ' one-inbox@example.com ', password: 'one\u200B secret' },
});
dataManager.updateProfile('two', {
  imap: { host: 'imap.two.example', port: 993, user: 'two-inbox@example.com', password: 'two secret' },
});
assert.deepEqual(dataManager.getProfileImap('one', ''), {
  host: 'imap.one.example', port: 993, user: 'one-inbox@example.com', password: 'one secret',
  profileId: 'one', profileName: 'One',
});
assert.equal(dataManager.getProfileImap('two', '').password, 'two secret');
const distinctRaw = fs.readFileSync(path.join(directory, 'profiles.json'), 'utf8');
assert.equal(distinctRaw.includes('one secret'), false);
assert.equal(distinctRaw.includes('two secret'), false);

const exported = dataManager.exportAll();
assert.equal(exported.profiles.find(profile => profile.id === 'one').imap.password, 'one secret');
assert.equal(exported.profiles.find(profile => profile.id === 'two').imap.password, 'two secret');

const summary = dataManager.importAll({
  app: 'secret-lair-bot',
  profiles: [{ id: 'three', profileName: 'Three', email: 'three@example.com', imap: {
    host: 'imap.three.example', port: 993, user: 'three-inbox@example.com', password: 'three secret',
  } }],
  settings: {},
}, 'replace');
assert.equal(summary.profiles.set, 1);
assert.equal(importedWithoutProfiles.bundle.profiles, undefined, 'legacy importer received unencrypted profiles');
assert.equal(importedWithoutProfiles.mode, 'replace');
assert.equal(dataManager.getProfiles()[0].imap.password, 'three secret');
assert.equal(fs.readFileSync(path.join(directory, 'profiles.json'), 'utf8').includes('three secret'), false);

console.log(JSON.stringify({
  ok: true,
  migrationVersion: control.migrationVersion,
  profileLookup: true,
  encryptedAtRest: true,
  backupRoundTrip: true,
}, null, 2));
