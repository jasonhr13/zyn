#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createManagedProxyControl } = require('../launcher/managed-proxy-control');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hope-managed-proxies-'));
const proxyFile = path.join(root, 'proxies.json');
const read = () => JSON.parse(fs.readFileSync(proxyFile, 'utf8'));
const write = value => fs.writeFileSync(proxyFile, `${JSON.stringify(value, null, 2)}\n`);
write({ lists: [{ name: 'Personal', raw: 'local.example:8000:user:pass' }] });

const dataManager = {
  getProxies: read,
  saveProxyList(name, raw) {
    const data = read();
    const index = data.lists.findIndex(list => list.name === name);
    if (index >= 0) data.lists[index] = { name, raw }; else data.lists.push({ name, raw });
    write(data);
  },
  deleteProxyList(name) {
    const data = read();
    data.lists = data.lists.filter(list => list.name !== name);
    write(data);
  },
  getProxyLines(name) {
    const list = read().lists.find(item => item.name === name);
    return list ? list.raw.split('\n').filter(Boolean) : [];
  },
  exportAll: () => ({ proxies: read() }),
};

let stopped = 0;
const catalogs = [];
const control = createManagedProxyControl({
  dataManager,
  random: () => 0.99,
  onCredentialsChanged: () => { stopped += 1; },
  onCatalog: catalog => catalogs.push(catalog),
  logger: { warn() {} },
});

const id = '11111111-2222-4333-8444-555555555555';
const ref = `managed:${id}`;
const secretOne = 'remote-one.example:9000:remote-user:remote-pass';
const secretTwo = 'remote-two.example:9001:second-user:second-pass';
const revisionOne = 'a'.repeat(64);
const revisionTwo = 'b'.repeat(64);

try {
  assert.equal(control.applyLicenseResult({
    proxyAccess: true,
    proxyRevision: revisionOne,
    proxyListsChanged: true,
    proxyListCount: 1,
    managedProxyLists: [{ id, name: 'Admin Residential', raw: `${secretOne}\n${secretTwo}` }],
  }), 1);
  const catalog = dataManager.getProxies();
  assert.equal(catalog.lists.length, 2);
  assert.deepEqual(catalog.lists[1], {
    id, ref, name: 'Admin Residential', label: 'Admin Residential', managed: true, count: 2,
  });
  assert.equal(JSON.stringify(catalog).includes('remote-pass'), false, 'catalog leaked managed credentials');
  assert.deepEqual(control.getProxyLines(ref), [secretOne, secretTwo]);
  assert.equal(control.pickProxyLine(ref), secretTwo);
  assert.deepEqual(control.getProxyLines('Personal'), ['local.example:8000:user:pass']);
  assert.equal(fs.readFileSync(proxyFile, 'utf8').includes('remote-pass'), false, 'managed proxy reached proxies.json');
  assert.equal(JSON.stringify(dataManager.exportAll()).includes('remote-pass'), false, 'managed proxy reached backup export');
  assert.equal(dataManager.saveProxyList(ref, 'attacker:1'), false);
  assert.equal(dataManager.deleteProxyList(ref), false);

  const pushesBeforeUnchanged = catalogs.length;
  assert.equal(control.applyLicenseResult({
    proxyAccess: true,
    proxyRevision: revisionOne,
    proxyListsChanged: false,
    proxyListCount: 1,
  }), 1);
  assert.equal(catalogs.length, pushesBeforeUnchanged, 'unchanged validation rebuilt the catalog');
  assert.deepEqual(control.getProxyLines(ref), [secretOne, secretTwo]);

  control.applyLicenseResult({
    proxyAccess: true,
    proxyRevision: revisionTwo,
    proxyListsChanged: true,
    proxyListCount: 1,
    managedProxyLists: [{ id, name: 'Admin Residential', raw: secretTwo }],
  });
  assert.equal(stopped, 1, 'credential replacement did not stop running tasks');

  control.applyLicenseResult({
    proxyAccess: false,
    proxyRevision: '',
    proxyListsChanged: true,
    proxyListCount: 0,
    managedProxyLists: [],
  });
  assert.equal(stopped, 2, 'access removal did not stop running tasks');
  assert.throws(() => control.getProxyLines(ref), error => error.code === 'MANAGED_PROXY_UNAVAILABLE');
  assert.equal(dataManager.getProxies().lists.length, 1);

  console.log(JSON.stringify({
    ok: true,
    memoryOnly: true,
    rendererCatalogSafe: true,
    localListsPreserved: true,
    stableManagedRef: ref,
    credentialsChangedStopsTasks: stopped,
  }, null, 2));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
