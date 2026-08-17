'use strict';

// Local proxy-list organization. Managed proxy credentials stay owned by managed-proxy-control;
// this adapter sees only locally persisted lists and never writes remote catalog entries to disk.
const fs = require('fs');
const path = require('path');

const PROXY_FILE = 'proxies.json';
const RESERVED_GROUPS = new Set(['all proxy lists', 'managed proxies', 'ungrouped', 'resifactory']);

function normalizeGroups(values) {
  const output = [];
  const seen = new Set();
  for (const raw of (Array.isArray(values) ? values : [])) {
    const group = String(raw || '').trim().slice(0, 80);
    const key = group.toLowerCase();
    if (!group || seen.has(key)) continue;
    seen.add(key);
    output.push(group);
  }
  return output;
}

function groupsForList(list) {
  return normalizeGroups([
    ...(Array.isArray(list && list.groups) ? list.groups : []),
    list && list.group,
  ]);
}

function createProxyGroupControl({ dataDirectory, dataManager, logger = console } = {}) {
  if (!dataDirectory) throw new Error('proxy group dataDirectory is required');
  if (!dataManager || typeof dataManager !== 'object') throw new Error('proxy group dataManager is required');

  const proxyPath = path.join(dataDirectory, PROXY_FILE);
  const read = () => {
    let value = { lists: [], groups: [] };
    try { value = JSON.parse(fs.readFileSync(proxyPath, 'utf8')); } catch {}
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const lists = (Array.isArray(source.lists) ? source.lists : []).flatMap(list => {
      const name = String((list && list.name) || '').trim();
      if (!name) return [];
      return [{ ...list, name, raw: String(list.raw || ''), groups: groupsForList(list) }];
    });
    const groups = normalizeGroups([
      ...(Array.isArray(source.groups) ? source.groups : []),
      ...lists.flatMap(groupsForList),
    ]).sort((left, right) => left.localeCompare(right));
    return { ...source, lists, groups };
  };
  const write = value => {
    fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    const temporary = `${proxyPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, proxyPath);
    fs.chmodSync(proxyPath, 0o600);
  };
  const localList = (data, ref) => {
    const wanted = String(ref || '');
    return data.lists.find(list => list.name === wanted) || null;
  };
  const cleanGroup = name => {
    const group = String(name || '').trim().slice(0, 80);
    if (!group) throw new Error('Group name is required');
    if (RESERVED_GROUPS.has(group.toLowerCase())) throw new Error(`“${group}” is reserved by Zyn`);
    return group;
  };

  function getGroups() { return read().groups; }

  function createGroup(name) {
    const requested = cleanGroup(name);
    const data = read();
    const existing = data.groups.find(group => group.toLowerCase() === requested.toLowerCase());
    if (existing) return existing;
    data.groups = normalizeGroups([...data.groups, requested]).sort((left, right) => left.localeCompare(right));
    write(data);
    return requested;
  }

  function renameGroup(from, to) {
    const requested = String(from || '').trim();
    const replacement = cleanGroup(to);
    const data = read();
    const source = data.groups.find(group => group.toLowerCase() === requested.toLowerCase());
    if (!source) throw new Error(`Proxy group “${requested}” was not found`);
    const collision = data.groups.find(group => group.toLowerCase() === replacement.toLowerCase()
      && group.toLowerCase() !== source.toLowerCase());
    if (collision) throw new Error(`Proxy group “${collision}” already exists`);
    data.groups = normalizeGroups(data.groups.map(group => (
      group.toLowerCase() === source.toLowerCase() ? replacement : group
    ))).sort((left, right) => left.localeCompare(right));
    data.lists = data.lists.map(list => ({
      ...list,
      groups: normalizeGroups(groupsForList(list).map(group => (
        group.toLowerCase() === source.toLowerCase() ? replacement : group
      ))),
    }));
    write(data);
    return replacement;
  }

  function deleteGroup(name) {
    const requested = String(name || '').trim().toLowerCase();
    if (!requested) return 0;
    const data = read();
    const source = data.groups.find(group => group.toLowerCase() === requested);
    if (!source) return 0;
    let affected = 0;
    data.groups = data.groups.filter(group => group.toLowerCase() !== requested);
    data.lists = data.lists.map(list => {
      const memberships = groupsForList(list);
      if (!memberships.some(group => group.toLowerCase() === requested)) return list;
      affected += 1;
      return { ...list, groups: memberships.filter(group => group.toLowerCase() !== requested) };
    });
    write(data);
    return affected;
  }

  function addListsToGroup(refs, group) {
    const requested = createGroup(group);
    const wanted = new Set((Array.isArray(refs) ? refs : [refs]).map(String));
    const data = read();
    let affected = 0;
    data.groups = normalizeGroups([...data.groups, requested]).sort((left, right) => left.localeCompare(right));
    data.lists = data.lists.map(list => {
      if (!wanted.has(list.name)) return list;
      const memberships = groupsForList(list);
      if (memberships.some(value => value.toLowerCase() === requested.toLowerCase())) return list;
      affected += 1;
      return { ...list, groups: [...memberships, requested] };
    });
    write(data);
    return affected;
  }

  function removeListsFromGroup(refs, group) {
    const requested = String(group || '').trim().toLowerCase();
    const wanted = new Set((Array.isArray(refs) ? refs : [refs]).map(String));
    const data = read();
    let affected = 0;
    data.lists = data.lists.map(list => {
      if (!wanted.has(list.name)) return list;
      const memberships = groupsForList(list);
      if (!memberships.some(value => value.toLowerCase() === requested)) return list;
      affected += 1;
      return { ...list, groups: memberships.filter(value => value.toLowerCase() !== requested) };
    });
    if (affected) write(data);
    return affected;
  }

  function getProxies() { return read(); }
  function saveProxyList(name, raw) {
    const cleanName = String(name || '').trim().slice(0, 120);
    if (!cleanName) return false;
    const data = read();
    const existing = localList(data, cleanName);
    if (existing) Object.assign(existing, { raw: String(raw || '').trim() });
    else data.lists.push({ name: cleanName, raw: String(raw || '').trim(), groups: [] });
    write(data);
    return true;
  }
  function deleteProxyList(name) {
    const data = read();
    const before = data.lists.length;
    data.lists = data.lists.filter(list => list.name !== String(name || ''));
    if (data.lists.length !== before) write(data);
    return data.lists.length !== before;
  }
  function getProxyLines(name) {
    const list = localList(read(), name);
    return list ? String(list.raw || '').split('\n').map(line => line.trim()).filter(Boolean) : [];
  }

  const originalExportAll = typeof dataManager.exportAll === 'function'
    ? dataManager.exportAll.bind(dataManager) : null;
  const originalImportAll = typeof dataManager.importAll === 'function'
    ? dataManager.importAll.bind(dataManager) : null;
  Object.assign(dataManager, { getProxies, saveProxyList, deleteProxyList, getProxyLines });
  if (originalExportAll) {
    dataManager.exportAll = (...args) => ({ ...originalExportAll(...args), proxies: getProxies() });
  }
  if (originalImportAll) {
    dataManager.importAll = (bundle, mode = 'merge') => {
      const incoming = bundle && typeof bundle === 'object' && bundle.proxies
        && typeof bundle.proxies === 'object' ? bundle.proxies : null;
      const summary = originalImportAll(bundle, mode);
      if (!incoming || !Array.isArray(incoming.lists)) return summary;
      if (mode === 'replace') {
        const lists = incoming.lists.flatMap(list => {
          const name = String((list && list.name) || '').trim();
          return name ? [{ name, raw: String(list.raw || ''), groups: groupsForList(list) }] : [];
        });
        const groups = normalizeGroups([
          ...(Array.isArray(incoming.groups) ? incoming.groups : []),
          ...lists.flatMap(groupsForList),
        ]).sort((left, right) => left.localeCompare(right));
        write({ lists, groups });
        return summary;
      }
      const data = read();
      const incomingByName = new Map(incoming.lists.map(list => [String((list && list.name) || ''), list]));
      data.lists = data.lists.map(list => {
        const arriving = incomingByName.get(list.name);
        return arriving ? { ...list, groups: normalizeGroups([...groupsForList(list), ...groupsForList(arriving)]) } : list;
      });
      data.groups = normalizeGroups([
        ...data.groups,
        ...(Array.isArray(incoming.groups) ? incoming.groups : []),
        ...incoming.lists.flatMap(groupsForList),
      ]).sort((left, right) => left.localeCompare(right));
      write(data);
      return summary;
    };
  }

  return Object.freeze({
    getGroups, createGroup, renameGroup, deleteGroup, addListsToGroup, removeListsFromGroup,
    groupsForList, proxyPath,
  });
}

module.exports = { normalizeGroups, groupsForList, createProxyGroupControl };
