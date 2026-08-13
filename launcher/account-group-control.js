'use strict';

// Account organization is deliberately stored separately from accounts.json. The original data
// manager remains the sole owner of encrypted credentials; this file contains only group names and
// account IDs, then decorates safe account records returned to the renderer.
const fs = require('fs');
const path = require('path');

const ACCOUNT_GROUP_FILE = 'account-groups.json';
const RESERVED_GROUPS = new Set(['all accounts', 'ungrouped']);

function normalizeGroups(values) {
  const output = [];
  const seen = new Set();
  for (const value of (Array.isArray(values) ? values : [])) {
    const group = String(value || '').trim().slice(0, 80);
    const key = group.toLowerCase();
    if (!group || seen.has(key)) continue;
    seen.add(key);
    output.push(group);
  }
  return output;
}

function accountKey(account) {
  const email = String(account && account.email || '').trim().toLowerCase();
  const site = String(account && account.site || '').trim().toLowerCase() || 'bandai';
  return email ? JSON.stringify([site, email]) : '';
}

function embeddedGroups(account) {
  return normalizeGroups([
    ...(Array.isArray(account && account.groups) ? account.groups : []),
    account && account.group,
  ]);
}

function createAccountGroupControl({ dataDirectory, dataManager } = {}) {
  if (!dataDirectory) throw new Error('account group dataDirectory is required');
  if (!dataManager || typeof dataManager !== 'object') throw new Error('account group dataManager is required');
  if (typeof dataManager.getAccounts !== 'function') throw new Error('account group dataManager.getAccounts is required');

  const groupPath = path.join(dataDirectory, ACCOUNT_GROUP_FILE);
  const originalGetAccounts = dataManager.getAccounts.bind(dataManager);
  const originalExportAll = typeof dataManager.exportAll === 'function'
    ? dataManager.exportAll.bind(dataManager) : null;
  const originalImportAll = typeof dataManager.importAll === 'function'
    ? dataManager.importAll.bind(dataManager) : null;

  const read = () => {
    let value = {};
    try { value = JSON.parse(fs.readFileSync(groupPath, 'utf8')); } catch {}
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const memberships = {};
    const rawMemberships = source.memberships && typeof source.memberships === 'object'
      && !Array.isArray(source.memberships) ? source.memberships : {};
    for (const [id, groups] of Object.entries(rawMemberships)) {
      const cleanId = String(id || '').trim().slice(0, 200);
      const cleanGroups = normalizeGroups(groups);
      if (cleanId && cleanGroups.length) memberships[cleanId] = cleanGroups;
    }
    const groups = normalizeGroups([
      ...(Array.isArray(source.groups) ? source.groups : []),
      ...Object.values(memberships).flat(),
    ]).sort((left, right) => left.localeCompare(right));
    return { version: 1, groups, memberships };
  };

  const write = value => {
    fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    const temporary = `${groupPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, groupPath);
    fs.chmodSync(groupPath, 0o600);
  };

  const rawAccounts = () => {
    const accounts = originalGetAccounts();
    return Array.isArray(accounts) ? accounts : [];
  };

  const cleanGroup = name => {
    const group = String(name || '').trim().slice(0, 80);
    if (!group) throw new Error('Group name is required');
    if (RESERVED_GROUPS.has(group.toLowerCase())) throw new Error(`“${group}” is reserved by Zyn`);
    return group;
  };

  const decorate = (accounts, state = read()) => (Array.isArray(accounts) ? accounts : []).map(account => {
    const id = String(account && account.id || '');
    return { ...account, groups: normalizeGroups(state.memberships[id]) };
  });

  function getAccounts() { return decorate(rawAccounts()); }
  function getGroups() { return read().groups; }

  function createGroup(name) {
    const requested = cleanGroup(name);
    const state = read();
    const existing = state.groups.find(group => group.toLowerCase() === requested.toLowerCase());
    if (existing) return existing;
    state.groups = normalizeGroups([...state.groups, requested]).sort((left, right) => left.localeCompare(right));
    write(state);
    return requested;
  }

  function renameGroup(from, to) {
    const requested = String(from || '').trim();
    const replacement = cleanGroup(to);
    const state = read();
    const source = state.groups.find(group => group.toLowerCase() === requested.toLowerCase());
    if (!source) throw new Error(`Account group “${requested}” was not found`);
    const collision = state.groups.find(group => group.toLowerCase() === replacement.toLowerCase()
      && group.toLowerCase() !== source.toLowerCase());
    if (collision) throw new Error(`Account group “${collision}” already exists`);
    state.groups = normalizeGroups(state.groups.map(group => (
      group.toLowerCase() === source.toLowerCase() ? replacement : group
    ))).sort((left, right) => left.localeCompare(right));
    for (const [id, groups] of Object.entries(state.memberships)) {
      state.memberships[id] = normalizeGroups(groups.map(group => (
        group.toLowerCase() === source.toLowerCase() ? replacement : group
      )));
    }
    write(state);
    return replacement;
  }

  function deleteGroup(name) {
    const requested = String(name || '').trim().toLowerCase();
    if (!requested) return 0;
    const state = read();
    if (!state.groups.some(group => group.toLowerCase() === requested)) return 0;
    let affected = 0;
    state.groups = state.groups.filter(group => group.toLowerCase() !== requested);
    for (const [id, groups] of Object.entries(state.memberships)) {
      if (!groups.some(group => group.toLowerCase() === requested)) continue;
      affected += 1;
      const remaining = groups.filter(group => group.toLowerCase() !== requested);
      if (remaining.length) state.memberships[id] = remaining;
      else delete state.memberships[id];
    }
    write(state);
    return affected;
  }

  function addAccountsToGroup(ids, group) {
    const requested = createGroup(group);
    const validIds = new Set(rawAccounts().map(account => String(account && account.id || '')).filter(Boolean));
    const wanted = new Set((Array.isArray(ids) ? ids : [ids]).map(String).filter(id => validIds.has(id)));
    const state = read();
    let affected = 0;
    for (const id of wanted) {
      const memberships = normalizeGroups(state.memberships[id]);
      if (memberships.some(value => value.toLowerCase() === requested.toLowerCase())) continue;
      state.memberships[id] = [...memberships, requested];
      affected += 1;
    }
    if (affected) write(state);
    return affected;
  }

  function removeAccountsFromGroup(ids, group) {
    const requested = String(group || '').trim().toLowerCase();
    const wanted = new Set((Array.isArray(ids) ? ids : [ids]).map(String));
    const state = read();
    let affected = 0;
    for (const id of wanted) {
      const memberships = normalizeGroups(state.memberships[id]);
      if (!memberships.some(value => value.toLowerCase() === requested)) continue;
      const remaining = memberships.filter(value => value.toLowerCase() !== requested);
      if (remaining.length) state.memberships[id] = remaining;
      else delete state.memberships[id];
      affected += 1;
    }
    if (affected) write(state);
    return affected;
  }

  dataManager.getAccounts = getAccounts;
  if (originalExportAll) {
    dataManager.exportAll = (...args) => {
      const bundle = originalExportAll(...args);
      const state = read();
      const accounts = decorate(Array.isArray(bundle && bundle.accounts) ? bundle.accounts : rawAccounts(), state);
      return { ...bundle, accounts, accountGroups: { version: 1, groups: state.groups } };
    };
  }
  if (originalImportAll) {
    dataManager.importAll = (bundle, mode = 'merge') => {
      const incoming = bundle && typeof bundle === 'object' ? bundle : {};
      const incomingAccounts = Array.isArray(incoming.accounts) ? incoming.accounts : [];
      const portable = { ...incoming };
      delete portable.accountGroups;
      if (incomingAccounts.length) {
        portable.accounts = incomingAccounts.map(account => {
          const clean = { ...account };
          delete clean.groups;
          delete clean.group;
          return clean;
        });
      }
      const summary = originalImportAll(portable, mode);
      if (!incomingAccounts.length && !incoming.accountGroups) return summary;

      const state = mode === 'replace' ? { version: 1, groups: [], memberships: {} } : read();
      state.groups = normalizeGroups([
        ...state.groups,
        ...(Array.isArray(incoming.accountGroups && incoming.accountGroups.groups)
          ? incoming.accountGroups.groups : []),
        ...incomingAccounts.flatMap(embeddedGroups),
      ]).sort((left, right) => left.localeCompare(right));
      const current = rawAccounts();
      const byId = new Map(current.map(account => [String(account && account.id || ''), account]));
      const byKey = new Map(current.map(account => [accountKey(account), account]).filter(([key]) => key));
      for (const account of incomingAccounts) {
        const groups = embeddedGroups(account);
        if (!groups.length) continue;
        const match = byId.get(String(account && account.id || '')) || byKey.get(accountKey(account));
        const id = String(match && match.id || '');
        if (!id) continue;
        state.memberships[id] = mode === 'replace'
          ? groups : normalizeGroups([...(state.memberships[id] || []), ...groups]);
      }
      write(state);
      return summary;
    };
  }

  return Object.freeze({
    getAccounts, getGroups, createGroup, renameGroup, deleteGroup,
    addAccountsToGroup, removeAccountsFromGroup, groupPath,
  });
}

module.exports = { normalizeGroups, accountKey, createAccountGroupControl };
