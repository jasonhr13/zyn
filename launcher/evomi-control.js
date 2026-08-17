'use strict';

const {
  EvomiError,
  createEvomiClient,
  normalizeKey,
  validApiKey,
} = require('./evomi-client');

const KEY_SETTING = 'evomiApiKey';
const DEVELOPER_URL = 'https://my.evomi.com';
const MAX_GENERATE_QUANTITY = 100;
const PRODUCT_LABELS = Object.freeze({
  rp: 'Premium Residential',
  rpc: 'Core Residential',
  mp: 'Mobile',
  dcp: 'Datacenter',
  sdc: 'Shared Datacenter',
});
const SKIP_PRODUCTS = new Set(['static_residential', 'static-residential']);
const GENERATE_PRODUCT = Object.freeze({ dcp: 'sdc' });

function emptyStatus(error = '') {
  return {
    connected: false,
    username: '',
    accountId: null,
    keyName: '',
    keyPrefix: '',
    keyLast4: '',
    scopes: [],
    canGenerate: false,
    canReadUsage: false,
    canReadPools: false,
    canBill: false,
    spendCapUsd: null,
    billingReady: false,
    supportsBilling: false,
    providerLabel: 'Evomi',
    developerUrl: DEVELOPER_URL,
    pools: [],
    pendingTopup: null,
    error: String(error || ''),
  };
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function uniqueListName(wanted, existing) {
  const taken = new Set((Array.isArray(existing) ? existing : []).map(name => String(name || '').trim().toLowerCase()));
  const base = String(wanted || '').trim().slice(0, 100) || 'Evomi';
  if (!taken.has(base.toLowerCase())) return base;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base} ${index}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${base} ${Date.now()}`;
}

function defaultListName({ poolLabel, country, state, proxyType }) {
  const parts = ['Evomi', poolLabel, String(country || '').toUpperCase(), state, proxyType]
    .map(part => String(part || '').trim())
    .filter(Boolean);
  return parts.join(' ').slice(0, 100);
}

function countryCodes(raw) {
  const source = asRecord(raw);
  return Object.keys(source).map(code => code.trim().toLowerCase()).filter(code => /^[a-z]{2}$/.test(code));
}

function regionValues(raw) {
  const root = raw && typeof raw === 'object' ? raw : {};
  const data = Object.prototype.hasOwnProperty.call(root, 'data') ? root.data : root;
  if (Array.isArray(data)) {
    return data.flatMap((item) => {
      if (typeof item === 'string') return [item.trim()].filter(Boolean);
      const record = asRecord(item);
      const value = record.name || record.region || record.value || record.code || '';
      return value ? [String(value).trim()] : [];
    });
  }
  if (data && typeof data === 'object') {
    return Object.keys(data).map(name => name.trim()).filter(Boolean);
  }
  return [];
}

function mbToGb(mb) {
  const amount = Number(mb);
  if (!Number.isFinite(amount)) return null;
  return amount / 1024;
}

function proxyLines(raw) {
  return String(raw || '').split(/\r?\n/).flatMap((line) => {
    let value = String(line || '').trim();
    if (!value) return [];
    value = value.replace(/^https?:\/\//i, '');
    const parts = value.split(':');
    if (parts.length < 2) return [];
    return [value];
  });
}

function createEvomiControl({
  dataManager,
  client = createEvomiClient(),
  onStatus = () => {},
  logger = console,
} = {}) {
  if (!dataManager || typeof dataManager !== 'object') throw new Error('evomi dataManager is required');
  if (typeof dataManager.getSettings !== 'function' || typeof dataManager.saveSettings !== 'function') {
    throw new Error('evomi dataManager settings methods are required');
  }

  const originalGetSettings = dataManager.getSettings.bind(dataManager);
  const originalSaveSettings = dataManager.saveSettings.bind(dataManager);
  if (!dataManager.__evomiSettingsWrapped) {
    dataManager.saveSettings = (settings) => {
      const current = asRecord(originalGetSettings());
      const incoming = asRecord(settings);
      originalSaveSettings({
        ...incoming,
        [KEY_SETTING]: current[KEY_SETTING] || '',
      });
    };
    Object.defineProperty(dataManager, '__evomiSettingsWrapped', { value: true, enumerable: false });
  }

  let snapshot = emptyStatus();
  const readSettings = () => asRecord(originalGetSettings());
  const writeSecrets = (patch) => {
    originalSaveSettings({ ...readSettings(), ...patch });
  };
  const storedKey = () => normalizeKey(readSettings()[KEY_SETTING]);

  const emit = (status) => {
    snapshot = status;
    try { onStatus(status); } catch (error) { logger.warn?.(`[evomi] status hook: ${error.message}`); }
    return status;
  };

  const fail = (error) => {
    const message = error && error.message ? error.message : String(error || 'Evomi request failed.');
    if (storedKey()) return emit({ ...snapshot, error: message });
    return emit(emptyStatus(message));
  };

  function localListNames() {
    const catalog = dataManager.getProxies ? dataManager.getProxies() : { lists: [] };
    return (Array.isArray(catalog && catalog.lists) ? catalog.lists : [])
      .map(list => String((list && (list.name || list.label)) || '').trim())
      .filter(Boolean);
  }

  async function buildStatus() {
    const apiKey = storedKey();
    if (!validApiKey(apiKey)) return emptyStatus();
    const account = await client.account(apiKey);
    const products = asRecord(account.products);
    let targeting = {};
    try {
      const listed = await client.settings(apiKey);
      targeting = asRecord(listed.data);
    } catch (error) {
      logger.warn?.(`[evomi] settings: ${error.message}`);
    }
    const pools = Object.entries(products).flatMap(([id, raw]) => {
      if (SKIP_PRODUCTS.has(id)) return [];
      const product = asRecord(raw);
      const host = String(product.endpoint || '').trim();
      const username = String(product.username || '').trim();
      const granted = Boolean(host && username);
      const options = asRecord(targeting[id]);
      return [{
        id,
        label: PRODUCT_LABELS[id] || id,
        host,
        access: granted ? 'granted' : 'claimable',
        status: 'available',
        claimUrl: granted ? '' : DEVELOPER_URL,
        granted,
        comingSoon: false,
        gb: mbToGb(product.balance_mb),
        pricePerGb: 0,
        currency: 'USD',
        proxyTypes: ['rotating', 'sticky'],
        protocols: ['http'],
        geoSupported: true,
        countries: countryCodes(options.countries),
        usStates: regionValues(options.regions),
        sessionMinutes: { min: 1, max: 1440, appliesTo: ['sticky'] },
      }];
    });
    return {
      ...emptyStatus(),
      connected: true,
      username: 'Evomi',
      keyLast4: apiKey.slice(-4),
      canGenerate: pools.some(pool => pool.granted),
      canReadUsage: true,
      canReadPools: true,
      pools,
    };
  }

  async function refresh() {
    try { return emit(await buildStatus()); }
    catch (error) {
      if (error && error.code === 'unauthorized') {
        writeSecrets({ [KEY_SETTING]: '' });
        return emit(emptyStatus(error.message));
      }
      return fail(error);
    }
  }

  async function connect(apiKey) {
    const key = normalizeKey(apiKey);
    if (!validApiKey(key)) throw new EvomiError('Enter an Evomi API key from Settings → API.');
    await client.account(key);
    writeSecrets({ [KEY_SETTING]: key });
    return refresh();
  }

  function disconnect() {
    writeSecrets({ [KEY_SETTING]: '' });
    return emit(emptyStatus());
  }

  function requireKey() {
    const apiKey = storedKey();
    if (!validApiKey(apiKey)) throw new EvomiError('Link an Evomi API key first.');
    return apiKey;
  }

  async function generate(input = {}) {
    const apiKey = requireKey();
    const requested = asRecord(input);
    const poolId = String(requested.pool || '').trim();
    const country = String(requested.country || 'us').trim().toLowerCase() || 'us';
    const state = String(requested.state || '').trim();
    const proxyType = String(requested.proxyType || 'rotating').trim() || 'rotating';
    const quantity = Number.parseInt(requested.quantity, 10);
    if (!poolId) throw new EvomiError('Choose an Evomi product.');
    if (!Number.isFinite(quantity) || quantity < 1 || quantity > MAX_GENERATE_QUANTITY) {
      throw new EvomiError(`Enter a quantity between 1 and ${MAX_GENERATE_QUANTITY}.`);
    }
    const current = snapshot.connected ? snapshot : await refresh();
    const pool = current.pools.find(item => item.id === poolId);
    if (pool && !pool.granted) throw new EvomiError('Unlock this product on Evomi before generating a list.');
    if (pool && pool.gb === 0) throw new EvomiError('This product has no remaining data. Buy bandwidth on Evomi first.');
    const sticky = proxyType === 'sticky';
    const query = {
      product: GENERATE_PRODUCT[poolId] || poolId,
      countries: country.toUpperCase(),
      format: '2',
      prepend_protocol: 'false',
      protocol: 'http',
      amount: String(quantity),
    };
    if (state && country === 'us') query.region = state;
    if (sticky) {
      query.session = 'sticky';
      query.lifetime = String(Math.max(1, Math.min(1440, Number.parseInt(requested.sessionDuration, 10) || 30)));
    }
    const result = await client.generate(apiKey, query);
    const lines = proxyLines(result && result.raw);
    if (!lines.length) throw new EvomiError('Evomi did not return any proxy lines.');
    const name = uniqueListName(
      requested.name || defaultListName({
        poolLabel: pool ? pool.label : poolId,
        country,
        state,
        proxyType,
      }),
      localListNames(),
    );
    if (typeof dataManager.saveProxyList !== 'function') throw new Error('saveProxyList is required');
    dataManager.saveProxyList(name, lines.join('\n'));
    return {
      status: await refresh(),
      listName: name,
      count: lines.length,
      proxies: dataManager.getProxies ? dataManager.getProxies() : { lists: [] },
    };
  }

  return Object.freeze({
    status: () => snapshot,
    refresh,
    connect,
    disconnect,
    generate,
  });
}

function installEvomiIpc({ ipcMain, control, logger = console } = {}) {
  if (!ipcMain || !control) return;
  const wrap = (fn) => async (_event, payload) => {
    try { return { ok: true, ...(await fn(payload)) }; }
    catch (error) {
      logger.warn?.(`[evomi] ${error.message}`);
      return { ok: false, error: error.message || 'Evomi request failed.', code: error.code || '' };
    }
  };
  const handle = (channel, fn) => {
    try { ipcMain.removeHandler(channel); } catch {}
    ipcMain.handle(channel, wrap(fn));
  };
  handle('evomiStatus', async () => ({ status: control.status() }));
  handle('evomiConnect', async (payload = {}) => ({ status: await control.connect(payload.apiKey) }));
  handle('evomiDisconnect', async () => ({ status: control.disconnect() }));
  handle('evomiRefresh', async () => ({ status: await control.refresh() }));
  handle('evomiGenerate', async (payload = {}) => control.generate(payload));
}

module.exports = {
  KEY_SETTING,
  DEVELOPER_URL,
  MAX_GENERATE_QUANTITY,
  createEvomiControl,
  installEvomiIpc,
  uniqueListName,
  emptyStatus,
};
