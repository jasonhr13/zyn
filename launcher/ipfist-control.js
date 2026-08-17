'use strict';

const {
  IpfistError,
  createIpfistClient,
  normalizeKey,
  validApiKey,
  remainingGb,
  planPrice,
  configHost,
  countryCodes,
  locationValues,
  proxyText,
} = require('./ipfist-client');

const KEY_SETTING = 'ipfistApiKey';
const DEVELOPER_URL = 'https://www.ipfist.com';
const MAX_GENERATE_QUANTITY = 100;
const FALLBACK_COUNTRIES = Object.freeze(['us', 'ca', 'gb', 'de', 'fr', 'it', 'es', 'nl', 'jp', 'au', 'br', 'mx', 'in']);
const PRODUCT_LABELS = Object.freeze({
  basic: 'Basic Residential',
  premium: 'Premium Residential',
});

function emptyStatus(error = '') {
  return {
    connected: false,
    username: '',
    accountId: null,
    keyName: '',
    keyPrefix: '',
    keyLast4: '',
    scopes: ['residential'],
    canGenerate: false,
    canReadUsage: false,
    canReadPools: false,
    canBill: false,
    spendCapUsd: null,
    billingReady: false,
    supportsBilling: false,
    providerLabel: 'IPFist',
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
  const base = String(wanted || '').trim().slice(0, 100) || 'IPFist';
  if (!taken.has(base.toLowerCase())) return base;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base} ${index}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${base} ${Date.now()}`;
}

function defaultListName({ poolLabel, country, state, proxyType }) {
  const parts = ['IPFist', poolLabel, String(country || '').toUpperCase(), state, proxyType]
    .map(part => String(part || '').trim())
    .filter(Boolean);
  return parts.join(' ').slice(0, 100);
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

async function settledValue(work, fallback, logger, label) {
  try {
    return await work();
  } catch (error) {
    logger.warn?.(`[ipfist] ${label}: ${error.message}`);
    return fallback;
  }
}

function createIpfistControl({
  dataManager,
  client = createIpfistClient(),
  onStatus = () => {},
  logger = console,
} = {}) {
  if (!dataManager || typeof dataManager !== 'object') throw new Error('ipfist dataManager is required');
  if (typeof dataManager.getSettings !== 'function' || typeof dataManager.saveSettings !== 'function') {
    throw new Error('ipfist dataManager settings methods are required');
  }

  const originalGetSettings = dataManager.getSettings.bind(dataManager);
  const originalSaveSettings = dataManager.saveSettings.bind(dataManager);
  if (!dataManager.__ipfistSettingsWrapped) {
    dataManager.saveSettings = (settings) => {
      const current = asRecord(originalGetSettings());
      const incoming = asRecord(settings);
      originalSaveSettings({
        ...incoming,
        [KEY_SETTING]: current[KEY_SETTING] || '',
      });
    };
    Object.defineProperty(dataManager, '__ipfistSettingsWrapped', { value: true, enumerable: false });
  }

  let snapshot = emptyStatus();
  const readSettings = () => asRecord(originalGetSettings());
  const writeSecrets = (patch) => {
    originalSaveSettings({ ...readSettings(), ...patch });
  };
  const storedKey = () => normalizeKey(readSettings()[KEY_SETTING]);

  const emit = (status) => {
    snapshot = status;
    try { onStatus(status); } catch (error) { logger.warn?.(`[ipfist] status hook: ${error.message}`); }
    return status;
  };

  const fail = (error) => {
    const message = error && error.message ? error.message : String(error || 'IPFist request failed.');
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
    const bandwidth = await client.bandwidth(apiKey);
    const [basicConfig, premiumConfig, locations] = await Promise.all([
      settledValue(() => client.config(apiKey, 'basic'), {}, logger, 'basic config'),
      settledValue(() => client.config(apiKey, 'premium'), {}, logger, 'premium config'),
      settledValue(() => client.searchLocations(apiKey, { countryCode: 'US', mealType: 'basic' }), {}, logger, 'locations'),
    ]);
    const configs = { basic: basicConfig, premium: premiumConfig };
    const usStates = locationValues(locations);
    const pools = ['basic', 'premium'].map((id) => {
      const countries = countryCodes(configs[id]);
      return {
        id,
        label: PRODUCT_LABELS[id],
        host: configHost(configs[id]),
        access: 'granted',
        status: 'available',
        claimUrl: '',
        granted: true,
        comingSoon: false,
        gb: remainingGb(bandwidth, id),
        pricePerGb: planPrice(configs[id]),
        currency: 'USD',
        proxyTypes: ['rotating', 'sticky'],
        protocols: ['http'],
        geoSupported: true,
        countries: countries.length ? countries : [...FALLBACK_COUNTRIES],
        usStates,
        sessionMinutes: { min: 1, max: 1440, appliesTo: ['sticky'] },
      };
    });
    return {
      ...emptyStatus(),
      connected: true,
      username: 'IPFist',
      keyLast4: apiKey.slice(-4),
      canGenerate: true,
      canReadUsage: true,
      canReadPools: true,
      pools,
    };
  }

  async function refresh() {
    try { return emit(await buildStatus()); }
    catch (error) {
      if (error && (error.code === 'unauthorized' || error.code === 'forbidden')) {
        writeSecrets({ [KEY_SETTING]: '' });
        return emit(emptyStatus(error.message));
      }
      return fail(error);
    }
  }

  async function connect(apiKey) {
    const key = normalizeKey(apiKey);
    if (!validApiKey(key)) throw new IpfistError('Enter an IPFist API key that starts with ak_.');
    await client.bandwidth(key);
    writeSecrets({ [KEY_SETTING]: key });
    return refresh();
  }

  function disconnect() {
    writeSecrets({ [KEY_SETTING]: '' });
    return emit(emptyStatus());
  }

  function requireKey() {
    const apiKey = storedKey();
    if (!validApiKey(apiKey)) throw new IpfistError('Link an IPFist API key first.');
    return apiKey;
  }

  async function generate(input = {}) {
    const apiKey = requireKey();
    const requested = asRecord(input);
    const poolId = String(requested.pool || '').trim().toLowerCase();
    const country = String(requested.country || 'us').trim().toLowerCase() || 'us';
    const state = String(requested.state || '').trim();
    const proxyType = String(requested.proxyType || 'rotating').trim() || 'rotating';
    const quantity = Number.parseInt(requested.quantity, 10);
    if (poolId !== 'basic' && poolId !== 'premium') {
      throw new IpfistError('Choose Basic or Premium residential.');
    }
    if (!Number.isFinite(quantity) || quantity < 1 || quantity > MAX_GENERATE_QUANTITY) {
      throw new IpfistError(`Enter a quantity between 1 and ${MAX_GENERATE_QUANTITY}.`);
    }
    const current = snapshot.connected ? snapshot : await refresh();
    const pool = current.pools.find(item => item.id === poolId);
    if (pool && pool.gb === 0) throw new IpfistError('This plan has no remaining data. Buy bandwidth on IPFist first.');
    const sticky = proxyType === 'sticky';
    const query = {
      mealType: poolId,
      num: String(quantity),
      country: country.toUpperCase(),
      format: '0',
      lifeTime: sticky
        ? String(Math.max(1, Math.min(1440, Number.parseInt(requested.sessionDuration, 10) || 30)))
        : '0',
    };
    if (state) query.state = state;
    const result = await client.generate(apiKey, query);
    const lines = proxyLines(proxyText(result));
    if (!lines.length) throw new IpfistError('IPFist did not return any proxy lines.');
    const name = uniqueListName(
      requested.name || defaultListName({
        poolLabel: pool ? pool.label.replace(/ Residential$/i, '') : poolId,
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

function installIpfistIpc({ ipcMain, control, logger = console } = {}) {
  if (!ipcMain || !control) return;
  const wrap = (fn) => async (_event, payload) => {
    try { return { ok: true, ...(await fn(payload)) }; }
    catch (error) {
      logger.warn?.(`[ipfist] ${error.message}`);
      return { ok: false, error: error.message || 'IPFist request failed.', code: error.code || '' };
    }
  };
  const handle = (channel, fn) => {
    try { ipcMain.removeHandler(channel); } catch {}
    ipcMain.handle(channel, wrap(fn));
  };
  handle('ipfistStatus', async () => ({ status: control.status() }));
  handle('ipfistConnect', async (payload = {}) => ({ status: await control.connect(payload.apiKey) }));
  handle('ipfistDisconnect', async () => ({ status: control.disconnect() }));
  handle('ipfistRefresh', async () => ({ status: await control.refresh() }));
  handle('ipfistGenerate', async (payload = {}) => control.generate(payload));
}

module.exports = {
  KEY_SETTING,
  DEVELOPER_URL,
  MAX_GENERATE_QUANTITY,
  createIpfistControl,
  installIpfistIpc,
  uniqueListName,
  emptyStatus,
};
