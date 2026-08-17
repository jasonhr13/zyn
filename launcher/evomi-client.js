'use strict';

const https = require('https');
const { URL } = require('url');

const DEFAULT_API_BASE = 'https://api.evomi.com';
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30000;
const KEY_PATTERN = /^[A-Za-z0-9._~+/=-]{16,256}$/;

class EvomiError extends Error {
  constructor(message, { code = '', status = 0 } = {}) {
    super(message);
    this.name = 'EvomiError';
    this.code = code;
    this.status = status;
  }
}

function normalizeKey(value) {
  return String(value || '')
    .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '')
    .replace(/^[\s"']+|[\s"']+$/g, '')
    .replace(/\s+/g, '');
}

function validApiKey(value) {
  const key = normalizeKey(value);
  if (!KEY_PATTERN.test(key)) return false;
  if (key.includes('://') || (key.match(/:/g) || []).length >= 2) return false;
  return true;
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

function defaultRequest({ method, url, headers, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let target;
    try { target = new URL(url); }
    catch {
      reject(new EvomiError('Evomi URL is invalid.'));
      return;
    }
    if (target.protocol !== 'https:') {
      reject(new EvomiError('Evomi URL must be HTTPS.'));
      return;
    }
    const request = https.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || 443,
      path: `${target.pathname}${target.search}`,
      method,
      headers: {
        accept: 'application/json, text/plain',
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
          response.destroy(new EvomiError('Evomi response was unexpectedly large.'));
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
              body: { success: false, error: 'Evomi returned invalid JSON.' },
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
      reject(new EvomiError(error && error.message ? error.message : 'Could not reach Evomi.'));
    });
    request.setTimeout(timeoutMs || REQUEST_TIMEOUT_MS, () => {
      request.destroy(new EvomiError('Evomi request timed out.'));
    });
    request.end();
  });
}

function errorMessage(body, status) {
  const source = body && typeof body === 'object' ? body : {};
  if (typeof source.error === 'string' && source.error.trim()) return source.error.trim();
  if (source.error && typeof source.error === 'object' && source.error.message) {
    return String(source.error.message);
  }
  if (status === 401) return 'That API key is invalid or has been revoked.';
  if (status === 429) return 'Evomi rate-limited this request. Try fewer proxies or wait a moment.';
  return 'Evomi request failed.';
}

function raiseFromResponse(response) {
  const status = (response && response.status) || 0;
  const body = response && response.body && typeof response.body === 'object' ? response.body : {};
  const code = status === 401 ? 'unauthorized' : (status === 429 ? 'rate_limited' : 'request_failed');
  throw new EvomiError(errorMessage(body, status), { code, status });
}

function createEvomiClient({
  apiBase = DEFAULT_API_BASE,
  request = defaultRequest,
} = {}) {
  const root = String(apiBase || DEFAULT_API_BASE).replace(/\/$/, '');

  async function call(apiKey, pathname, query = {}) {
    const key = normalizeKey(apiKey);
    if (!validApiKey(key)) throw new EvomiError('Enter an Evomi API key from Settings → API.');
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(query || {})) {
      if (value == null || value === '') continue;
      params.set(name, String(value));
    }
    const search = params.toString();
    const url = `${root}${pathname}${search ? `?${search}` : ''}`;
    if (/[?&]apikey=/i.test(url)) throw new EvomiError('Evomi API keys must be sent in a header, not the URL.');
    const response = await request({
      method: 'GET',
      url,
      headers: { 'x-apikey': key },
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    const body = response && response.body && typeof response.body === 'object' ? response.body : {};
    if (!response || response.status < 200 || response.status >= 300 || body.success === false) {
      raiseFromResponse(response || {});
    }
    return body;
  }

  return {
    account(apiKey) { return call(apiKey, '/public'); },
    settings(apiKey) { return call(apiKey, '/public/settings'); },
    generate(apiKey, query) { return call(apiKey, '/public/generate', query); },
  };
}

module.exports = {
  DEFAULT_API_BASE,
  EvomiError,
  createEvomiClient,
  normalizeKey,
  validApiKey,
};
