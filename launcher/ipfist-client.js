'use strict';

const https = require('https');
const { URL } = require('url');

const DEFAULT_API_BASE = 'https://ipfist.com';
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30000;
const KEY_PATTERN = /^ak_[A-Za-z0-9_-]{8,}$/;
const MEAL_TYPES = Object.freeze(['basic', 'premium']);

class IpfistError extends Error {
  constructor(message, { code = '', status = 0 } = {}) {
    super(message);
    this.name = 'IpfistError';
    this.code = code;
    this.status = status;
  }
}

function normalizeKey(value) {
  return String(value || '')
    .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '')
    .replace(/^[\s"']+|[\s"']+$/g, '')
    .replace(/^Bearer\s+/i, '')
    .replace(/\s+/g, '');
}

function validApiKey(value) {
  return KEY_PATTERN.test(normalizeKey(value));
}

function headerValue(headers, name) {
  const wanted = String(name || '').toLowerCase();
  const source = headers && typeof headers === 'object' ? headers : {};
  for (const [key, value] of Object.entries(source)) {
    if (String(key).toLowerCase() === wanted) {
      return Array.isArray(value) ? String(value[0] || '') : String(value || '');
    }
  }
  return '';
}

function looksLikeJson(raw, contentType) {
  if (/json/i.test(String(contentType || ''))) return true;
  const text = String(raw || '').trim();
  return text.startsWith('{') || text.startsWith('[');
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function unwrap(body) {
  const root = asRecord(body);
  if (Object.prototype.hasOwnProperty.call(root, 'body')) return root.body;
  if (Object.prototype.hasOwnProperty.call(root, 'data')) return root.data;
  if (Object.prototype.hasOwnProperty.call(root, 'result')) return root.result;
  return root;
}

function defaultRequest({ method, url, headers, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let target;
    try { target = new URL(url); }
    catch {
      reject(new IpfistError('IPFist URL is invalid.'));
      return;
    }
    if (target.protocol !== 'https:') {
      reject(new IpfistError('IPFist URL must be HTTPS.'));
      return;
    }
    const payload = body == null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const request = https.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || 443,
      path: `${target.pathname}${target.search}`,
      method,
      headers: {
        accept: 'application/json, text/plain',
        ...(payload ? {
          'content-type': 'application/json',
          'content-length': payload.length,
        } : {}),
        ...headers,
      },
    }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on('data', (chunk) => {
        const part = Buffer.from(chunk);
        chunks.push(part);
        bytes += part.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          response.destroy(new IpfistError('IPFist response was unexpectedly large.'));
        }
      });
      response.on('error', reject);
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const contentType = headerValue(response.headers, 'content-type');
        if (looksLikeJson(raw, contentType)) {
          let parsed = {};
          try { parsed = JSON.parse(raw); }
          catch {
            resolve({
              status: response.statusCode || 0,
              headers: response.headers || {},
              body: { success: false, error: 'IPFist returned invalid JSON.' },
            });
            return;
          }
          resolve({
            status: response.statusCode || 0,
            headers: response.headers || {},
            body: parsed && typeof parsed === 'object' ? parsed : {},
          });
          return;
        }
        resolve({
          status: response.statusCode || 0,
          headers: response.headers || {},
          body: { raw },
        });
      });
    });
    request.on('error', (error) => {
      reject(new IpfistError(error && error.message ? error.message : 'Could not reach IPFist.'));
    });
    request.setTimeout(timeoutMs || REQUEST_TIMEOUT_MS, () => {
      request.destroy(new IpfistError('IPFist request timed out.'));
    });
    if (payload) request.write(payload);
    request.end();
  });
}

function errorMessage(body, status) {
  const source = body && typeof body === 'object' ? body : {};
  const nested = source.error && typeof source.error === 'object' ? source.error : {};
  const text = [
    source.msg, source.message, source.error, source.errors,
    nested.message, nested.msg, source.title,
  ].find(value => typeof value === 'string' && value.trim());
  if (text) return text.trim();
  if (status === 401) return 'That API key is invalid or has been revoked.';
  if (status === 403) return 'This key cannot access residential resources. Use a residential IPFist API key.';
  if (status === 429) return 'IPFist rate-limited this request. Try fewer proxies or wait a moment.';
  return 'IPFist request failed.';
}

function errorCode(status) {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 429) return 'rate_limited';
  return 'request_failed';
}

function wrapperFailed(body, status) {
  const source = asRecord(body);
  if (source.success === false || source.succeeded === false || source.ok === false) return true;
  const code = source.code != null ? Number(source.code) : Number(source.statusCode);
  if (!Number.isFinite(code)) return status < 200 || status >= 300;
  if (code === 0 || code === 200 || code === 20000) return false;
  return true;
}

function raiseFromResponse(response) {
  const status = (response && response.status) || 0;
  const body = response && response.body && typeof response.body === 'object' ? response.body : {};
  throw new IpfistError(errorMessage(body, status), { code: errorCode(status), status });
}

function createIpfistClient({
  apiBase = DEFAULT_API_BASE,
  request = defaultRequest,
} = {}) {
  const root = String(apiBase || DEFAULT_API_BASE).replace(/\/$/, '');

  async function call(apiKey, method, pathname, { query = {}, body } = {}) {
    const key = normalizeKey(apiKey);
    if (!validApiKey(key)) throw new IpfistError('Enter an IPFist API key that starts with ak_.');
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(query || {})) {
      if (value == null || value === '') continue;
      params.set(name, String(value));
    }
    const search = params.toString();
    const url = `${root}${pathname}${search ? `?${search}` : ''}`;
    if (/[?&](api[_-]?key|authorization)=/i.test(url)) {
      throw new IpfistError('IPFist API keys must be sent in a header, not the URL.');
    }
    const response = await request({
      method,
      url,
      headers: { authorization: `Bearer ${key}` },
      body,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    const payload = response && response.body && typeof response.body === 'object' ? response.body : {};
    if (!response || response.status < 200 || response.status >= 300 || wrapperFailed(payload, response.status)) {
      raiseFromResponse(response || {});
    }
    return payload;
  }

  return {
    bandwidth(apiKey) { return call(apiKey, 'GET', '/api/ProxyLogic/BandwidthAnalysis'); },
    config(apiKey, mealType) {
      return call(apiKey, 'GET', '/api/ProxyLogic/GetProxyConfig', {
        query: { mealType, pool: '0' },
      });
    },
    plan(apiKey, mealType) {
      return call(apiKey, 'GET', '/api/DynamicPlan/GetPlanByMealType', { query: { mealType } });
    },
    searchLocations(apiKey, input = {}) {
      const requested = asRecord(input);
      return call(apiKey, 'POST', '/api/Location/Search', {
        body: {
          countryCode: String(requested.countryCode || '').trim(),
          stateCode: String(requested.stateCode || '').trim(),
          mealType: String(requested.mealType || 'basic').trim() || 'basic',
          poolName: String(requested.poolName || '').trim(),
        },
      });
    },
    generate(apiKey, query) {
      return call(apiKey, 'GET', '/api/ProxyLogic/Generate', { query });
    },
  };
}

function asGb(value, hint = '') {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return null;
  const label = String(hint || '').toLowerCase();
  if (/byte/.test(label)) return amount / (1024 ** 3);
  if (/(^|[^a-z])mb([^a-z]|$)|_mb$/.test(label)) return amount / 1024;
  return amount;
}

const REMAIN_HINT = /remain|balance|bandwidth|flow|traffic|unused|left|residue|available|surplus|^gb$/i;
const USED_HINT = /used|consume|spent|total/;

function remainingFromRecord(record, mealType) {
  const meal = String(mealType || '').toLowerCase();
  const source = asRecord(record);
  if (source[meal] != null) {
    if (typeof source[meal] === 'object') return remainingFromRecord(source[meal], meal);
    const direct = asGb(source[meal], meal);
    if (direct != null) return direct;
  }
  for (const [key, value] of Object.entries(source)) {
    const lower = key.toLowerCase();
    if (!lower.startsWith(meal)) continue;
    const rest = lower.slice(meal.length);
    if (USED_HINT.test(rest) && !REMAIN_HINT.test(rest)) continue;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = remainingFromRecord(value, meal);
      if (nested != null) return nested;
    }
    if (rest === '' || REMAIN_HINT.test(rest)) {
      const gb = asGb(value, key);
      if (gb != null) return gb;
    }
  }
  for (const [key, value] of Object.entries(source)) {
    if (!REMAIN_HINT.test(key) || (USED_HINT.test(key) && !REMAIN_HINT.test(key))) continue;
    const gb = asGb(value, key);
    if (gb != null) return gb;
  }
  return null;
}

function pickNumber(record, match) {
  for (const [key, value] of Object.entries(asRecord(record))) {
    if (!match(String(key).toLowerCase())) continue;
    const amount = Number(value);
    if (Number.isFinite(amount)) return amount;
  }
  return null;
}

function remainingGb(body, mealType) {
  const payload = unwrap(body);
  if (typeof payload === 'number') return asGb(payload);
  const source = asRecord(payload);
  const meal = String(mealType || '').toLowerCase();
  const total = pickNumber(source, key => key.startsWith(meal) && key.includes('total') && key.includes('band'));
  const used = pickNumber(source, key => key.startsWith(meal) && key.includes('used') && key.includes('band'));
  if (total != null) return Math.max(0, total - (used || 0));
  return remainingFromRecord(source, mealType);
}

function planPrice(body) {
  const source = asRecord(unwrap(body));
  const nested = [source, asRecord(source.plan), asRecord(source.meal), asRecord(source.priceInfo)];
  const keys = ['pricePerGb', 'price_per_gb', 'unitPrice', 'unit_price', 'salePrice', 'price', 'amount'];
  for (const record of nested) {
    for (const key of keys) {
      const amount = Number(record[key]);
      if (Number.isFinite(amount) && amount > 0) return amount;
    }
  }
  return 0;
}

function firstHost(value) {
  if (Array.isArray(value)) return String(value[0] || '').trim();
  return String(value || '').trim();
}

function configHost(body) {
  const source = asRecord(unwrap(body));
  return firstHost(source.usProxyUrl)
    || firstHost(source.euProxyUrl)
    || firstHost(source.asProxyUrl)
    || firstHost(source.directProxyUrl)
    || firstHost(source.mobileProxyUrl)
    || String(source.host || source.server || source.endpoint || source.domain || source.proxyHost || '').trim();
}

function countryCodes(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? asRecord(unwrap(raw)) : {};
  const list = Array.isArray(raw)
    ? raw
    : (source.countries || source.countryList || source.countryCodes || source.items || []);
  if (Array.isArray(list)) {
    return [...new Set(list.flatMap((item) => {
      if (typeof item === 'string') return [item];
      const record = asRecord(item);
      return [record.countryCode || record.iso2 || record.iso || record.code || record.value || ''];
    }).map(code => String(code || '').trim().toLowerCase()).filter(code => /^[a-z]{2}$/.test(code)))];
  }
  if (list && typeof list === 'object') {
    return Object.keys(list).map(code => code.trim().toLowerCase()).filter(code => /^[a-z]{2}$/.test(code));
  }
  return [];
}

function locationValues(raw) {
  const payload = unwrap(raw);
  const record = asRecord(payload);
  const list = Array.isArray(payload)
    ? payload
    : (record.states || record.regions || record.list || record.items || record.data || []);
  if (Array.isArray(list)) {
    return [...new Set(list.flatMap((item) => {
      if (typeof item === 'string') return [item.trim()].filter(Boolean);
      const entry = asRecord(item);
      const value = entry.state || entry.stateCode || entry.stateName || entry.name || entry.code || entry.value || '';
      return value ? [String(value).trim()] : [];
    }))];
  }
  if (payload && typeof payload === 'object') {
    return Object.keys(payload).map(name => name.trim()).filter(Boolean);
  }
  return [];
}

function proxyText(body) {
  if (typeof body === 'string') return body;
  const source = asRecord(body);
  if (typeof source.raw === 'string') return source.raw;
  const payload = unwrap(source);
  if (typeof payload === 'string') return payload;
  if (Array.isArray(payload)) return payload.map(item => String(item || '').trim()).filter(Boolean).join('\n');
  const record = asRecord(payload);
  if (Array.isArray(record.proxies)) return record.proxies.map(item => String(item || '').trim()).filter(Boolean).join('\n');
  if (typeof record.proxy === 'string') return record.proxy;
  if (typeof record.text === 'string') return record.text;
  return '';
}

module.exports = {
  DEFAULT_API_BASE,
  KEY_PATTERN,
  MEAL_TYPES,
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
  unwrap,
};
