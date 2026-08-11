#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const createModal = read('frontend/src/components/pages/profiles-components/create-modal.js');
const editModal = read('frontend/src/components/pages/profiles-components/edit-modal.js');
const profilesPage = read('frontend/src/components/pages/profiles.js');

const helperStart = createModal.indexOf('const IMAP_PROVIDERS');
const helperEnd = createModal.indexOf('const BLANK');
assert.notEqual(helperStart, -1, 'mailbox provider definitions are missing');
assert.notEqual(helperEnd, -1, 'saved mailbox helper boundary is missing');

const sharedPassword = 'shared app password';
const sandbox = {
  profiles: [
    {
      id: 'one', profileName: 'Primary mailbox', email: 'primary@example.com',
      imap: { host: 'imap.gmail.com', user: 'primary@example.com', password: sharedPassword },
    },
    {
      id: 'two', profileName: 'Alias mailbox', email: 'alias@example.com',
      imap: { host: 'imap.gmail.com', user: 'alias@example.com', password: sharedPassword },
    },
    {
      id: 'three', profileName: 'Custom mailbox', email: 'custom@example.com',
      imap: { host: 'imap.example.com', user: 'custom@example.com', password: 'custom secret' },
    },
    {
      id: 'empty', profileName: 'No password',
      imap: { host: 'imap.gmail.com', user: 'empty@example.com', password: '' },
    },
  ],
};

vm.runInNewContext(
  `${createModal.slice(helperStart, helperEnd)}\nresult = {
    all: savedMailboxPresets(profiles, ''),
    editingOne: savedMailboxPresets(profiles, 'one'),
  };`,
  sandbox,
);
const presets = JSON.parse(JSON.stringify(sandbox.result.all));
assert.equal(presets.length, 2, 'shared credentials should collapse into one safe choice');
assert.equal(presets[0].profileCount, 2);
assert.equal(presets[0].provider, 'imap.gmail.com');
assert.equal(presets[0].user, 'primary@example.com');
assert.equal(presets[0].password, sharedPassword);
assert.equal(presets[1].provider, 'custom');
assert.equal(presets[1].customHost, 'imap.example.com');
assert.equal(presets.some(preset => preset.key.includes(sharedPassword)), false,
  'a secret leaked into an option key');

const editPresets = JSON.parse(JSON.stringify(sandbox.result.editingOne));
assert.equal(editPresets[0].profileCount, 1, 'the profile being edited was not excluded');
assert.equal(editPresets[0].sourceName, 'Alias mailbox');

assert.match(createModal, /Reuse Saved Mailbox Credentials/);
assert.match(createModal, /value=\{preset\.key\}/,
  'saved mailbox choices do not use opaque option values');
assert.doesNotMatch(createModal, /value=\{preset\.password\}/,
  'saved mailbox password is exposed as an option value');
for (const field of ['imapProvider: preset.provider', 'imapHostCustom: preset.customHost', 'imapUser: preset.user', 'imapPass: preset.password']) {
  assert.ok(createModal.includes(field), `selecting a mailbox does not copy ${field}`);
}
assert.match(createModal, /mailboxPresetKey: '', imapTesting: false, imapTestResult: null/,
  'manual mailbox edits do not return the selector to manual mode');
assert.match(editModal, /excludeProfileId=\{profile\.id\}/,
  'editing a profile can select its own credentials');
assert.match(profilesPage, /<CreateModal mailboxProfiles=\{profiles\}/,
  'new profile form does not receive saved mailboxes');
assert.match(profilesPage, /<EditModal profile=\{editProfile\} mailboxProfiles=\{profiles\}/,
  'edit profile form does not receive saved mailboxes');
assert.match(profilesPage, /title="Duplicate Profile"[\s\S]{0,120}mailboxProfiles=\{profiles\}/,
  'duplicate profile form does not receive saved mailboxes');

console.log('Saved profile mailbox reuse smoke test passed');
