'use strict';

const crypto = require('crypto');
const {
  ResiFactoryError,
  createResiFactoryClient,
  normalizeKey,
  validApiKey,
} = require('./resifactory-client');

function electronShell() {
  try { return require('electron').shell; } catch { return null; }
}

const KEY_SETTING = 'resiFactoryApiKey';
const PENDING_SETTING = 'resiFactoryPendingTopup';
const DEVELOPER_URL = 'https://resifactory.net';
const MAX_GENERATE_QUANTITY = 5000;
const MIN_TOPUP_GB = 0.1;
const MAX_TOPUP_GB = 1000;
const SCOPES = Object.freeze({
  generate: 'proxies:generate',
  usage: 'usage:read',
  pools: 'pools:read',
  billing: 'billing:write',
});

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
    developerUrl: DEVELOPER_URL,
    pools: [],
    pendingTopup: null,
    error: String(error || ''),
  };
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function readBalance(entry) {
  if (entry && typeof entry === 'object') {
    return {
      gb: Number(entry.gb) || 0,
      pricePerGb: Number(entry.price_per_gb) || 0,
      currency: String(entry.currency || 'USD').toUpperCase() || 'USD',
    };
  }
  return { gb: Number(entry) || 0, pricePerGb: 0, currency: 'USD' };
}

function balanceMap(source) {
  const root = asRecord(source);
  const balances = asRecord(root.balances);
  const legacy = asRecord(root.balances_gb);
  const ids = new Set([...Object.keys(balances), ...Object.keys(legacy)]);
  const output = {};
  for (const id of ids) output[id] = readBalance(balances[id] != null ? balances[id] : legacy[id]);
  return output;
}

function stringList(value) {
  return (Array.isArray(value) ? value : []).map(item => String(item || '').trim()).filter(Boolean);
}

function publicPool(pool, balance) {
  const item = asRecord(pool);
  const targeting = asRecord(item.targeting);
  const session = asRecord(targeting.session_minutes);
  const id = String(item.id || '').trim();
  const access = String(item.access || 'granted');
  const status = String(item.status || 'available');
  return {
    id,
    label: String(item.label || id || 'Pool'),
    host: String(item.host || ''),
    access,
    status,
    claimUrl: access === 'claimable' ? String(item.claim_url || '') : '',
    granted: access === 'granted',
    comingSoon: status === 'coming_soon',
    gb: balance ? balance.gb : null,
    pricePerGb: balance ? balance.pricePerGb : Number(item.price_per_gb) || 0,
    currency: balance && balance.currency ? balance.currency : String(item.currency || 'USD').toUpperCase(),
    proxyTypes: stringList(item.proxy_types),
    protocols: stringList(item.protocols),
    geoSupported: targeting.geo_supported !== false,
    countries: stringList(targeting.countries).map(code => code.toLowerCase()),
    usStates: stringList(targeting.us_states),
    sessionMinutes: {
      min: Number.isFinite(Number(session.min)) ? Number(session.min) : 1,
      max: Number.isFinite(Number(session.max)) ? Number(session.max) : 1440,
      appliesTo: stringList(session.applies_to),
    },
  };
}

function uniqueListName(wanted, existing) {
  const taken = new Set((Array.isArray(existing) ? existing : []).map(name => String(name || '').trim().toLowerCase()));
  const base = String(wanted || '').trim().slice(0, 100) || 'ResiFactory';
  if (!taken.has(base.toLowerCase())) return base;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base} ${index}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${base} ${Date.now()}`;
}

function defaultListName({ poolLabel, country, state, proxyType }) {
  const parts = ['ResiFactory', poolLabel, String(country || '').toUpperCase(), state, proxyType]
    .map(part => String(part || '').trim())
    .filter(Boolean);
  return parts.join(' ').slice(0, 100);
}

function proxyLinesFromGenerate(result) {
  const payload = asRecord(result);
  if (Array.isArray(payload.proxies)) {
    return payload.proxies.flatMap((entry) => {
      const item = asRecord(entry);
      const host = String(item.host || '').trim();
      const port = String(item.port || '').trim();
      if (!host || !port) return [];
      return [`${host}:${port}:${item.username || ''}:${item.password || ''}`];
    });
  }
  return String(payload.proxies || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

function safeHttpsUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
}

function publicPending(pending) {
  const value = asRecord(pending);
  const id = Number(value.id);
  if (!Number.isFinite(id) || id <= 0) return null;
  return {
    id,
    pool: String(value.pool || ''),
    gb: Number(value.gb) || 0,
    amountUsd: Number(value.amountUsd) || 0,
    status: String(value.status || 'pending'),
  };
}

function createResiFactoryControl({
  dataManager,
  client = createResiFactoryClient(),
  randomId = () => crypto.randomBytes(16).toString('hex'),
  onStatus = () => {},
  logger = console,
} = {}) {
  if (!dataManager || typeof dataManager !== 'object') throw new Error('resifactory dataManager is required');
  if (typeof dataManager.getSettings !== 'function' || typeof dataManager.saveSettings !== 'function') {
    throw new Error('resifactory dataManager settings methods are required');
  }

  const originalGetSettings = dataManager.getSettings.bind(dataManager);
  const originalSaveSettings = dataManager.saveSettings.bind(dataManager);
  if (!dataManager.__resiFactorySettingsWrapped) {
    dataManager.saveSettings = (settings) => {
      const current = asRecord(originalGetSettings());
      const incoming = asRecord(settings);
      originalSaveSettings({
        ...incoming,
        [KEY_SETTING]: current[KEY_SETTING] || '',
        [PENDING_SETTING]: current[PENDING_SETTING] || null,
      });
    };
    Object.defineProperty(dataManager, '__resiFactorySettingsWrapped', { value: true, enumerable: false });
  }

  let snapshot = emptyStatus();

  const readSettings = () => asRecord(originalGetSettings());
  const writeSecrets = (patch) => {
    originalSaveSettings({ ...readSettings(), ...patch });
  };
  const storedKey = () => normalizeKey(readSettings()[KEY_SETTING]);
  const storedPending = () => asRecord(readSettings()[PENDING_SETTING]);

  const emit = (status) => {
    snapshot = status;
    try { onStatus(status); } catch (error) { logger.warn?.(`[resifactory] status hook: ${error.message}`); }
    return status;
  };

  const fail = (error) => {
    const message = error && error.message ? error.message : String(error || 'ResiFactory request failed.');
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
    const me = await client.me(apiKey);
    const account = asRecord(me);
    const key = asRecord(account.key);
    const scopes = stringList(account.scopes);
    const spendCapUsd = key.spend_cap_usd == null ? null : Number(key.spend_cap_usd);
    const canBill = scopes.includes(SCOPES.billing);
    const billingReady = canBill && spendCapUsd != null && Number.isFinite(spendCapUsd) && spendCapUsd > 0;
    const balances = balanceMap(account);
    let pools = [];
    if (scopes.includes(SCOPES.pools)) {
      try {
        const listed = await client.pools(apiKey);
        pools = (Array.isArray(listed.pools) ? listed.pools : []).map(pool => (
          publicPool(pool, balances[String(pool && pool.id || '')])
        ));
      } catch (error) {
        logger.warn?.(`[resifactory] pools: ${error.message}`);
      }
    }
    if (!pools.length) {
      pools = Object.entries(balances).map(([id, balance]) => publicPool({
        id, label: id, access: 'granted', status: 'available',
      }, balance));
    }
    let pending = publicPending(storedPending());
    if (pending && billingReady) {
      try {
        const live = await client.getTopup(apiKey, pending.id);
        pending = publicPending({
          id: live.id,
          pool: live.pool,
          gb: live.gb,
          amountUsd: live.amount_usd,
          status: live.status,
        });
        if (pending && pending.status !== 'pending') writeSecrets({ [PENDING_SETTING]: null });
        if (pending && pending.status === 'paid') {
          const refreshed = balanceMap(await client.me(apiKey));
          pools = pools.map(pool => ({ ...pool, ...(refreshed[pool.id] || {}) }));
          pending = null;
        }
      } catch (error) {
        logger.warn?.(`[resifactory] pending top-up: ${error.message}`);
      }
    }
    return {
      connected: true,
      username: String(account.username || ''),
      accountId: Number.isFinite(Number(account.id)) ? Number(account.id) : null,
      keyName: String(key.name || ''),
      keyPrefix: String(key.prefix || ''),
      keyLast4: String(key.last4 || apiKey.slice(-4)),
      scopes,
      canGenerate: scopes.includes(SCOPES.generate),
      canReadUsage: scopes.includes(SCOPES.usage),
      canReadPools: scopes.includes(SCOPES.pools),
      canBill,
      spendCapUsd: Number.isFinite(spendCapUsd) ? spendCapUsd : null,
      billingReady,
      developerUrl: DEVELOPER_URL,
      pools,
      pendingTopup: pending && pending.status === 'pending' ? pending : null,
      error: '',
    };
  }

  async function refresh() {
    try { return emit(await buildStatus()); }
    catch (error) {
      if (error && error.code === 'unauthorized') {
        writeSecrets({ [KEY_SETTING]: '', [PENDING_SETTING]: null });
        return emit(emptyStatus(error.message));
      }
      return fail(error);
    }
  }

  async function connect(apiKey) {
    const key = normalizeKey(apiKey);
    if (!validApiKey(key)) throw new ResiFactoryError('Enter a ResiFactory API key that starts with rf_live_.');
    await client.me(key);
    writeSecrets({ [KEY_SETTING]: key });
    return refresh();
  }

  function disconnect() {
    writeSecrets({ [KEY_SETTING]: '', [PENDING_SETTING]: null });
    return emit(emptyStatus());
  }

  function requireKey() {
    const apiKey = storedKey();
    if (!validApiKey(apiKey)) throw new ResiFactoryError('Link a ResiFactory API key first.');
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
    if (!poolId) throw new ResiFactoryError('Choose a ResiFactory pool.');
    if (!Number.isFinite(quantity) || quantity < 1 || quantity > MAX_GENERATE_QUANTITY) {
      throw new ResiFactoryError(`Enter a quantity between 1 and ${MAX_GENERATE_QUANTITY}.`);
    }
    const current = snapshot.connected ? snapshot : await refresh();
    const pool = current.pools.find(item => item.id === poolId);
    if (pool && !pool.granted) {
      throw new ResiFactoryError('Unlock this pool on ResiFactory before generating a list.');
    }
    if (pool && pool.comingSoon) {
      throw new ResiFactoryError('That pool is not live yet. ResiFactory would return demo credentials.');
    }
    if (pool && pool.gb === 0) {
      throw new ResiFactoryError('This pool has no remaining GB. Add data before generating a list.');
    }
    const sticky = proxyType === 'sticky' || proxyType === 'mobile_sticky';
    const sessionDuration = sticky
      ? Math.max(1, Math.min(1440, Number.parseInt(requested.sessionDuration, 10) || 30))
      : undefined;
    const body = {
      pool: poolId,
      country,
      quantity,
      proxyType,
      format: 'json',
      protocol: 'http',
    };
    if (state && country === 'us') body.state = state;
    if (sessionDuration) body.sessionDuration = sessionDuration;
    const result = await client.generate(apiKey, body, `zyn_gen_${randomId()}`);
    if (result && result.is_demo) {
      throw new ResiFactoryError('ResiFactory returned demo credentials (empty balance or a pool that is not live). Nothing was saved.');
    }
    const lines = proxyLinesFromGenerate(result);
    if (!lines.length) throw new ResiFactoryError('ResiFactory did not return any proxy lines.');
    const name = uniqueListName(
      requested.name || defaultListName({
        poolLabel: pool ? pool.label : poolId,
        country: result.country || country,
        state: result.state || state,
        proxyType: result.proxy_type || proxyType,
      }),
      localListNames(),
    );
    if (typeof dataManager.saveProxyList !== 'function') throw new Error('saveProxyList is required');
    dataManager.saveProxyList(name, lines.join('\n'));
    const status = await refresh();
    return {
      status,
      listName: name,
      count: lines.length,
      proxies: dataManager.getProxies ? dataManager.getProxies() : { lists: [] },
    };
  }

  async function startTopup(input = {}, opener = electronShell()) {
    const apiKey = requireKey();
    const requested = asRecord(input);
    const pool = String(requested.pool || '').trim();
    const gb = Number(requested.gb);
    if (!pool) throw new ResiFactoryError('Choose a pool to add data to.');
    if (!Number.isFinite(gb) || gb < MIN_TOPUP_GB || gb > MAX_TOPUP_GB) {
      throw new ResiFactoryError(`Enter an amount between ${MIN_TOPUP_GB} and ${MAX_TOPUP_GB} GB.`);
    }
    const current = snapshot.connected ? snapshot : await refresh();
    if (!current.billingReady) {
      throw new ResiFactoryError('Add Data needs a ResiFactory key created with Billing enabled and a monthly spend cap.');
    }
    const existing = publicPending(storedPending());
    const idempotencyKey = existing && existing.pool === pool && existing.gb === gb
      ? String(storedPending().idempotencyKey || `zyn_topup_${randomId()}`)
      : `zyn_topup_${randomId()}`;
    const result = await client.startTopup(apiKey, { pool, gb, payment_method: 'checkout' }, idempotencyKey);
    const checkoutUrl = safeHttpsUrl(result.checkout_url);
    writeSecrets({
      [PENDING_SETTING]: {
        id: result.id,
        pool: result.pool || pool,
        gb: result.gb || gb,
        amountUsd: result.amount_usd || 0,
        status: result.status || 'pending',
        idempotencyKey,
      },
    });
    if (checkoutUrl && opener && typeof opener.openExternal === 'function') {
      await opener.openExternal(checkoutUrl);
    }
    const status = await refresh();
    return {
      status,
      topup: {
        id: result.id,
        pool: result.pool || pool,
        gb: result.gb || gb,
        amountUsd: result.amount_usd || 0,
        checkoutUrl,
      },
    };
  }

  async function pollTopup() {
    const apiKey = requireKey();
    const pending = publicPending(storedPending());
    if (!pending) return { status: await refresh(), topup: null };
    const live = await client.getTopup(apiKey, pending.id);
    const next = publicPending({
      id: live.id,
      pool: live.pool,
      gb: live.gb,
      amountUsd: live.amount_usd,
      status: live.status,
    });
    if (!next || next.status !== 'pending') writeSecrets({ [PENDING_SETTING]: null });
    return { status: await refresh(), topup: next };
  }

  return Object.freeze({
    status: () => snapshot,
    refresh,
    connect,
    disconnect,
    generate,
    startTopup,
    pollTopup,
  });
}

function installResiFactoryIpc({ ipcMain, control, shell = electronShell(), logger = console } = {}) {
  if (!ipcMain || !control) return;
  const wrap = (fn) => async (_event, payload) => {
    try { return { ok: true, ...(await fn(payload)) }; }
    catch (error) {
      logger.warn?.(`[resifactory] ${error.message}`);
      return { ok: false, error: error.message || 'ResiFactory request failed.', code: error.code || '' };
    }
  };
  const handle = (channel, fn) => {
    try { ipcMain.removeHandler(channel); } catch {}
    ipcMain.handle(channel, wrap(fn));
  };
  handle('resiFactoryStatus', async () => ({ status: control.status() }));
  handle('resiFactoryConnect', async (payload = {}) => ({ status: await control.connect(payload.apiKey) }));
  handle('resiFactoryDisconnect', async () => ({ status: control.disconnect() }));
  handle('resiFactoryRefresh', async () => ({ status: await control.refresh() }));
  handle('resiFactoryGenerate', async (payload = {}) => control.generate(payload));
  handle('resiFactoryStartTopup', async (payload = {}) => control.startTopup(payload, shell));
  handle('resiFactoryPollTopup', async () => control.pollTopup());
}

module.exports = {
  KEY_SETTING,
  PENDING_SETTING,
  DEVELOPER_URL,
  MAX_GENERATE_QUANTITY,
  createResiFactoryControl,
  installResiFactoryIpc,
  uniqueListName,
  defaultListName,
  publicPool,
  emptyStatus,
};
