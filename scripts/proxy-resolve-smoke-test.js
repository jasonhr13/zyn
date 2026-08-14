#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const {
  parseProxyRef,
  groupRef,
  resolveProxyAssignment,
  assignmentHasLines,
  displayProxyGroup,
} = require('../launcher/proxy-resolve');

assert.deepEqual(parseProxyRef(''), { kind: 'local', label: 'Local', name: '' });
assert.deepEqual(parseProxyRef('Residential'), { kind: 'list', label: 'Residential', name: 'Residential' });
assert.equal(groupRef('Friday mix'), 'group:Friday mix');
assert.equal(displayProxyGroup('group:Friday mix'), 'Friday mix');

const lists = {
  Resi: ['1.1.1.1:8000:user:pass'],
  ISP: ['2.2.2.2:8000'],
  Empty: [],
};
const proxies = {
  lists: [
    { name: 'Resi', groups: ['Friday mix'] },
    { name: 'ISP', groups: ['Friday mix'] },
    { name: 'Empty', groups: ['Friday mix'] },
    { name: 'Other', groups: ['Unused'] },
  ],
};

const folder = resolveProxyAssignment('group:Friday mix', {
  getProxyLines: name => lists[name] || [],
  getProxies: () => proxies,
});
assert.equal(folder.kind, 'group');
assert.deepEqual(folder.sources.map(source => source.name), ['Resi', 'ISP']);
assert.equal(assignmentHasLines(folder), true);

const empty = resolveProxyAssignment('group:Missing', {
  getProxyLines: name => lists[name] || [],
  getProxies: () => proxies,
});
assert.equal(assignmentHasLines(empty), false);

const single = resolveProxyAssignment('Residential', {
  getProxyLines: () => ['9.9.9.9:8000'],
  getProxies: () => proxies,
});
assert.equal(single.kind, 'list');
assert.equal(single.sources[0].lines.length, 1);

console.log('Proxy folder resolve smoke test passed');
