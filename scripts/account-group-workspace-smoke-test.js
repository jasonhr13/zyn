#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAccountGroupControl } = require('../launcher/account-group-control');

const root = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zyn-account-groups-'));
let accounts = [
  { id: 'account-1', site: 'target', email: 'one@example.com', hasPassword: true },
  { id: 'account-2', site: 'target', email: 'two@example.com', hasPassword: true },
];
const dataManager = {
  getAccounts: () => accounts.map(account => ({ ...account })),
  exportAll: () => ({
    app: 'zyn', kind: 'settings-export', version: 2, exportedAt: Date.now(),
    accounts: accounts.map(account => ({ ...account, password: 'portable-secret' })),
  }),
  importAll(bundle, mode) {
    const incoming = (bundle.accounts || []).map(account => ({ ...account }));
    if (mode === 'replace') accounts = incoming;
    else {
      const keys = new Set(accounts.map(account => `${account.site}:${account.email}`));
      for (const account of incoming) {
        const key = `${account.site}:${account.email}`;
        if (!keys.has(key)) { accounts.push(account); keys.add(key); }
      }
    }
    return { accounts: { added: incoming.length } };
  },
};

const control = createAccountGroupControl({ dataDirectory: directory, dataManager });
assert.deepEqual(control.getGroups(), []);
assert.equal(control.createGroup('Primary'), 'Primary');
assert.equal(control.addAccountsToGroup(['account-1', 'missing'], 'Primary'), 1);
assert.deepEqual(dataManager.getAccounts().find(account => account.id === 'account-1').groups, ['Primary']);
assert.equal(JSON.stringify(fs.readFileSync(control.groupPath, 'utf8')).includes('portable-secret'), false,
  'account organization persisted a credential');

assert.equal(control.renameGroup('Primary', 'Drops'), 'Drops');
assert.deepEqual(dataManager.getAccounts().find(account => account.id === 'account-1').groups, ['Drops']);
assert.equal(control.removeAccountsFromGroup(['account-1'], 'Drops'), 1);
assert.deepEqual(dataManager.getAccounts().find(account => account.id === 'account-1').groups, []);
assert.equal(control.deleteGroup('Drops'), 0);
assert.throws(() => control.createGroup('All Accounts'), /reserved by Zyn/);

control.createGroup('Empty Group');
control.createGroup('Target');
control.addAccountsToGroup(['account-2'], 'Target');
const exported = dataManager.exportAll();
assert.deepEqual(exported.accountGroups.groups, ['Empty Group', 'Target']);
assert.deepEqual(exported.accounts.find(account => account.id === 'account-2').groups, ['Target']);

dataManager.importAll({
  accounts: [{ id: 'remote-id', site: 'target', email: 'one@example.com', groups: ['Imported'] }],
  accountGroups: { groups: ['Imported Empty'] },
}, 'merge');
assert.deepEqual(dataManager.getAccounts().find(account => account.id === 'account-1').groups, ['Imported'],
  'merge restore did not match an existing account by site and email');
assert.deepEqual(control.getGroups(), ['Empty Group', 'Imported', 'Imported Empty', 'Target']);

const stored = JSON.parse(fs.readFileSync(control.groupPath, 'utf8'));
assert.equal(JSON.stringify(stored).includes('one@example.com'), false,
  'account organization persisted an email address');

const pagePath = path.join(root, 'frontend/src/components/pages/accounts.js');
const stylesPath = path.join(root, 'frontend/src/App.css');
if (fs.existsSync(pagePath)) {
  const page = fs.readFileSync(pagePath, 'utf8');
  const styles = fs.readFileSync(stylesPath, 'utf8');
  assert.match(page, /className="profiles-shell accounts-shell"/,
    'Accounts does not use the shared grouped workspace layout');
  assert.match(page, /addAccountsToGroup[\s\S]*removeAccountsFromGroup/,
    'Accounts does not expose group assignment controls');
  assert.match(page, /ACCOUNTS_WORKSPACE_KEY/,
    'Accounts does not restore the last group and selection');
  assert.match(styles, /\.account-list-table-head,[\s\S]{0,220}grid-template-columns:/,
    'Accounts does not use a structured grouped table');
  assert.match(page, /<span>Session<\/span>/,
    'Accounts does not show a session column');
  assert.match(page, /account\.hasSession \? 'Signed in' : 'No session'/,
    'Accounts does not label saved login cookies');
  assert.match(styles, /\.account-row-session\.configured > strong \{ color: var\(--target-status-success\); \}/,
    'Accounts session status is not green');
}

const dataManagerSource = fs.readFileSync(path.join(root, 'runtime-app/public/helpers/data-manager.js'), 'utf8');
assert.match(dataManagerSource, /hasSession: Boolean\(String\(cookie \|\| ''\)\.trim\(\)\)/,
  'renderer accounts do not expose a session flag');
assert.match(dataManagerSource, /\{ password, cookie, \.\.\.rest \}/,
  'renderer accounts still include the session cookie');
const pageHandler = fs.readFileSync(path.join(root, 'frontend/src/components/page-handler.js'), 'utf8');
assert.match(pageHandler, /accountsUpdated/,
  'the renderer does not refresh accounts when a session cookie is saved');

console.log('Account grouping workspace and credential-safe persistence smoke test passed');
