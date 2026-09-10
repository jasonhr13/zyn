'use strict';

const fs = require('fs');
const path = require('path');
const { createTaskGroupStore } = require('../../launcher/task-group-store');

const FILES = Object.freeze({
  taskGroups: 'task-groups.json',
  targetTasks: 'target-tasks.json',
  pokemonCenterTasks: 'pokemon-center-tasks.json',
  walmartTasks: 'walmart-tasks.json',
  profiles: 'profiles.json',
  accounts: 'accounts.json',
  proxies: 'proxies.json',
  settings: 'settings.json',
  watchlist: 'watchlist.json',
  lastOrders: 'last-orders.json',
  lastCarted: 'last-carted.json',
  targetOrderLog: 'target-order-log.json',
  licenseSession: 'license-session.json',
  sessionKind: 'session-kind.json',
  deviceId: 'device-id.json',
});

function cloneDefault(value) {
  if (Array.isArray(value)) return value.slice();
  if (value && typeof value === 'object') return { ...value };
  return value;
}

function atomicWrite(filePath, value) {
  const directory = path.dirname(filePath);
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, 0o600);
}

function createDataStore(dataDirectory) {
  if (!dataDirectory) throw new Error('ZYN_DATA_DIR is required');
  fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const cache = new Map();
  const groups = createTaskGroupStore(dataDirectory);

  const filePath = name => path.join(dataDirectory, name);

  const readJSON = (name, fallback) => {
    if (cache.has(name)) return cache.get(name);
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath(name), 'utf8'));
      cache.set(name, parsed);
      return parsed;
    } catch {
      const empty = cloneDefault(fallback);
      cache.set(name, empty);
      return empty;
    }
  };

  const writeJSON = (name, value) => {
    cache.set(name, value);
    atomicWrite(filePath(name), value);
    return value;
  };

  return {
    directory: dataDirectory,
    files: FILES,
    readJSON,
    writeJSON,
    taskGroups: groups,
    getProfiles: () => readJSON(FILES.profiles, []),
    saveProfiles: profiles => writeJSON(FILES.profiles, Array.isArray(profiles) ? profiles : []),
    getAccountsRaw: () => readJSON(FILES.accounts, []),
    saveAccounts: accounts => writeJSON(FILES.accounts, Array.isArray(accounts) ? accounts : []),
    getProxies: () => {
      const data = readJSON(FILES.proxies, { lists: [] });
      return data && Array.isArray(data.lists) ? data : { lists: [] };
    },
    saveProxies: data => writeJSON(FILES.proxies, data && Array.isArray(data.lists) ? data : { lists: [] }),
    getProxyLines(listName) {
      const want = String(listName || '').trim().toLowerCase();
      const list = this.getProxies().lists.find(item => item && String(item.name || '').trim().toLowerCase() === want);
      return list ? String(list.raw || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean) : [];
    },
    getSettings: () => readJSON(FILES.settings, {}),
    saveSettings: settings => writeJSON(FILES.settings, settings && typeof settings === 'object' ? settings : {}),
    getPokemonCenterTasks: () => readJSON(FILES.pokemonCenterTasks, {
      products: [{ id: 'pc_product_1', input: '', quantity: '1' }],
      tasks: [],
      monitorDelay: '3000',
      retryDelay: '3000',
      loopCheckout: false,
      waitForQueue: false,
      queueEntryDelay: '0',
      allInstock: false,
    }),
    savePokemonCenterTasks: data => writeJSON(FILES.pokemonCenterTasks, data && typeof data === 'object' ? data : {}),
    getWalmartTasks: () => readJSON(FILES.walmartTasks, { products: [], tasks: [] }),
    saveWalmartTasks: data => writeJSON(FILES.walmartTasks, data && typeof data === 'object' ? data : {}),
    getTargetOrderLog: () => readJSON(FILES.targetOrderLog, {}),
    recordTargetOrder(accountId, sku) {
      const log = this.getTargetOrderLog();
      const key = `${accountId}:${sku}`;
      const times = Array.isArray(log[key]) ? log[key].slice() : [];
      times.push(Date.now());
      log[key] = times;
      writeJSON(FILES.targetOrderLog, log);
    },
  };
}

module.exports = { FILES, createDataStore };
