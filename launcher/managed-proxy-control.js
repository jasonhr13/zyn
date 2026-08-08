'use strict';

// Remote managed-proxy credentials are deliberately held only in
// this main-process closure. Renderer-facing catalogs contain a stable ref, label, and count but
// never the raw proxy lines, and the archived data manager continues to persist local lists only.

const MANAGED_PREFIX = 'managed:';

function cleanRevision(value) {
  const revision = String(value || '').trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(revision) ? revision : '';
}

function normalizeManagedLists(lists) {
  const seen = new Set();
  return (Array.isArray(lists) ? lists : []).flatMap(item => {
    const id = String(item?.id || '').trim().toLowerCase();
    const name = String(item?.name || '').trim().slice(0, 80);
    const raw = String(item?.raw || '').replace(/\r/g, '').trim();
    if (!/^[0-9a-f-]{36}$/.test(id) || !name || seen.has(id)) return [];
    seen.add(id);
    const lines = raw.split('\n').map(line => line.trim()).filter(Boolean);
    return [{ id, ref: `${MANAGED_PREFIX}${id}`, name, raw: lines.join('\n'), count: lines.length, managed: true }];
  });
}

function createManagedProxyControl({
  dataManager,
  onCatalog = () => {},
  onCredentialsChanged = () => {},
  logger = console,
  random = Math.random,
} = {}) {
  if (!dataManager || typeof dataManager !== 'object') throw new Error('managed proxy dataManager is required');
  for (const method of ['getProxies', 'saveProxyList', 'deleteProxyList', 'getProxyLines']) {
    if (typeof dataManager[method] !== 'function') throw new Error(`managed proxy dataManager.${method} is required`);
  }

  const local = {
    getProxies: dataManager.getProxies.bind(dataManager),
    saveProxyList: dataManager.saveProxyList.bind(dataManager),
    deleteProxyList: dataManager.deleteProxyList.bind(dataManager),
    getProxyLines: dataManager.getProxyLines.bind(dataManager),
  };
  let managedProxyLists = [];
  let managedProxyRevision = null;

  const getProxyCatalog = () => {
    const stored = local.getProxies() || { lists: [] };
    const localLists = (Array.isArray(stored.lists) ? stored.lists : []).map(list => ({
      ...list,
      ref: String(list?.name || ''),
      label: String(list?.name || ''),
      managed: false,
      count: String(list?.raw || '').split('\n').filter(line => line.trim()).length,
    }));
    const remoteLists = managedProxyLists.map(({ id, ref, name, count }) => ({
      id, ref, name, label: name, managed: true, count,
    }));
    return { lists: [...localLists, ...remoteLists] };
  };

  const setManagedProxyLists = lists => {
    managedProxyLists = normalizeManagedLists(lists);
    return getProxyCatalog();
  };

  const getProxyLines = ref => {
    const wanted = String(ref || '');
    const managed = managedProxyLists.find(list => list.ref === wanted);
    if (managed) return managed.raw.split('\n').map(line => line.trim()).filter(Boolean);
    if (wanted.startsWith(MANAGED_PREFIX)) {
      const error = new Error('This managed proxy list is no longer available. Ask the Zyn administrator to restore access or choose another proxy list.');
      error.code = 'MANAGED_PROXY_UNAVAILABLE';
      throw error;
    }
    return local.getProxyLines(wanted);
  };

  const emitCatalog = catalog => {
    try { onCatalog(catalog); } catch (error) { logger.warn?.(`[managed-proxy] catalog push: ${error.message}`); }
  };

  const applyLicenseResult = (result = {}) => {
    const currentCount = managedProxyLists.length;
    const nextRevision = cleanRevision(result.proxyRevision);
    const expectedCount = Math.max(0, Number.parseInt(result.proxyListCount, 10) || 0);

    if (result.proxyAccess === true && result.proxyListsChanged === false
        && managedProxyRevision && managedProxyRevision === nextRevision
        && currentCount === expectedCount) {
      return currentCount;
    }

    if (result.proxyAccess === true && result.proxyListsChanged === false) {
      if (currentCount > 0) {
        try { onCredentialsChanged(); } catch (error) { logger.warn?.(`[managed-proxy] stop hook: ${error.message}`); }
      }
      managedProxyRevision = '';
      emitCatalog(setManagedProxyLists([]));
      logger.warn?.('[managed-proxy] revision did not match memory; requesting a full refresh');
      return 0;
    }

    const lists = result.proxyAccess === true && Array.isArray(result.managedProxyLists)
      ? result.managedProxyLists : [];
    const changedWhilePresent = currentCount > 0
      && managedProxyRevision !== null && managedProxyRevision !== nextRevision;
    managedProxyRevision = nextRevision;
    const catalog = setManagedProxyLists(lists);
    emitCatalog(catalog);
    if (changedWhilePresent) {
      logger.warn?.('[managed-proxy] access changed; stopping running tasks before refreshing the catalog');
      try { onCredentialsChanged(); } catch (error) { logger.warn?.(`[managed-proxy] stop hook: ${error.message}`); }
    }
    return managedProxyLists.length;
  };

  const pickProxyLine = ref => {
    const lines = getProxyLines(ref);
    if (!lines.length) return '';
    const position = Math.min(lines.length - 1, Math.max(0, Math.floor(Number(random()) * lines.length)));
    return lines[position];
  };

  Object.assign(dataManager, {
    getProxies: getProxyCatalog,
    getProxyCatalog,
    setManagedProxyLists,
    saveProxyList(name, raw) {
      if (String(name || '').startsWith(MANAGED_PREFIX)) return false;
      local.saveProxyList(name, raw);
      return true;
    },
    deleteProxyList(name) {
      if (String(name || '').startsWith(MANAGED_PREFIX)) return false;
      local.deleteProxyList(name);
      return true;
    },
    getProxyLines,
  });

  return Object.freeze({
    getProxyCatalog,
    getProxyLines,
    pickProxyLine,
    applyLicenseResult,
    revision: () => managedProxyRevision || '',
    managedCount: () => managedProxyLists.length,
  });
}

module.exports = { MANAGED_PREFIX, cleanRevision, normalizeManagedLists, createManagedProxyControl };
