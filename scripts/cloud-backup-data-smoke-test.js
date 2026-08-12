#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCloudBackupDataAdapter, __test } = require('../launcher/cloud-backup-data');
const { __test: cloudCrypto } = require('../launcher/cloud-backup');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zyn-cloud-backup-data-'));
const taskGroupPath = path.join(directory, 'task-groups.json');
const taskGroupBackupDirectory = path.join(directory, 'backups');
const transactionDirectory = path.join(taskGroupBackupDirectory, 'cloud-restore-transactions');
const jsonPath = name => path.join(directory, name);
const clone = value => JSON.parse(JSON.stringify(value));
const write = (name, value) => {
  fs.mkdirSync(path.dirname(jsonPath(name)), { recursive: true, mode: 0o700 });
  fs.writeFileSync(jsonPath(name), `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(jsonPath(name), 0o600);
};
const read = (name, fallback = null) => {
  try { return JSON.parse(fs.readFileSync(jsonPath(name), 'utf8')); } catch { return fallback; }
};

const walkFiles = (root, relative = '') => {
  const result = {};
  let entries = [];
  try { entries = fs.readdirSync(path.join(root, relative), { withFileTypes: true }); } catch { return result; }
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) Object.assign(result, walkFiles(root, child));
    else if (entry.isFile()) {
      const full = path.join(root, child);
      result[child] = {
        bytes: fs.readFileSync(full).toString('base64'),
        mode: fs.statSync(full).mode & 0o777,
      };
    }
  }
  return result;
};

const initial = {
  profiles: [{
    id: 'profile-current', profileName: 'Current', email: 'user@example.com', groups: ['Existing'],
    imap: { user: 'mail@example.com', password: 'enc:portable-mailbox-secret' },
  }],
  accounts: [{
    id: 'account-current', email: 'user@example.com', password: 'enc:portable-password',
    cookie: 'site-session-cookie', auth: { accessToken: 'nested-site-session' },
  }],
  proxies: { lists: [{ name: 'Personal', raw: 'local.example:8000:user:pass' }] },
  settings: {
    shapeMethod: 'Harvester',
    targetHarvesterExtensionIds: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    discordBotToken: 'portable-discord-token',
    aycdApiKey: 'portable-aycd-key',
    hcaptchaApiKey: 'enc:portable-hcaptcha-key',
    lucaApiKey: 'portable-luca-key',
    hyperApiKey: 'portable-hyper-key',
    imapByHost: { gmail: { user: 'mail@example.com', pass: 'portable-imap-password' } },
    licenseToken: 'local-license-session',
    managedProxyLists: [{ raw: 'never-export-this' }],
    nested: { sessionToken: 'local-nested-session', visible: 'local' },
    profileGroups: ['Existing'],
  },
  lastOrders: { 'profile-current': 100 },
  tasks: [{ id: 'task-current', name: 'Current' }],
  targetTasks: { skus: '11111111', tasks: [{ id: 'target-current', accountId: 'account-current' }] },
  round1Profiles: [{ id: 'round-current', first: 'Current', email: 'current@example.com', marketing: false }],
  watchlist: { raw: 'CURRENT' },
  pokemon: {
    products: [{ id: 'product-current', input: 'CURRENT', quantity: '1' }],
    tasks: [{ id: 'pokemon-current', profileId: 'profile-current' }],
    monitorDelay: '3000', retryDelay: '3000',
  },
  taskGroups: [
    {
      id: 'group-current', site: 'target', name: 'Current group', loopCheckout: true,
      tasks: [{ id: 'group-task-current', accountId: 'account-current', loopCheckout: true }],
    },
    {
      id: 'pokemon-rollback', site: 'pokemoncenter', name: 'Legacy Pokemon group',
      tasks: [{ id: 'pokemon-group-task', profileId: 'profile-current', repeatCheckout: true }],
    },
  ],
};

function resetFiles() {
  write('profiles.json', initial.profiles);
  write('accounts.json', initial.accounts);
  write('proxies.json', initial.proxies);
  write('settings.json', initial.settings);
  write('last-orders.json', initial.lastOrders);
  write('tasks.json', initial.tasks);
  write('target-tasks.json', initial.targetTasks);
  write('round1-profiles.json', initial.round1Profiles);
  write('watchlist.json', initial.watchlist);
  write('pokemon-center-tasks.json', initial.pokemon);
  write('task-groups.json', { version: 3, groups: initial.taskGroups });
  fs.mkdirSync(taskGroupBackupDirectory, { recursive: true, mode: 0o700 });
  for (const name of fs.readdirSync(taskGroupBackupDirectory)) {
    const full = path.join(taskGroupBackupDirectory, name);
    if (fs.statSync(full).isDirectory()) fs.rmSync(full, { recursive: true, force: true });
    else fs.unlinkSync(full);
  }
  fs.writeFileSync(path.join(taskGroupBackupDirectory, 'task-groups.json.100.bak'), 'original backup\n', { mode: 0o600 });
}

resetFiles();
let failureStage = '';
let baseImports = [];
let taskGroupSyncs = [];
let backupSequence = 100;

const decodeSecret = value => String(value || '').replace(/^enc:/, '');
const encodeSecret = value => value ? `enc:${decodeSecret(value)}` : '';
const currentProfiles = () => read('profiles.json', []).map(profile => ({
  ...profile,
  imap: profile.imap ? { ...profile.imap, password: decodeSecret(profile.imap.password) } : profile.imap,
}));
const currentAccounts = () => read('accounts.json', []).map(account => ({
  ...account,
  password: decodeSecret(account.password),
}));

const dataManager = {
  exportAll(options = {}) {
    assert.equal(options.includePrivateSettings, true, 'cloud export did not request portable private settings');
    return {
      app: 'zyn', kind: 'settings-export', version: 1, exportedAt: 1735689600000,
      profiles: currentProfiles(),
      accounts: currentAccounts(),
      proxies: { lists: [
        ...read('proxies.json', { lists: [] }).lists,
        { name: 'Admin', ref: 'managed:11111111-2222-4333-8444-555555555555', managed: true, raw: 'remote:secret' },
      ] },
      settings: this.getSettings(),
      lastOrders: read('last-orders.json', {}),
    };
  },
  importAll(bundle, mode) {
    baseImports.push({ bundle: clone(bundle), mode });
    assert.equal(bundle.app, __test.LEGACY_APP_MARKER, 'base importer did not receive compatibility marker');
    assert.equal(bundle.settings, undefined, 'portable settings bypassed their owning save API');
    const replace = mode === 'replace';
    const summary = {};
    if (Array.isArray(bundle.profiles)) {
      const incoming = bundle.profiles.map(profile => ({
        ...profile,
        imap: profile.imap ? { ...profile.imap, password: encodeSecret(profile.imap.password) } : profile.imap,
      }));
      const value = replace ? incoming : [...read('profiles.json', []), ...incoming.filter(profile =>
        !read('profiles.json', []).some(current => current.id === profile.id))];
      write('profiles.json', value);
      summary.profiles = replace ? { set: incoming.length } : { added: value.length - read('profiles.json', []).length };
    }
    if (Array.isArray(bundle.accounts)) {
      const incoming = bundle.accounts.map(account => ({ ...account, password: encodeSecret(account.password) }));
      const existing = read('accounts.json', []);
      const accountKey = (account) => JSON.stringify([
        String(account && account.site || '').trim().toLowerCase() || 'bandai',
        String(account && account.email || '').trim().toLowerCase(),
      ]);
      const keys = new Set(existing.map(accountKey));
      const additions = incoming.filter((account) => {
        const key = accountKey(account);
        if (keys.has(key)) return false;
        keys.add(key);
        return true;
      });
      write('accounts.json', replace ? incoming : [...existing, ...additions]);
      summary.accounts = replace ? { set: incoming.length } : { added: additions.length };
    }
    if (bundle.proxies) write('proxies.json', bundle.proxies);
    if (bundle.lastOrders) write('last-orders.json', replace ? bundle.lastOrders : {
      ...read('last-orders.json', {}), ...bundle.lastOrders,
    });
    if (failureStage === 'base-after-write') throw new Error('injected base failure');
    return summary;
  },
  getSettings() {
    const settings = read('settings.json', {});
    return { ...settings, hcaptchaApiKey: decodeSecret(settings.hcaptchaApiKey) };
  },
  saveSettings(value) {
    const next = clone(value);
    if (Object.prototype.hasOwnProperty.call(next, 'hcaptchaApiKey')) {
      next.hcaptchaApiKey = encodeSecret(next.hcaptchaApiKey);
    }
    write('settings.json', next);
  },
  getTasks: () => read('tasks.json', []),
  getTargetTasks: () => read('target-tasks.json', { skus: '', tasks: [] }),
  saveTargetTasks(value) { write('target-tasks.json', value); return clone(value); },
  getRound1Profiles: () => read('round1-profiles.json', []),
  saveRound1Profiles(value) { write('round1-profiles.json', value); return clone(value); },
  getWatchlist: () => String(read('watchlist.json', { raw: '' }).raw || ''),
  saveWatchlist(value) { write('watchlist.json', { raw: String(value) }); },
  getPokemonCenterTasks: () => read('pokemon-center-tasks.json', {}),
  savePokemonCenterTasks(value) { write('pokemon-center-tasks.json', value); return clone(value); },
};

const taskGroupStore = {
  filePath: taskGroupPath,
  load: () => clone(read('task-groups.json', { groups: [] }).groups.filter(
    group => String(group && group.site || 'target').toLowerCase() === 'target')),
  save(value, options = {}) {
    const backupName = `task-groups.json.${++backupSequence}.bak`;
    fs.copyFileSync(taskGroupPath, path.join(taskGroupBackupDirectory, backupName));
    fs.chmodSync(path.join(taskGroupBackupDirectory, backupName), 0o600);
    for (const old of fs.readdirSync(taskGroupBackupDirectory)
      .filter(name => /^task-groups\.json\.\d+\.bak$/.test(name) && name !== backupName)) {
      fs.unlinkSync(path.join(taskGroupBackupDirectory, old));
    }
    const unsupported = options.preserveUnsupported === false ? [] : read('task-groups.json', { groups: [] }).groups
      .filter(group => String(group && group.site || 'target').toLowerCase() !== 'target');
    write('task-groups.json', { version: 3, groups: [...value, ...unsupported] });
    if (failureStage === 'task-groups-after-write') throw new Error('injected late task-group failure');
    return clone(value);
  },
};

const makeAdapter = () => createCloudBackupDataAdapter({
  dataManager,
  taskGroupStore,
  dataDirectory: directory,
  onTaskGroupsChanged(groups, summary) {
    taskGroupSyncs.push({ groups: clone(groups), summary: clone(summary) });
  },
});

let adapter = makeAdapter();

function comprehensiveBundle(app = 'zyn') {
  return {
    app, kind: 'settings-export', version: 2, exportedAt: 1735776000000,
    profiles: [{
      id: 'profile-new', profileName: 'New', email: 'new@example.com', groups: ['Imported'],
      imap: { user: 'new-mail@example.com', password: 'new-mailbox-password' },
    }],
    accounts: [{
      id: 'account-new', email: 'new@example.com', password: 'new-account-password',
      cookie: 'must-not-restore',
    }],
    proxies: { lists: [
      { name: 'Imported local', raw: 'imported.example:9000:user:pass' },
      { name: 'managed:forged', raw: 'must-not-restore' },
    ] },
    settings: {
      shapeMethod: 'In Bot',
      discordBotToken: 'new-discord-token',
      aycdApiKey: 'new-aycd-key',
      hcaptchaApiKey: 'new-hcaptcha-key',
      lucaApiKey: 'new-luca-key',
      hyperApiKey: 'new-hyper-key',
      imapByHost: { outlook: { user: 'outlook@example.com', pass: 'new-imap-password' } },
      licenseToken: 'must-not-restore',
      nested: { sessionToken: 'must-not-restore', visible: 'imported' },
    },
    lastOrders: { 'profile-new': 200 },
    tasks: [{ id: 'task-current', name: 'Duplicate' }, { id: 'task-new', name: 'New' }],
    targetTasks: {
      skus: '11111111\n22222222',
      tasks: [
        { id: 'target-current', accountId: 'duplicate' },
        { id: 'target-new', accountId: 'account-new' },
      ],
    },
    round1Profiles: [
      { id: 'round-current-copy', first: 'Updated', email: 'current@example.com' },
      { id: 'round-new', first: 'New', email: 'new@example.com' },
    ],
    watchlist: 'CURRENT\nNEW',
    pokemonCenterTasks: {
      products: [
        { id: 'product-current', input: 'DUPLICATE', quantity: '1' },
        { id: 'product-new', input: 'NEW', quantity: '1' },
      ],
      tasks: [
        { id: 'pokemon-current', profileId: 'duplicate' },
        { id: 'pokemon-new', profileId: 'profile-new' },
      ],
      retryDelay: '4000',
    },
    taskGroups: [
      { id: 'group-current', site: 'target', name: 'Duplicate', tasks: [] },
      { id: 'group-new', site: 'target', name: 'New group', tasks: [] },
      { id: 'pokemon-legacy', site: 'pokemoncenter', name: 'Unsupported old group', tasks: [] },
    ],
  };
}

function taskLossBundle() {
  const tasks = [
    { id: 'kept-task', accountId: 'kept-account' },
    { id: 'missing-account' },
    { id: 'kept-task', accountId: 'duplicate-task-id-account' },
    { id: 'duplicate-account-task', accountId: 'kept-account' },
  ];
  for (let index = tasks.length; index < 2000; index += 1) {
    tasks.push({ id: `task-${index}`, accountId: `account-${index}` });
  }
  tasks.push({ id: 'over-capacity-task', accountId: 'over-capacity-account' });
  return {
    app: 'zyn', kind: 'settings-export', version: 2, exportedAt: 1735862400000,
    taskGroups: [{ id: 'loss-group', site: 'target', name: 'Loss regression', tasks }],
  };
}

try {
  const exported = adapter.exportAll({ includePrivateSettings: true });
  assert.equal(exported.app, __test.LEGACY_APP_MARKER, 'cloud export is not rollback-compatible');
  assert.equal(exported.kind, 'settings-export');
  assert.equal(exported.version, 2, 'cloud export did not advance to the portable data shape');
  assert.deepEqual(exported.tasks, initial.tasks);
  assert.deepEqual(exported.targetTasks, initial.targetTasks);
  assert.deepEqual(exported.round1Profiles, initial.round1Profiles);
  assert.equal(exported.watchlist, 'CURRENT');
  assert.deepEqual(exported.taskGroups.map(group => ({ id: group.id, site: group.site, name: group.name })), [
    { id: 'group-current', site: 'target', name: 'Current group' },
    { id: 'pokemon-rollback', site: 'pokemoncenter', name: 'Legacy Pokemon group' },
  ]);
  assert.equal(exported.taskGroups[0].repeatCheckout, true);
  assert.equal(exported.taskGroups[0].tasks[0].repeatCheckout, true);
  assert.equal(exported.taskGroups[1].tasks[0].loopCheckout, true,
    'legacy repeatCheckout did not gain the Zyn compatibility alias');
  assert.deepEqual(exported.pokemonCenterTasks, initial.pokemon);
  assert.equal(exported.settings.discordBotToken, 'portable-discord-token');
  assert.equal(exported.settings.aycdApiKey, 'portable-aycd-key');
  assert.equal(exported.settings.hcaptchaApiKey, 'portable-hcaptcha-key');
  assert.equal(exported.settings.lucaApiKey, 'portable-luca-key');
  assert.equal(exported.settings.hyperApiKey, 'portable-hyper-key');
  assert.equal(exported.settings.imapByHost.gmail.pass, 'portable-imap-password');
  assert.equal(exported.settings.licenseToken, undefined);
  assert.equal(exported.settings.managedProxyLists, undefined);
  assert.equal(exported.settings.nested.sessionToken, undefined);
  assert.equal(exported.accounts[0].password, 'portable-password');
  assert.equal(exported.accounts[0].cookie, undefined, 'site session cookie reached the cloud bundle');
  assert.equal(exported.accounts[0].auth.accessToken, undefined, 'nested account session reached the cloud bundle');
  assert.deepEqual(exported.proxies, { lists: initial.proxies.lists });
  assert.equal(JSON.stringify(exported).includes('remote:secret'), false, 'managed proxy reached the cloud bundle');
  const masterKey = Buffer.alloc(32, 7);
  const encrypted = cloudCrypto.encryptBundle(exported, masterKey, { appVersion: '1.6.93' });
  const decrypted = cloudCrypto.decryptBundle(encrypted.buffer, masterKey);
  assert.equal(decrypted.bundle.app, __test.LEGACY_APP_MARKER,
    'adapter output did not survive the manager crypto/schema boundary');

  const multiSiteBundle = {
    app: 'zyn', kind: 'settings-export', version: 2, exportedAt: Date.now(),
    accounts: [
      { id: 'same-target', site: 'target', email: 'same@example.com', password: 'target-password' },
      { id: 'same-bandai', site: 'bandai', email: 'same@example.com', password: 'bandai-password' },
    ],
  };
  assert.equal(adapter.previewImport(multiSiteBundle, 'replace').accounts, 2);
  assert.equal(adapter.importAll(multiSiteBundle, 'replace').accounts.set, 2);
  assert.deepEqual(read('accounts.json').map(account => account.id), ['same-target', 'same-bandai'],
    'same-email accounts from different sites did not survive restore');
  resetFiles();
  adapter = makeAdapter();

  const bundle = comprehensiveBundle();
  const beforePreview = walkFiles(directory);
  const preview = adapter.previewImport(bundle, 'merge');
  assert.equal(preview.taskGroups.total, 3);
  assert.equal(preview.taskGroups.supported, 2);
  assert.equal(preview.taskGroups.skippedUnsupported, 1);
  assert.deepEqual(preview.taskGroups.skippedBySite, { pokemoncenter: 1 });
  assert.equal(preview.warnings.length, 1);
  assert.deepEqual(walkFiles(directory), beforePreview, 'preview changed local data');

  const lossBundle = taskLossBundle();
  const lossPreview = adapter.validateAndPreview(lossBundle, 'merge');
  assert.equal(lossPreview.taskGroups.total, 1);
  assert.equal(lossPreview.taskGroups.supported, 1);
  assert.equal(lossPreview.taskGroups.skippedTasks, 4);
  assert.deepEqual(lossPreview.taskGroups.skippedTasksByReason, {
    overCapacity: 1,
    missingAccountId: 1,
    duplicateTaskId: 1,
    duplicateAccountId: 1,
    normalizationOther: 0,
  });
  assert.deepEqual(lossPreview.taskGroups.taskGroupLosses, [{
    groupId: 'loss-group',
    groupName: 'Loss regression',
    incomingTasks: 2001,
    keptTasks: 1997,
    skippedTasks: 4,
    skippedByReason: {
      overCapacity: 1,
      missingAccountId: 1,
      duplicateTaskId: 1,
      duplicateAccountId: 1,
      normalizationOther: 0,
    },
  }]);
  assert.match(lossPreview.warnings[0], /4 Target tasks will be skipped/);
  const lossSummary = adapter.importAll(lossBundle, 'merge');
  assert.equal(lossSummary.taskGroups.skippedTasks, 4);
  assert.deepEqual(lossSummary.taskGroups.skippedTasksByReason,
    lossPreview.taskGroups.skippedTasksByReason);
  assert.deepEqual(lossSummary.taskGroups.taskGroupLosses,
    lossPreview.taskGroups.taskGroupLosses);
  assert.equal(read('task-groups.json').groups.find(group => group.id === 'loss-group').tasks.length, 1997);
  resetFiles();
  adapter = makeAdapter();

  const merged = adapter.importAll(bundle, 'merge');
  assert.equal(merged.tasks.added, 1);
  assert.deepEqual(read('tasks.json').map(task => task.id), ['task-current', 'task-new']);
  assert.equal(fs.statSync(jsonPath('tasks.json')).mode & 0o777, 0o600);
  assert.equal(merged.targetTasks.added, 1);
  assert.equal(read('target-tasks.json').skus, '11111111\n22222222');
  assert.equal(merged.round1Profiles.added, 1);
  assert.equal(merged.round1Profiles.updated, 1);
  assert.equal(read('watchlist.json').raw, 'CURRENT\nNEW');
  assert.equal(merged.pokemonCenterTasks.added, 1);
  assert.equal(merged.taskGroups.skippedUnsupported, 1);
  assert.deepEqual(read('task-groups.json').groups.map(group => group.id),
    ['group-current', 'group-new', 'pokemon-rollback'],
    'merge restore erased a raw rollback task group');
  assert.deepEqual(read('task-groups.json').groups.at(-1), initial.taskGroups.at(-1),
    'merge restore changed the raw rollback task group');
  assert.equal(merged.warnings.length, 1);
  assert.equal(taskGroupSyncs.at(-1).summary.skippedUnsupported, 1);
  assert.equal(baseImports.at(-1).bundle.settings, undefined);
  assert.equal(baseImports.at(-1).bundle.accounts[0].cookie, undefined);
  assert.deepEqual(baseImports.at(-1).bundle.proxies, {
    lists: [{ name: 'Imported local', raw: 'imported.example:9000:user:pass' }],
  });
  const mergedSettings = read('settings.json');
  assert.equal(mergedSettings.licenseToken, 'local-license-session');
  assert.equal(mergedSettings.nested.sessionToken, 'local-nested-session');
  assert.equal(mergedSettings.aycdApiKey, 'new-aycd-key');
  assert.equal(mergedSettings.hcaptchaApiKey, 'enc:new-hcaptcha-key', 'settings owner did not re-encrypt key');
  assert.deepEqual(mergedSettings.profileGroups.sort(), ['Existing', 'Imported']);
  assert.match(read('profiles.json').find(profile => profile.id === 'profile-new').imap.password, /^enc:/,
    'profile owner did not re-encrypt mailbox password');

  // Replace accepts a Zyn marker, canonicalizes for the compatibility importer, replaces portable
  // data, and still preserves local license/session state that does not belong to the backup.
  const replaced = adapter.importAll(comprehensiveBundle('zyn'), 'replace');
  assert.equal(replaced.tasks.set, 2);
  assert.equal(baseImports.at(-1).bundle.app, __test.LEGACY_APP_MARKER);
  const replacedSettings = read('settings.json');
  assert.equal(replacedSettings.licenseToken, 'local-license-session');
  assert.equal(replacedSettings.nested.sessionToken, 'local-nested-session');
  assert.equal(replacedSettings.discordBotToken, 'new-discord-token');
  assert.equal(replacedSettings.hcaptchaApiKey, 'enc:new-hcaptcha-key');
  assert.equal(read('task-groups.json').groups.some(group => group.id === 'pokemon-rollback'), false,
    'replace restore retained an existing legacy task group');

  // A failure in the last persistence section must put every earlier file and task-group backup
  // byte-for-byte back for both restore modes.
  for (const mode of ['merge', 'replace']) {
    resetFiles();
    if (mode === 'merge') {
      fs.unlinkSync(jsonPath('watchlist.json'));
      fs.unlinkSync(jsonPath('pokemon-center-tasks.json'));
    }
    adapter = makeAdapter();
    const before = walkFiles(directory);
    const syncsBefore = taskGroupSyncs.length;
    failureStage = 'task-groups-after-write';
    assert.throws(
      () => adapter.importAll(comprehensiveBundle(), mode),
      error => error.code === 'CLOUD_BACKUP_RESTORE_ROLLED_BACK' && /No local changes were kept/.test(error.message),
    );
    failureStage = '';
    assert.deepEqual(walkFiles(directory), before, `${mode} restore was not fully rolled back`);
    assert.equal(taskGroupSyncs.length, syncsBefore + 1, 'rollback did not resync task-group runtime state');
    assert.equal(taskGroupSyncs.at(-1).summary.rolledBack, true);
    assert.equal(fs.existsSync(transactionDirectory) ? fs.readdirSync(transactionDirectory).length : 0, 0,
      'successful rollback left a recovery payload behind');
  }

  // A process crash cannot run the catch block. A ready snapshot left on disk is recovered during
  // adapter construction before any new export, preview, or restore is allowed.
  resetFiles();
  const beforeCrash = walkFiles(directory);
  __test.createRestoreSnapshot(directory, taskGroupPath);
  write('settings.json', { corruptedByInterruptedRestore: true });
  write('tasks.json', [{ id: 'corrupted-by-interrupted-restore' }]);
  const syncsBeforeRecovery = taskGroupSyncs.length;
  adapter = makeAdapter();
  assert.deepEqual(walkFiles(directory), beforeCrash, 'startup did not recover the interrupted restore');
  assert.equal(taskGroupSyncs.length, syncsBeforeRecovery + 1);
  assert.equal(taskGroupSyncs.at(-1).summary.recoveredTransactions, 1);

  // Invalid bundles are rejected before snapshot creation or any owning importer is called.
  const filesBeforeInvalid = walkFiles(directory);
  const importCallsBeforeInvalid = baseImports.length;
  assert.throws(() => adapter.importAll({ app: 'foreign', tasks: [] }), /Not a Zyn backup/);
  assert.throws(() => adapter.importAll({
    app: 'zyn', kind: 'settings-export', version: 2, exportedAt: Date.now(), tasks: 'not-an-array',
  }), /tasks must be a list/);
  assert.throws(() => adapter.importAll({
    app: 'zyn', kind: 'settings-export', version: 3, exportedAt: Date.now(), tasks: [],
  }), /version is not supported/);
  const unsafe = JSON.parse(`{"app":"zyn","kind":"settings-export","version":2,"exportedAt":${Date.now()},"settings":{"__proto__":{"polluted":true}}}`);
  assert.throws(() => adapter.importAll(unsafe), /unsafe field name/);
  assert.equal({}.polluted, undefined);
  assert.throws(() => adapter.importAll(comprehensiveBundle(), 'overwrite'), /merge or replace/);
  assert.equal(baseImports.length, importCallsBeforeInvalid, 'invalid backup wrote through the base importer');
  assert.deepEqual(walkFiles(directory), filesBeforeInvalid, 'invalid backup changed local data');

  console.log(JSON.stringify({
    ok: true,
    canonicalLegacyMarker: true,
    portableUserSecretsReencrypted: true,
    operatorAndSessionStateExcluded: true,
    managedProxyCredentialsExcluded: true,
    adapterManagerRoundTrip: true,
    accurateUnsupportedGroupPreview: true,
    accurateTaskNormalizationLosses: true,
    mergeAndReplaceTransactions: true,
    interruptedRestoreRecovery: true,
  }, null, 2));
} finally {
  failureStage = '';
  if (directory.startsWith(os.tmpdir() + path.sep + 'zyn-cloud-backup-data-')) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
