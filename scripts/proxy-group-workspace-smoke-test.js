#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createProxyGroupControl } = require('../launcher/proxy-group-control');

const root = path.resolve(__dirname, '..');
const readSource = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zyn-proxy-groups-'));
const proxyFile = path.join(directory, 'proxies.json');
fs.writeFileSync(proxyFile, JSON.stringify({
  lists: [
    { name: 'Residential', raw: 'one.example:8000:user:pass' },
    { name: 'ISP', raw: 'two.example:9000:user:pass' },
  ],
}, null, 2));

const dataManager = {
  getProxies: () => ({ lists: [] }),
  saveProxyList() {},
  deleteProxyList() {},
  getProxyLines: () => [],
  exportAll: () => ({ app: 'test', proxies: JSON.parse(fs.readFileSync(proxyFile, 'utf8')) }),
  importAll(bundle, mode = 'merge') {
    if (!bundle || !bundle.proxies) return {};
    if (mode === 'replace') fs.writeFileSync(proxyFile, JSON.stringify(bundle.proxies, null, 2));
    else {
      const current = JSON.parse(fs.readFileSync(proxyFile, 'utf8'));
      const byName = new Map(current.lists.map(list => [list.name, list]));
      for (const list of bundle.proxies.lists || []) {
        if (byName.has(list.name)) byName.get(list.name).raw = list.raw;
        else current.lists.push({ name: list.name, raw: list.raw });
      }
      fs.writeFileSync(proxyFile, JSON.stringify(current, null, 2));
    }
    return { proxies: { ok: true } };
  },
};
const control = createProxyGroupControl({ dataDirectory: directory, dataManager, logger: { warn() {} } });

assert.deepEqual(control.getGroups(), []);
assert.equal(control.createGroup('Target'), 'Target');
assert.deepEqual(control.getGroups(), ['Target']);
assert.equal(control.addListsToGroup(['Residential', 'managed:not-local'], 'Target'), 1);
assert.deepEqual(dataManager.getProxies().lists.find(list => list.name === 'Residential').groups, ['Target']);
assert.equal(JSON.stringify(dataManager.getProxies()).includes('managed:not-local'), false,
  'a managed proxy ref was persisted into local proxy organization');

dataManager.saveProxyList('Residential', 'updated.example:8000:user:pass');
assert.deepEqual(dataManager.getProxies().lists.find(list => list.name === 'Residential').groups, ['Target'],
  'editing a proxy list erased its group membership');
assert.deepEqual(dataManager.getProxyLines('Residential'), ['updated.example:8000:user:pass']);

assert.equal(control.renameGroup('Target', 'Drops'), 'Drops');
assert.deepEqual(control.getGroups(), ['Drops']);
assert.deepEqual(dataManager.getProxies().lists.find(list => list.name === 'Residential').groups, ['Drops']);
assert.equal(control.deleteGroup('Drops'), 1);
assert.deepEqual(control.getGroups(), []);
assert.deepEqual(dataManager.getProxies().lists.map(list => list.name).sort(), ['ISP', 'Residential']);
assert.throws(() => control.createGroup('Managed Proxies'), /reserved by Zyn/);
assert.throws(() => control.createGroup('ResiFactory'), /reserved by Zyn/);

control.createGroup('Archive');
control.addListsToGroup(['ISP'], 'Archive');
assert.deepEqual(dataManager.exportAll().proxies.groups, ['Archive'],
  'proxy group registration was omitted from backup export');
dataManager.importAll({ proxies: {
  groups: ['Imported Empty Group'],
  lists: [{ name: 'Residential', raw: 'restored.example:8000:user:pass', groups: ['Restored'] }],
} }, 'merge');
assert.deepEqual(control.getGroups(), ['Archive', 'Imported Empty Group', 'Restored']);
assert.deepEqual(dataManager.getProxies().lists.find(list => list.name === 'Residential').groups, ['Restored'],
  'merge restore discarded proxy-list group membership');

const page = readSource('frontend/src/components/pages/proxies.js');
const styles = readSource('frontend/src/App.css');
const bootstrap = readSource('launcher/bootstrap.js');
const taskGroups = readSource('frontend/src/components/pages/task-groups.js');

assert.match(page, /className="profiles-shell proxies-shell"/,
  'Proxies does not use the grouped Profiles workspace layout');
assert.match(page, /Managed Proxies[\s\S]*Provided by Zyn/,
  'managed proxy lists do not have a dedicated system group');
assert.match(page, /addProxyListsToGroup[\s\S]*removeProxyListsFromGroup/,
  'local proxy lists cannot be assigned to and removed from groups');
assert.match(page, /list\.managed \? <i className="ion-md-lock/,
  'managed proxy lists are not rendered read-only');
assert.match(page, /profile-row-check\$\{list\.managed \? ' proxy-managed-indicator' : ''\}/,
  'managed proxy locks still inherit the selectable checkbox container');
assert.match(styles, /\.proxy-list-table-head,[\s\S]{0,180}grid-template-columns:/,
  'proxy lists do not use a structured row layout');
assert.match(styles, /\.proxy-managed-indicator\s*\{[^}]*border:\s*0;[^}]*background:\s*transparent;/,
  'managed proxy locks still render with the checkbox square behind them');
assert.match(taskGroups, /form-label task-account-section-label/,
  'the Add Tasks Accounts heading lacks its dedicated spacing hook');
assert.match(taskGroups, /toggleSelectAllAccounts/,
  'the Add Tasks modal cannot select every unused Target account at once');
assert.match(taskGroups, /Select all/,
  'the Add Tasks modal is missing a Select all control');
assert.match(styles, /\.task-account-section-label\s*\{[^}]*margin-top:/,
  'the Add Tasks Accounts heading is still crowded against the preceding card');
for (const channel of ['createProxyGroup', 'renameProxyGroup', 'deleteProxyGroup', 'addProxyListsToGroup', 'removeProxyListsFromGroup']) {
  assert.match(bootstrap, new RegExp(`'${channel}'`), `proxy group IPC omits ${channel}`);
}
assert.match(page, /RESIFACTORY_PROXIES/, 'ResiFactory is not a dedicated Proxies subsection');
assert.match(page, /Providers[\s\S]*RESIFACTORY_PROXIES/, 'ResiFactory is not listed under Providers');
assert.match(page, /resifactory-host\$\{resiFactory \? '' : ' hidden'\}/, 'ResiFactory remounts instead of staying hidden off-section');
assert.match(page, /ResiFactoryPanel/, 'Proxies is missing the ResiFactory panel');
assert.match(bootstrap, /installResiFactoryIpc/, 'bootstrap does not install ResiFactory IPC');
const resiFactory = readSource('launcher/resifactory-control.js');
for (const channel of ['resiFactoryConnect', 'resiFactoryGenerate', 'resiFactoryStartTopup']) {
  assert.match(resiFactory, new RegExp(`'${channel}'`), `ResiFactory IPC omits ${channel}`);
}

console.log('Proxy grouping workspace and persistence smoke test passed');
